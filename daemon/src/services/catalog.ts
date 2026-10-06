import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, lte, notInArray } from 'drizzle-orm';
import { z } from 'zod';

import { formatMoney, parseMoney } from '../billing/conventions.js';
import { multiplierInput } from '../billing/pricing.js';
import {
  adminAuditLogs,
  channelAvailableModels,
  channelEndpoints,
  channels,
  modelEndpoints,
  models,
  priceVersions,
  userModelGrants,
  users,
} from '../db/schema/index.js';
import type { AuthService, Principal, Transaction } from './auth.js';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const endpoints = ['/v1/chat/completions', '/v1/responses', '/v1/messages'] as const;
export type Endpoint = (typeof endpoints)[number];
const name = z.string().trim().min(1).max(128);
export const channelInput = z.object({
  id: z.uuid().optional(),
  name,
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, 'Base URL 需为无凭据、查询参数和片段的 HTTP(S) 地址'),
  credential: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, '凭据不能包含空格或控制字符')
    .optional(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(100).max(600_000),
  multiplier: multiplierInput.default('1'),
  availableModels: z
    .array(z.object({ modelId: z.uuid(), multiplier: multiplierInput.nullable() }))
    .max(100)
    .default([]),
  endpoints: z
    .array(z.enum(endpoints))
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length),
});
export const modelInput = z.object({
  id: z.uuid().optional(),
  name: name.regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/, '模型名称格式无效'),
  enabled: z.boolean(),
  inputTokenLimit: z.number().int().min(1).max(2_000_000).default(32768),
  outputTokenLimit: z.number().int().min(1).max(100_000).default(4096),
  endpoints: z
    .array(z.enum(endpoints))
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length),
});
export class CredentialVault {
  private readonly key?: Buffer;
  constructor(raw: string | undefined) {
    if (raw !== undefined && raw !== '') {
      if (!/^[a-fA-F0-9]{64}$/.test(raw))
        throw new Error('CHANNEL_ENCRYPTION_KEY must contain 64 hexadecimal characters');
      this.key = Buffer.from(raw, 'hex');
    }
  }
  private requireKey() {
    if (!this.key) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '请先配置 CHANNEL_ENCRYPTION_KEY' });
    return this.key;
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }
  decrypt(value: string) {
    const [version, iv, tag, encrypted] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted credential');
    const cipher = createDecipheriv('aes-256-gcm', this.requireKey(), Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8');
  }
}

export class CatalogService {
  static readonly token = serviceToken<CatalogService>('ohmyapi/catalog');
  private readonly auth: AuthService;
  readonly vault: CredentialVault;
  constructor(auth: AuthService, vault: CredentialVault) {
    this.auth = auth;
    this.vault = vault;
  }
  async list() {
    const [channelRows, modelRows, channelScopes, modelScopes, available, activePrices] = await Promise.all([
      this.auth.db
        .select({
          id: channels.id,
          name: channels.name,
          baseUrl: channels.baseUrl,
          enabled: channels.enabled,
          timeoutMs: channels.timeoutMs,
          multiplierMicros: channels.multiplierMicros,
        })
        .from(channels)
        .orderBy(asc(channels.name)),
      this.auth.db.select().from(models).orderBy(asc(models.name)),
      this.auth.db.select().from(channelEndpoints),
      this.auth.db.select().from(modelEndpoints),
      this.auth.db.select().from(channelAvailableModels),
      this.auth.db
        .select({ modelId: priceVersions.modelId, endpoint: priceVersions.endpoint })
        .from(priceVersions)
        .where(
          and(
            eq(priceVersions.status, 'published'),
            lte(priceVersions.effectiveAt, new Date()),
            lte(priceVersions.publishedAt, new Date()),
          ),
        ),
    ]);
    return {
      channels: channelRows.map(({ multiplierMicros, ...c }) => ({
        ...c,
        multiplier: formatMoney(multiplierMicros),
        availableModels: available
          .filter((a) => a.channelId === c.id)
          .map((a) => ({
            modelId: a.modelId,
            multiplier: a.multiplierMicros === null ? null : formatMoney(a.multiplierMicros),
          })),
        endpoints: channelScopes.filter((s) => s.channelId === c.id).map((s) => s.endpoint),
      })),
      models: modelRows.map((m) => ({
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        pricedEndpoints: [...new Set(activePrices.filter((p) => p.modelId === m.id).map((p) => p.endpoint))],
        endpoints: modelScopes.filter((s) => s.modelId === m.id).map((s) => s.endpoint),
      })),
    };
  }
  private async audit(
    tx: Transaction,
    actorId: string,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await tx.insert(adminAuditLogs).values({ actorId, action, targetType: 'catalog', targetId, metadata });
  }
  async saveChannel(principal: Principal, input: z.infer<typeof channelInput>) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [existing] = input.id
        ? await tx.select().from(channels).where(eq(channels.id, input.id)).for('update')
        : [];
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '渠道不存在' });
      if (!existing && !input.credential) throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写上游凭据' });
      const [duplicate] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.name, input.name));
      if (duplicate && duplicate.id !== input.id) throw new TRPCError({ code: 'CONFLICT', message: '渠道名称已存在' });
      const modelIds = input.availableModels.map((m) => m.modelId);
      if (new Set(modelIds).size !== modelIds.length)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '模型不能重复' });
      if (
        modelIds.length &&
        (await tx.select({ id: models.id }).from(models).where(inArray(models.id, modelIds))).length !== modelIds.length
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: '包含不存在的模型' });
      if (modelIds.length) {
        const scopes = await tx.select().from(modelEndpoints).where(inArray(modelEndpoints.modelId, modelIds));
        if (modelIds.some((id) => !scopes.some((s) => s.modelId === id && input.endpoints.includes(s.endpoint))))
          throw new TRPCError({ code: 'BAD_REQUEST', message: '可用模型需至少有一个端点与渠道共同支持' });
      }
      const values = {
        name: input.name,
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        enabled: input.enabled,
        timeoutMs: input.timeoutMs,
        multiplierMicros: parseMoney(input.multiplier),
        credentialEncrypted: input.credential
          ? this.vault.encrypt(input.credential)
          : (existing?.credentialEncrypted as string),
      };
      const [row] = existing
        ? await tx.update(channels).set(values).where(eq(channels.id, existing.id)).returning({ id: channels.id })
        : await tx.insert(channels).values(values).returning({ id: channels.id });
      await tx
        .delete(channelEndpoints)
        .where(and(eq(channelEndpoints.channelId, row.id), notInArray(channelEndpoints.endpoint, input.endpoints)));
      await tx
        .insert(channelEndpoints)
        .values(input.endpoints.map((endpoint) => ({ channelId: row.id, endpoint })))
        .onConflictDoNothing();
      await tx.delete(channelAvailableModels).where(eq(channelAvailableModels.channelId, row.id));
      if (input.availableModels.length)
        await tx.insert(channelAvailableModels).values(
          input.availableModels.map((m) => ({
            channelId: row.id,
            modelId: m.modelId,
            multiplierMicros: m.multiplier === null ? null : parseMoney(m.multiplier),
          })),
        );
      await this.audit(tx, actor.id, 'channel.save', row.id, {
        name: input.name,
        endpoints: input.endpoints,
        enabled: input.enabled,
        multiplier: input.multiplier,
        availableModels: input.availableModels,
        credentialChanged: Boolean(input.credential),
      });
      return row;
    });
  }
  async saveModel(principal: Principal, input: z.infer<typeof modelInput>) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      if (input.endpoints.includes('/v1/responses') && input.outputTokenLimit < 16)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Responses 的输出上限至少为 16 Token' });
      const [existing] = input.id ? await tx.select().from(models).where(eq(models.id, input.id)).for('update') : [];
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在' });
      const [duplicate] = await tx.select({ id: models.id }).from(models).where(eq(models.name, input.name));
      if (duplicate && duplicate.id !== input.id) throw new TRPCError({ code: 'CONFLICT', message: '模型名称已存在' });
      // Keep existing endpoint rows because historical pricing references them.
      if (existing) {
        const scopes = await tx.select().from(modelEndpoints).where(eq(modelEndpoints.modelId, existing.id));
        if (scopes.some((s) => !input.endpoints.includes(s.endpoint)))
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: '已声明的模型端点不能删除，可禁用模型或移除渠道的可用模型',
          });
      }
      const [row] = existing
        ? await tx
            .update(models)
            .set({
              name: input.name,
              enabled: input.enabled,
              inputTokenLimit: input.inputTokenLimit,
              outputTokenLimit: input.outputTokenLimit,
            })
            .where(eq(models.id, existing.id))
            .returning({ id: models.id })
        : await tx
            .insert(models)
            .values({
              name: input.name,
              enabled: input.enabled,
              inputTokenLimit: input.inputTokenLimit,
              outputTokenLimit: input.outputTokenLimit,
            })
            .returning({ id: models.id });
      await tx
        .insert(modelEndpoints)
        .values(input.endpoints.map((endpoint) => ({ modelId: row.id, endpoint })))
        .onConflictDoNothing();
      await this.audit(tx, actor.id, 'model.save', row.id, {
        name: input.name,
        enabled: input.enabled,
        endpoints: input.endpoints,
        inputTokenLimit: input.inputTokenLimit,
        outputTokenLimit: input.outputTokenLimit,
      });
      return row;
    });
  }
  async grants(userId: string) {
    return this.auth.db
      .select({ modelId: userModelGrants.modelId })
      .from(userModelGrants)
      .where(eq(userModelGrants.userId, userId));
  }
  async setGrants(principal: Principal, userId: string, modelIds: string[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user?.role !== 'user') throw new TRPCError({ code: 'BAD_REQUEST', message: '仅为普通用户设置模型授权' });
      const ids = [...new Set(modelIds)];
      if (
        ids.length &&
        (await tx.select({ id: models.id }).from(models).where(inArray(models.id, ids))).length !== ids.length
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: '模型不存在' });
      await tx.delete(userModelGrants).where(eq(userModelGrants.userId, userId));
      if (ids.length) await tx.insert(userModelGrants).values(ids.map((modelId) => ({ userId, modelId })));
      await this.audit(tx, actor.id, 'user.models', userId, { modelIds: ids });
      return { success: true };
    });
  }
}
