import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  channelAvailableModels,
  channelEndpoints,
  channels,
  models,
  userModelGrants,
} from '../db/schema/index.js';
import { type AuthService, digestToken, type Principal, type Transaction } from './auth.js';
import { pageSize } from './users.js';

import { randomBytes } from 'node:crypto';

export class KeyService {
  static readonly token = serviceToken<KeyService>('ohmyapi/keys');
  private readonly auth: AuthService;
  constructor(auth: AuthService) {
    this.auth = auth;
  }

  async availableModels(principal: Principal) {
    if (principal.user.role === 'admin')
      return this.auth.db
        .select({ id: models.id, name: models.name })
        .from(models)
        .where(eq(models.enabled, true))
        .orderBy(models.name);
    return this.auth.db
      .select({ id: models.id, name: models.name })
      .from(models)
      .innerJoin(userModelGrants, eq(models.id, userModelGrants.modelId))
      .where(and(eq(userModelGrants.userId, principal.user.id), eq(models.enabled, true)))
      .orderBy(models.name);
  }

  private async offerings(db: Database | Transaction, userId: string, role: string) {
    const allowed = role === 'admin' ? undefined : eq(userModelGrants.userId, userId);
    const base = db
      .selectDistinct({
        channelId: channels.id,
        channelName: channels.name,
        multiplierMicros: channels.multiplierMicros,
        modelId: models.id,
        modelName: models.name,
      })
      .from(channels)
      .innerJoin(channelAvailableModels, eq(channels.id, channelAvailableModels.channelId))
      .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
      .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
      .leftJoin(userModelGrants, and(eq(userModelGrants.modelId, models.id), eq(userModelGrants.userId, userId)))
      .where(and(eq(channels.enabled, true), eq(models.enabled, true), allowed))
      .orderBy(channels.name, models.name);
    return base;
  }
  async availableChannels(principal: Principal) {
    const rows = await this.offerings(this.auth.db, principal.user.id, principal.user.role);
    return [...new Set(rows.map((r) => r.channelId))].map((id) => ({
      id,
      name: rows.find((r) => r.channelId === id)?.channelName as string,
      models: rows.filter((r) => r.channelId === id).map((r) => ({ id: r.modelId, name: r.modelName })),
    }));
  }
  async bindChannel(principal: Principal, keyId: string, channelId: string) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const [key] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id)))
        .for('update');
      if (!key) throw new TRPCError({ code: 'NOT_FOUND', message: 'Key 不存在' });
      if (key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Key 已失效' });
      const [existing] = await tx.select().from(apiKeyChannels).where(eq(apiKeyChannels.apiKeyId, keyId));
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Key 已绑定渠道，请创建新的 Key' });
      const offerings = await this.offerings(tx, user.id, user.role);
      if (!offerings.some((o) => o.channelId === channelId))
        throw new TRPCError({ code: 'FORBIDDEN', message: '渠道不可用或没有授权模型' });
      await tx.insert(apiKeyChannels).values({ apiKeyId: keyId, channelId });
      return { success: true };
    });
  }
  async list(userId: string, page: number) {
    const rows = await this.auth.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.keyPrefix,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
        restrictModels: apiKeys.restrictModels,
        channelId: apiKeyChannels.channelId,
        channelName: channels.name,
      })
      .from(apiKeys)
      .leftJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
      .leftJoin(channels, eq(channels.id, apiKeyChannels.channelId))
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(pageSize + 1)
      .offset(page * pageSize);
    const items = rows.slice(0, pageSize);
    const grants = items.length
      ? await this.auth.db
          .select({ keyId: apiKeyModelGrants.apiKeyId, name: models.name })
          .from(apiKeyModelGrants)
          .innerJoin(models, eq(models.id, apiKeyModelGrants.modelId))
          .where(
            inArray(
              apiKeyModelGrants.apiKeyId,
              items.map((key) => key.id),
            ),
          )
      : [];
    return {
      items: items.map((key) => ({
        ...key,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        revokedAt: key.revokedAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
        modelNames: grants.filter((grant) => grant.keyId === key.id).map((grant) => grant.name),
      })),
      hasMore: rows.length > pageSize,
    };
  }

  async create(
    principal: Principal,
    input: { channelId: string; name: string; expiresAt?: string; modelIds?: string[] },
  ) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
      if (expiresAt && expiresAt.getTime() <= Date.now())
        throw new TRPCError({ code: 'BAD_REQUEST', message: '有效期必须晚于当前时间' });
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.userId, user.id),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        );
      if (count >= 100) throw new TRPCError({ code: 'BAD_REQUEST', message: '最多保留 100 个有效 Key' });
      const modelIds = [...new Set(input.modelIds ?? [])];
      const offerings = (await this.offerings(tx, user.id, user.role)).filter((o) => o.channelId === input.channelId);
      if (!offerings.length) throw new TRPCError({ code: 'FORBIDDEN', message: '渠道不可用或没有授权模型' });
      if (modelIds.some((id) => !offerings.some((o) => o.modelId === id)))
        throw new TRPCError({ code: 'FORBIDDEN', message: '包含渠道不可用或未授权的模型' });
      const token = `oma_${randomBytes(32).toString('base64url')}`;
      const [key] = await tx
        .insert(apiKeys)
        .values({
          userId: user.id,
          name: input.name,
          keyHash: digestToken(token),
          keyPrefix: `${token.slice(0, 12)}…`,
          expiresAt,
          restrictModels: input.modelIds !== undefined,
        })
        .returning({ id: apiKeys.id });
      await tx.insert(apiKeyChannels).values({ apiKeyId: key.id, channelId: input.channelId });
      if (modelIds.length)
        await tx.insert(apiKeyModelGrants).values(modelIds.map((modelId) => ({ apiKeyId: key.id, modelId })));
      return { id: key.id, token };
    });
  }

  async revoke(principal: Principal, keyId: string) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const [key] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id)))
        .returning({ id: apiKeys.id });
      if (!key) throw new TRPCError({ code: 'NOT_FOUND', message: 'Key 不存在' });
      return { success: true };
    });
  }
}
