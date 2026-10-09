import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import type { AuthService, Principal, Transaction } from '../auth/service.js';
import { supportedChannelTypes } from '../catalog/channel-types.js';
import type { Database } from '../database/client.js';
import {
  adminAuditLogs,
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  channelAvailableModels,
  channelEndpoints,
  channels,
  models,
  priceRules,
  userChannelGrants,
} from '../database/schema/index.js';
import { pageSize } from '../users/service.js';

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
        .where(and(eq(models.enabled, true), isNull(models.deletedAt)))
        .orderBy(models.name);
    const offerings = await this.offerings(this.auth.db, principal.user.id, principal.user.role);
    return [...new Map(offerings.map((row) => [row.modelId, { id: row.modelId, name: row.modelName }])).values()].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
  }

  async offerings(db: Database | Transaction, userId: string, role: string) {
    const allowed =
      role === 'admin' ? undefined : or(eq(channels.isPublic, true), eq(userChannelGrants.userId, userId));
    const base = db
      .selectDistinct({
        channelId: channels.id,
        channelName: channels.name,
        multiplierMicros:
          sql<bigint>`coalesce(${channelAvailableModels.multiplierMicros}, ${channels.multiplierMicros})`.mapWith(
            BigInt,
          ),
        endpoint: channelEndpoints.endpoint,
        inputTokenLimit: models.inputTokenLimit,
        outputTokenLimit: models.outputTokenLimit,
        modelId: models.id,
        modelName: models.name,
      })
      .from(channels)
      .innerJoin(channelAvailableModels, eq(channels.id, channelAvailableModels.channelId))
      .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
      .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
      .leftJoin(
        userChannelGrants,
        and(eq(userChannelGrants.channelId, channels.id), eq(userChannelGrants.userId, userId)),
      )
      .where(
        and(
          eq(channels.enabled, true),
          inArray(channels.type, [...supportedChannelTypes]),
          eq(models.enabled, true),
          isNull(channels.deletedAt),
          isNull(models.deletedAt),
          allowed,
        ),
      )
      .orderBy(channels.name, models.name);
    return base;
  }

  async availableChannels(principal: Principal) {
    const rows = await this.offerings(this.auth.db, principal.user.id, principal.user.role);
    return [...new Set(rows.map((r) => r.channelId))].map((id) => ({
      id,
      name: rows.find((r) => r.channelId === id)?.channelName as string,
      models: [
        ...new Map(
          rows.filter((r) => r.channelId === id).map((r) => [r.modelId, { id: r.modelId, name: r.modelName }]),
        ).values(),
      ],
    }));
  }

  async playgroundOptions(principal: Principal) {
    const rows = await this.auth.db
      .selectDistinct({
        keyId: apiKeys.id,
        keyName: apiKeys.name,
        token: apiKeys.key,
        expiresAt: apiKeys.expiresAt,
        channelName: channels.name,
        endpoint: channelEndpoints.endpoint,
        modelId: models.id,
        modelName: models.name,
        outputTokenLimit: models.outputTokenLimit,
      })
      .from(apiKeys)
      .innerJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
      .innerJoin(channels, eq(channels.id, apiKeyChannels.channelId))
      .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
      .innerJoin(channelAvailableModels, eq(channelAvailableModels.channelId, channels.id))
      .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
      .innerJoin(priceRules, and(eq(priceRules.modelId, models.id), eq(priceRules.kind, 'default')))
      .leftJoin(
        apiKeyModelGrants,
        and(eq(apiKeyModelGrants.apiKeyId, apiKeys.id), eq(apiKeyModelGrants.modelId, models.id)),
      )
      .leftJoin(
        userChannelGrants,
        and(eq(userChannelGrants.userId, principal.user.id), eq(userChannelGrants.channelId, channels.id)),
      )
      .where(
        and(
          eq(apiKeys.userId, principal.user.id),
          isNull(apiKeys.deletedAt),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          eq(channels.enabled, true),
          inArray(channels.type, [...supportedChannelTypes]),
          isNull(channels.deletedAt),
          eq(models.enabled, true),
          isNull(models.deletedAt),
          or(eq(apiKeys.restrictModels, false), eq(apiKeyModelGrants.apiKeyId, apiKeys.id)),
          principal.user.role === 'admin'
            ? undefined
            : or(eq(channels.isPublic, true), eq(userChannelGrants.userId, principal.user.id)),
        ),
      )
      .orderBy(apiKeys.name, apiKeys.id, models.name);

    const options = new Map<
      string,
      {
        id: string;
        name: string;
        token: string;
        expiresAt: string | null;
        channelName: string;
        endpoints: (typeof rows)[number]['endpoint'][];
        models: { id: string; name: string; outputTokenLimit: number }[];
      }
    >();
    for (const row of rows) {
      let key = options.get(row.keyId);
      if (!key) {
        key = {
          id: row.keyId,
          name: row.keyName,
          token: row.token,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          channelName: row.channelName,
          endpoints: [],
          models: [],
        };
        options.set(row.keyId, key);
      }
      if (!key.endpoints.includes(row.endpoint)) key.endpoints.push(row.endpoint);
      if (!key.models.some((model) => model.id === row.modelId))
        key.models.push({ id: row.modelId, name: row.modelName, outputTokenLimit: row.outputTokenLimit });
    }
    return [...options.values()];
  }

  async bindChannel(principal: Principal, keyId: string, channelId: string) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const [key] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id), isNull(apiKeys.deletedAt)))
        .for('update');
      if (!key) throw new TRPCError({ code: 'NOT_FOUND', message: 'Key 不存在' });
      if (key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Key 已失效' });
      const [existing] = await tx.select().from(apiKeyChannels).where(eq(apiKeyChannels.apiKeyId, keyId));
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Key 已绑定渠道，请创建新的 Key' });
      const offerings = await this.offerings(tx, user.id, user.role);
      if (!offerings.some((o) => o.channelId === channelId))
        throw new TRPCError({ code: 'FORBIDDEN', message: '渠道不可用、未授权或没有可用模型' });
      await tx.insert(apiKeyChannels).values({ apiKeyId: keyId, channelId });
      return { success: true };
    });
  }

  async list(userId: string, page: number) {
    const rows = await this.auth.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        token: apiKeys.key,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
        restrictModels: apiKeys.restrictModels,
        channelId: apiKeyChannels.channelId,
        channelName: channels.name,
        channelDeleted: sql<boolean>`${channels.deletedAt} is not null`,
      })
      .from(apiKeys)
      .leftJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
      .leftJoin(channels, eq(channels.id, apiKeyChannels.channelId))
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.deletedAt)))
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
            and(
              isNull(models.deletedAt),
              inArray(
                apiKeyModelGrants.apiKeyId,
                items.map((key) => key.id),
              ),
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
            isNull(apiKeys.deletedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        );
      if (count >= 100) throw new TRPCError({ code: 'BAD_REQUEST', message: '最多保留 100 个有效 Key' });
      const modelIds = [...new Set(input.modelIds ?? [])];
      const offerings = (await this.offerings(tx, user.id, user.role)).filter((o) => o.channelId === input.channelId);
      if (!offerings.length) throw new TRPCError({ code: 'FORBIDDEN', message: '渠道不可用、未授权或没有可用模型' });
      if (modelIds.some((id) => !offerings.some((o) => o.modelId === id)))
        throw new TRPCError({ code: 'FORBIDDEN', message: '包含渠道不可用或未授权的模型' });
      const token = `sk-${randomBytes(32).toString('base64url')}`;
      const [key] = await tx
        .insert(apiKeys)
        .values({
          userId: user.id,
          name: input.name,
          key: token,
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

  async delete(principal: Principal, keyId: string) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const now = new Date();
      const [key] = await tx
        .update(apiKeys)
        .set({ deletedAt: now, revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${now})` })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id), isNull(apiKeys.deletedAt)))
        .returning({ id: apiKeys.id, name: apiKeys.name });
      if (!key) throw new TRPCError({ code: 'NOT_FOUND', message: 'Key 不存在或已删除' });
      await tx.insert(adminAuditLogs).values({
        actorId: user.id,
        action: 'key.delete',
        targetType: 'api_key',
        targetId: key.id,
        metadata: { name: key.name },
      });
      return { success: true };
    });
  }
}
