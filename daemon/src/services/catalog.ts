import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';

import { formatMoney, parseMoney } from '../billing/conventions.js';
import { expandRules, multiplierInput, ruleInput, validateRules } from '../billing/pricing.js';
import {
  adminAuditLogs,
  channelAvailableModels,
  channelEndpoints,
  channels,
  models,
  priceRules,
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
  isPublic: z.boolean().default(true),
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
  inputTokenLimit: z.number().int().min(1).default(1_000_000),
  outputTokenLimit: z.number().int().min(1).default(128_000),
});
export const importModelsInput = z.object({
  models: z
    .array(
      z.object({
        model: modelInput.omit({ id: true }),
        providerId: z.string().min(1).max(128),
        preset: z.enum(['none', 'gpt', 'deepseek']),
        rules: z.array(ruleInput).min(1).max(3),
      }),
    )
    .min(1, '至少选择一个模型')
    .max(100, '每次最多导入 100 个模型')
    .refine((rows) => new Set(rows.map((row) => row.model.name)).size === rows.length, '不能导入同名模型的多个来源'),
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
    const [channelRows, modelRows, channelScopes, available, activePrices] = await Promise.all([
      this.auth.db
        .select({
          id: channels.id,
          name: channels.name,
          baseUrl: channels.baseUrl,
          enabled: channels.enabled,
          isPublic: channels.isPublic,
          timeoutMs: channels.timeoutMs,
          multiplierMicros: channels.multiplierMicros,
        })
        .from(channels)
        .where(isNull(channels.deletedAt))
        .orderBy(asc(channels.name)),
      this.auth.db.select().from(models).where(isNull(models.deletedAt)).orderBy(asc(models.name)),
      this.auth.db.select().from(channelEndpoints),
      this.auth.db.select().from(channelAvailableModels),
      this.auth.db.select({ modelId: priceRules.modelId }).from(priceRules).where(eq(priceRules.kind, 'default')),
    ]);
    return {
      channels: channelRows.map(({ multiplierMicros, ...c }) => ({
        ...c,
        multiplier: formatMoney(multiplierMicros),
        availableModels: available
          .filter((a) => a.channelId === c.id && modelRows.some((m) => m.id === a.modelId))
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
        priced: activePrices.some((p) => p.modelId === m.id),
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
        ? await tx
            .select()
            .from(channels)
            .where(and(eq(channels.id, input.id), isNull(channels.deletedAt)))
            .for('update')
        : [];
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '渠道不存在' });
      if (!existing && !input.credential) throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写上游凭据' });
      const [duplicate] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.name, input.name), isNull(channels.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new TRPCError({ code: 'CONFLICT', message: '渠道名称已存在' });
      const modelIds = input.availableModels.map((m) => m.modelId);
      if (new Set(modelIds).size !== modelIds.length)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '模型不能重复' });
      if (
        modelIds.length &&
        (
          await tx
            .select({ id: models.id })
            .from(models)
            .where(and(inArray(models.id, modelIds), isNull(models.deletedAt)))
        ).length !== modelIds.length
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: '包含不存在的模型' });
      const values = {
        name: input.name,
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        enabled: input.enabled,
        isPublic: input.isPublic,
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
        isPublic: input.isPublic,
        multiplier: input.multiplier,
        availableModels: input.availableModels,
        credentialChanged: Boolean(input.credential),
      });
      return row;
    });
  }
  async saveModel(principal: Principal, input: z.infer<typeof modelInput>) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(models)
            .where(and(eq(models.id, input.id), isNull(models.deletedAt)))
            .for('update')
        : [];
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在' });
      const [duplicate] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.name, input.name), isNull(models.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new TRPCError({ code: 'CONFLICT', message: '模型名称已存在' });
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
      await this.audit(tx, actor.id, 'model.save', row.id, {
        name: input.name,
        enabled: input.enabled,
        inputTokenLimit: input.inputTokenLimit,
        outputTokenLimit: input.outputTokenLimit,
      });
      return row;
    });
  }
  async importModels(principal: Principal, input: z.infer<typeof importModelsInput>) {
    const prepared = input.models.map((entry) => {
      const rules = expandRules(entry.rules);
      try {
        validateRules(rules);
      } catch (error) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${entry.model.name}：${(error as Error).message}` });
      }
      return { ...entry, rules };
    });
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const imported = await tx
        .insert(models)
        .values(prepared.map((entry) => entry.model))
        .onConflictDoNothing({ target: models.name, where: isNull(models.deletedAt) })
        .returning({ id: models.id, name: models.name });
      for (const model of imported) {
        const entry = prepared.find((item) => item.model.name === model.name) as (typeof prepared)[number];
        await tx.insert(priceRules).values(entry.rules.map((rule) => ({ ...rule, modelId: model.id })));
        await this.audit(tx, actor.id, 'model.import', model.id, {
          source: 'models.dev',
          providerId: entry.providerId,
          preset: entry.preset,
          model: entry.model,
          rules: input.models.find((item) => item.model.name === model.name)?.rules,
        });
      }
      return {
        imported,
        skipped: prepared
          .filter((entry) => !imported.some((model) => model.name === entry.model.name))
          .map((entry) => entry.model.name),
      };
    });
  }
  async grants(userId: string) {
    return this.auth.db
      .select({ modelId: userModelGrants.modelId })
      .from(userModelGrants)
      .innerJoin(models, eq(models.id, userModelGrants.modelId))
      .where(and(eq(userModelGrants.userId, userId), isNull(models.deletedAt)));
  }
  async deleteChannel(principal: Principal, channelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [channel] = await tx
        .update(channels)
        .set({ deletedAt: new Date(), enabled: false })
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .returning({ id: channels.id, name: channels.name });
      if (!channel) throw new TRPCError({ code: 'NOT_FOUND', message: '渠道不存在或已删除' });
      await this.audit(tx, actor.id, 'channel.delete', channel.id, { name: channel.name });
      return { success: true };
    });
  }
  async deleteModel(principal: Principal, modelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [model] = await tx
        .update(models)
        .set({ deletedAt: new Date(), enabled: false })
        .where(and(eq(models.id, modelId), isNull(models.deletedAt)))
        .returning({ id: models.id, name: models.name });
      if (!model) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在或已删除' });
      await this.audit(tx, actor.id, 'model.delete', model.id, { name: model.name });
      return { success: true };
    });
  }
  async setGrants(principal: Principal, userId: string, modelIds: string[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user?.role !== 'user' || user.deletedAt)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '仅为未删除的普通用户设置模型授权' });
      const ids = [...new Set(modelIds)];
      if (
        ids.length &&
        (
          await tx
            .select({ id: models.id })
            .from(models)
            .where(and(inArray(models.id, ids), isNull(models.deletedAt)))
        ).length !== ids.length
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: '模型不存在' });
      await tx.delete(userModelGrants).where(eq(userModelGrants.userId, userId));
      if (ids.length) await tx.insert(userModelGrants).values(ids.map((modelId) => ({ userId, modelId })));
      await this.audit(tx, actor.id, 'user.models', userId, { modelIds: ids });
      return { success: true };
    });
  }
}
