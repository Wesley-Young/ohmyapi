import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type EventLogger, errorDetails } from '../../logging.js';
import type { AuthService, Principal, Transaction } from '../auth/service.js';
import { formatMoney, parseMoney } from '../billing/conventions.js';
import {
  adminAuditLogs,
  aggregateChannelMembers,
  channelAvailableModels,
  channelEndpoints,
  channels,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  models,
  priceRules,
  subscriptionAccounts,
  userChannelGrants,
  users,
} from '../database/schema/index.js';
import { expandRules, multiplierInput, ruleInput, validateRules } from '../pricing/rules.js';
import { type SubscriptionService, subscriptionInput } from '../subscription/service.js';
import { channelTypes, pricingModes } from './channel-types.js';
import type { CredentialVault } from './vault.js';

export { CredentialVault } from './vault.js';

export const endpoints = ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/responses/compact'] as const;
export type Endpoint = (typeof endpoints)[number];
const name = z.string().trim().min(1).max(128);
const modelName = name.regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/, '模型名称格式无效');
export const channelInput = z.object({
  id: z.uuid().optional(),
  name,
  type: z.enum(channelTypes).default('api'),
  pricingMode: z.enum(pricingModes).optional(),
  baseUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, 'Base URL 需为无凭据、查询参数和片段的 HTTP(S) 地址')
    .optional(),
  subscription: subscriptionInput.optional(),
  credential: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, '凭据不能包含空格或控制字符')
    .optional(),
  enabled: z.boolean(),
  isPublic: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(600_000),
  multiplier: multiplierInput.optional(),
  availableModels: z
    .array(z.object({ name: modelName, multiplier: multiplierInput.nullable() }))
    .max(1000, '每个渠道最多添加 1000 个模型')
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length, '模型不能重复')
    .optional(),
  members: z
    .array(
      z.object({
        channelId: z.uuid(),
        priority: z.number().int().min(0).max(1000).default(0),
        weight: z.number().int().min(1).max(1000).default(1),
      }),
    )
    .max(100)
    .refine((items) => new Set(items.map((item) => item.channelId)).size === items.length, '子渠道不能重复')
    .default([]),
  endpoints: z
    .array(z.enum(endpoints))
    .max(4)
    .refine((v) => new Set(v).size === v.length)
    .default([]),
});
export const fetchChannelModelsInput = channelInput
  .pick({ id: true, baseUrl: true, credential: true })
  .required({ baseUrl: true });
export const modelInput = z.object({
  id: z.uuid().optional(),
  name: modelName,
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
export class CatalogService {
  static readonly token = serviceToken<CatalogService>('ohmyapi/catalog');
  private readonly auth: AuthService;
  private readonly logger: EventLogger;
  readonly vault: CredentialVault;
  private readonly subscription: SubscriptionService;
  constructor(auth: AuthService, vault: CredentialVault, logger: EventLogger, subscription: SubscriptionService) {
    this.auth = auth;
    this.vault = vault;
    this.logger = logger;
    this.subscription = subscription;
  }

  async list() {
    const [channelRows, modelRows, channelScopes, available, activePrices, members] = await Promise.all([
      this.auth.db
        .select({
          id: channels.id,
          name: channels.name,
          type: channels.type,
          pricingMode: channels.pricingMode,
          subscription: {
            id: subscriptionAccounts.id,
            provider: subscriptionAccounts.provider,
            credentialEncrypted: subscriptionAccounts.credentialEncrypted,
            maxConcurrent: subscriptionAccounts.maxConcurrent,
            expiresAt: subscriptionAccounts.expiresAt,
            errorCode: subscriptionAccounts.errorCode,
            cooldownUntil: subscriptionAccounts.cooldownUntil,
          },
          baseUrl: channels.baseUrl,
          enabled: channels.enabled,
          isPublic: channels.isPublic,
          timeoutMs: channels.timeoutMs,
          multiplierMicros: channels.multiplierMicros,
        })
        .from(channels)
        .leftJoin(subscriptionAccounts, eq(channels.subscriptionAccountId, subscriptionAccounts.id))
        .where(isNull(channels.deletedAt))
        .orderBy(asc(channels.name)),
      this.auth.db.select().from(models).where(isNull(models.deletedAt)).orderBy(asc(models.name)),
      this.auth.db.select().from(effectiveChannelEndpoints),
      this.auth.db.select().from(effectiveChannelModels),
      this.auth.db.select({ modelId: priceRules.modelId }).from(priceRules).where(eq(priceRules.kind, 'default')),
      this.auth.db.select().from(aggregateChannelMembers),
    ]);
    return {
      channels: channelRows.map(({ multiplierMicros, ...c }) => ({
        ...c,
        subscription: c.subscription
          ? {
              provider: c.subscription.provider,
              email: this.subscription.accountEmail(c.subscription.credentialEncrypted),
              maxConcurrent: c.subscription.maxConcurrent,
              expiresAt: c.subscription.expiresAt.toISOString(),
              errorCode: c.subscription.errorCode,
              cooldownUntil: c.subscription.cooldownUntil?.toISOString() ?? null,
              active: this.subscription.concurrency.active(c.subscription.id),
            }
          : null,
        members: members
          .filter((member) => member.aggregateChannelId === c.id)
          .map((member) => ({
            channelId: member.memberChannelId,
            priority: member.priority,
            weight: member.weight,
          })),
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

  async fetchChannelModels(principal: Principal, input: z.infer<typeof fetchChannelModelsInput>) {
    const credential = await this.auth.authorized(principal, { admin: true }, async (tx) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(channels)
            .where(and(eq(channels.id, input.id), isNull(channels.deletedAt)))
        : [];
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '渠道不存在' });
      if (existing && existing.type !== 'api')
        throw new TRPCError({ code: 'BAD_REQUEST', message: '该渠道类型暂不支持拉取模型' });
      if (input.credential) return input.credential;
      if (existing?.credentialEncrypted) return this.vault.decrypt(existing.credentialEncrypted);
      throw new TRPCError({ code: 'BAD_REQUEST', message: '请先填写上游凭据' });
    });
    const base = input.baseUrl.replace(/\/+$/, '');
    const url = new URL(base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`);
    const signal = AbortSignal.timeout(20_000);
    const names = new Set<string>();
    const cursors = new Set<string>();
    let bytes = 0;
    let ignored = 0;
    const startedAt = Date.now();
    let httpStatus: number | undefined;
    let stage = 'fetch';
    try {
      for (;;) {
        stage = 'fetch';
        const response = await fetch(url, {
          headers: {
            authorization: `Bearer ${credential}`,
            'x-api-key': credential,
            'anthropic-version': '2023-06-01',
          },
          signal,
          redirect: 'error',
        });
        httpStatus = response.status;
        if (!response.ok) {
          stage = 'http_error';
          await response.body?.cancel();
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              response.status === 404
                ? '上游不支持模型列表，请手动添加模型'
                : `获取模型失败，上游返回 HTTP ${response.status}，请检查地址和凭据`,
          });
        }
        stage = 'read_body';
        const reader = response.body?.getReader();
        if (!reader) throw new TRPCError({ code: 'BAD_REQUEST', message: '上游返回了空的模型列表' });
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2 * 1024 * 1024) {
              stage = 'response_too_large';
              throw new TRPCError({ code: 'BAD_REQUEST', message: '上游模型列表过大' });
            }
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        stage = 'parse_models';
        const page = z
          .object({
            data: z.array(z.object({ id: z.string() })).max(1000),
            has_more: z.boolean().optional(),
            last_id: z.string().optional(),
          })
          .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!page.success)
          throw new TRPCError({ code: 'BAD_REQUEST', message: '上游模型列表格式无效，请手动添加模型' });
        for (const model of page.data.data) {
          const parsed = modelName.safeParse(model.id);
          if (parsed.success) names.add(parsed.data);
          else ignored++;
        }
        if (names.size > 1000) throw new TRPCError({ code: 'BAD_REQUEST', message: '每个渠道最多添加 1000 个模型' });
        if (!page.data.has_more) break;
        const cursor = page.data.last_id;
        stage = 'pagination';
        if (!cursor || cursors.has(cursor))
          throw new TRPCError({ code: 'BAD_REQUEST', message: '上游模型列表分页无效' });
        cursors.add(cursor);
        url.searchParams.set('after_id', cursor);
      }
      stage = 'empty_models';
      if (!names.size) throw new TRPCError({ code: 'BAD_REQUEST', message: '上游未返回有效模型，请手动添加模型' });
    } catch (error) {
      this.logger.warn(
        `上游模型列表获取失败 ${JSON.stringify({
          actorId: principal.user.id,
          channelId: input.id,
          stage,
          timedOut: signal.aborted,
          httpStatus,
          durationMs: Date.now() - startedAt,
          responseBytes: bytes,
          ...errorDetails(error),
        })}`,
      );
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'BAD_REQUEST', message: '无法获取上游模型，请检查地址、凭据和连接后重试' });
    }
    this.logger.info(
      `上游模型列表获取完成 ${JSON.stringify({
        actorId: principal.user.id,
        channelId: input.id,
        modelCount: names.size,
        ignored,
        durationMs: Date.now() - startedAt,
      })}`,
    );
    return { names: [...names].sort(), ignored };
  }

  async saveChannel(principal: Principal, input: z.infer<typeof channelInput>) {
    const credentials =
      input.type === 'subscription' && input.subscription
        ? await this.subscription.prepareCredentials(principal, input.subscription)
        : undefined;
    const result = await this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(channels)
            .where(and(eq(channels.id, input.id), isNull(channels.deletedAt)))
            .for('update')
        : [];
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '渠道不存在' });
      const pricingMode = input.pricingMode ?? existing?.pricingMode ?? 'unified';
      if (input.type !== 'aggregate' && pricingMode !== 'unified')
        throw new TRPCError({ code: 'BAD_REQUEST', message: '仅聚合渠道支持透传倍率' });
      const passthrough = pricingMode === 'passthrough';
      const previousModels =
        existing && input.availableModels === undefined && !passthrough
          ? await tx
              .select({ name: models.name, multiplierMicros: channelAvailableModels.multiplierMicros })
              .from(channelAvailableModels)
              .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
              .where(and(eq(channelAvailableModels.channelId, existing.id), isNull(models.deletedAt)))
          : [];
      const configuredModels = passthrough
        ? []
        : (input.availableModels ??
          previousModels.map((model) => ({
            name: model.name,
            multiplier: model.multiplierMicros === null ? null : formatMoney(model.multiplierMicros),
          })));

      if (existing && existing.type !== input.type)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '渠道类型创建后不可更改，请新建渠道' });
      if (input.type !== 'aggregate' && (!input.endpoints.length || input.members.length))
        throw new TRPCError({ code: 'BAD_REQUEST', message: '普通渠道需配置端点，且不能配置子渠道' });
      let aggregateModels: { id: string; name: string }[] = [];
      if (input.type === 'aggregate') {
        if (input.baseUrl || input.credential || input.subscription || input.endpoints.length)
          throw new TRPCError({ code: 'BAD_REQUEST', message: '聚合渠道的连接和端点由子渠道提供' });
        if (!input.members.length || input.members.some((member) => member.channelId === input.id))
          throw new TRPCError({ code: 'BAD_REQUEST', message: '至少选择一个子渠道，且不能引用自身' });
        const memberIds = input.members.map((member) => member.channelId).sort();
        const children = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              inArray(channels.id, memberIds),
              inArray(channels.type, ['api', 'subscription']),
              isNull(channels.deletedAt),
            ),
          )
          .orderBy(channels.id)
          .for('share');
        if (children.length !== memberIds.length)
          throw new TRPCError({ code: 'BAD_REQUEST', message: '子渠道不存在、已删除或属于聚合类型' });
        const childModels = await tx
          .select({ channelId: channelAvailableModels.channelId, id: models.id, name: models.name })
          .from(channelAvailableModels)
          .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
          .where(and(inArray(channelAvailableModels.channelId, memberIds), isNull(models.deletedAt)));
        aggregateModels = childModels
          .filter(
            (model) =>
              model.channelId === memberIds[0] &&
              memberIds.every((id) => childModels.some((other) => other.channelId === id && other.id === model.id)),
          )
          .map(({ id, name }) => ({ id, name }));
        const childEndpoints = await tx
          .select()
          .from(channelEndpoints)
          .where(inArray(channelEndpoints.channelId, memberIds));
        const hasCommonEndpoint = endpoints.some((endpoint) =>
          memberIds.every((id) =>
            childEndpoints.some((entry) => entry.channelId === id && entry.endpoint === endpoint),
          ),
        );
        if (input.enabled && (!aggregateModels.length || !hasCommonEndpoint))
          throw new TRPCError({ code: 'BAD_REQUEST', message: '子渠道需至少有一个共同模型和共同端点' });
        if (
          input.availableModels &&
          configuredModels.some((model) => !aggregateModels.some((common) => common.name === model.name))
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: '只能为子渠道的共同模型设置倍率，请刷新后重试' });
      } else if (input.type === 'api') {
        if (!input.baseUrl || (!existing && !input.credential))
          throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写 Base URL 和上游凭据' });
        if (input.subscription) throw new TRPCError({ code: 'BAD_REQUEST', message: 'API 渠道不能配置订阅凭据' });
      } else {
        if (!input.subscription) throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写订阅配置' });
        if (input.baseUrl || input.credential)
          throw new TRPCError({ code: 'BAD_REQUEST', message: '订阅渠道使用账号凭据，无需填写 API 连接信息' });
        if (input.endpoints.some((endpoint) => endpoint !== '/v1/responses' && endpoint !== '/v1/responses/compact'))
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'OpenAI 订阅渠道仅支持 Responses 和 compact' });
      }
      const [duplicate] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.name, input.name), isNull(channels.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new TRPCError({ code: 'CONFLICT', message: '渠道名称已存在' });
      const names = (input.type === 'aggregate' ? aggregateModels : configuredModels).map((m) => m.name).sort();
      if (names.length && input.type !== 'aggregate') {
        const created = await tx
          .insert(models)
          .values(names.map((name) => ({ name, inputTokenLimit: 1_000_000, outputTokenLimit: 128_000 })))
          .onConflictDoNothing({ target: models.name, where: isNull(models.deletedAt) })
          .returning({ id: models.id, name: models.name });
        for (const model of created)
          await this.audit(tx, actor.id, 'model.placeholder', model.id, {
            name: model.name,
            source: 'channel',
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 128_000,
          });
      }
      const resolved = names.length
        ? await tx
            .select({ id: models.id, name: models.name })
            .from(models)
            .where(and(inArray(models.name, names), isNull(models.deletedAt)))
            .orderBy(models.name)
            .for('share')
        : [];
      if (resolved.length !== names.length) throw new TRPCError({ code: 'CONFLICT', message: '模型已变更，请重试' });
      const available = resolved.map((model) => ({
        modelId: model.id,
        multiplier: configuredModels.find((row) => row.name === model.name)?.multiplier ?? null,
      }));
      const subscriptionAccountId =
        input.type === 'subscription' && input.subscription
          ? await this.subscription.saveAccount(
              tx,
              {
                id: existing?.subscriptionAccountId ?? undefined,
                name: input.name,
                enabled: input.enabled,
                maxConcurrent: input.subscription.maxConcurrent,
              },
              credentials,
            )
          : null;
      const values = {
        name: input.name,
        type: input.type,
        pricingMode,
        baseUrl: input.type === 'api' ? input.baseUrl?.replace(/\/+$/, '') : null,
        subscriptionAccountId,
        enabled: input.enabled,
        isPublic: input.isPublic,
        timeoutMs: input.timeoutMs,
        multiplierMicros:
          passthrough && existing
            ? existing.multiplierMicros
            : parseMoney(input.multiplier ?? (existing ? formatMoney(existing.multiplierMicros) : '1')),
        credentialEncrypted:
          input.type !== 'api'
            ? null
            : input.credential
              ? this.vault.encrypt(input.credential)
              : (existing?.credentialEncrypted as string),
      };
      const [row] = existing
        ? await tx.update(channels).set(values).where(eq(channels.id, existing.id)).returning({ id: channels.id })
        : await tx.insert(channels).values(values).returning({ id: channels.id });
      await tx
        .delete(channelEndpoints)
        .where(and(eq(channelEndpoints.channelId, row.id), notInArray(channelEndpoints.endpoint, input.endpoints)));
      if (input.endpoints.length)
        await tx
          .insert(channelEndpoints)
          .values(input.endpoints.map((endpoint) => ({ channelId: row.id, endpoint })))
          .onConflictDoNothing();
      await tx.delete(aggregateChannelMembers).where(eq(aggregateChannelMembers.aggregateChannelId, row.id));
      if (input.type === 'aggregate')
        await tx.insert(aggregateChannelMembers).values(
          input.members.map((member) => ({
            aggregateChannelId: row.id,
            memberChannelId: member.channelId,
            priority: member.priority,
            weight: member.weight,
          })),
        );
      if (!passthrough) await tx.delete(channelAvailableModels).where(eq(channelAvailableModels.channelId, row.id));
      if (!passthrough && available.length)
        await tx.insert(channelAvailableModels).values(
          available.map((m) => ({
            channelId: row.id,
            modelId: m.modelId,
            multiplierMicros: m.multiplier === null ? null : parseMoney(m.multiplier),
          })),
        );
      await this.audit(tx, actor.id, 'channel.save', row.id, {
        name: input.name,
        type: input.type,
        endpoints: input.endpoints,
        enabled: input.enabled,
        isPublic: input.isPublic,
        pricingMode,
        multiplier: formatMoney(values.multiplierMicros),
        availableModels: configuredModels,
        members: input.members,
        credentialChanged: Boolean(input.credential || credentials),
        maxConcurrent: input.subscription?.maxConcurrent,
      });
      const priced = resolved.length
        ? await tx
            .select({ modelId: priceRules.modelId })
            .from(priceRules)
            .where(
              and(
                inArray(
                  priceRules.modelId,
                  resolved.map((m) => m.id),
                ),
                eq(priceRules.kind, 'default'),
              ),
            )
        : [];
      return { ...row, unpricedModels: resolved.filter((m) => !priced.some((p) => p.modelId === m.id)) };
    });
    if (input.type === 'subscription' && input.subscription?.callbackUrl)
      this.subscription.consumeAuthorization(principal, input.subscription.callbackUrl);
    return result;
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
    const prepared = input.models
      .map((entry) => {
        const rules = expandRules(entry.rules);
        try {
          validateRules(rules);
        } catch (error) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `${entry.model.name}：${(error as Error).message}` });
        }
        return { ...entry, rules };
      })
      .sort((a, b) => a.model.name.localeCompare(b.model.name));
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const imported = await tx
        .insert(models)
        .values(prepared.map((entry) => entry.model))
        .onConflictDoUpdate({
          target: models.name,
          targetWhere: isNull(models.deletedAt),
          set: {
            enabled: sql`excluded.enabled`,
            inputTokenLimit: sql`excluded.input_token_limit`,
            outputTokenLimit: sql`excluded.output_token_limit`,
          },
        })
        .returning({ id: models.id, name: models.name });
      await tx.delete(priceRules).where(
        inArray(
          priceRules.modelId,
          imported.map((model) => model.id),
        ),
      );
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
      return { imported };
    });
  }

  async grants(userId: string) {
    return this.auth.db
      .select({ channelId: userChannelGrants.channelId })
      .from(userChannelGrants)
      .innerJoin(channels, eq(channels.id, userChannelGrants.channelId))
      .where(and(eq(userChannelGrants.userId, userId), isNull(channels.deletedAt), eq(channels.isPublic, false)));
  }

  async deleteChannel(principal: Principal, channelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [channel] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .for('update');
      if (!channel) throw new TRPCError({ code: 'NOT_FOUND', message: '渠道不存在或已删除' });
      const [reference] = await tx
        .select({ name: channels.name })
        .from(aggregateChannelMembers)
        .innerJoin(channels, eq(channels.id, aggregateChannelMembers.aggregateChannelId))
        .where(and(eq(aggregateChannelMembers.memberChannelId, channelId), isNull(channels.deletedAt)))
        .limit(1);
      if (reference)
        throw new TRPCError({ code: 'CONFLICT', message: `请先从聚合渠道「${reference.name}」移除此子渠道` });
      if (channel.subscriptionAccountId) await this.subscription.removeAccount(tx, channel.subscriptionAccountId);
      await tx.delete(aggregateChannelMembers).where(eq(aggregateChannelMembers.aggregateChannelId, channelId));
      await tx.update(channels).set({ deletedAt: new Date(), enabled: false }).where(eq(channels.id, channel.id));
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

  async setGrants(principal: Principal, userId: string, channelIds: string[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user?.role !== 'user' || user.deletedAt)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '仅为未删除的普通用户设置渠道授权' });
      const ids = [...new Set(channelIds)];
      if (
        ids.length &&
        (
          await tx
            .select({ id: channels.id })
            .from(channels)
            .where(and(inArray(channels.id, ids), isNull(channels.deletedAt), eq(channels.isPublic, false)))
            .for('share')
        ).length !== ids.length
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: '渠道不存在或已公开' });
      await tx.delete(userChannelGrants).where(eq(userChannelGrants.userId, userId));
      if (ids.length) await tx.insert(userChannelGrants).values(ids.map((channelId) => ({ userId, channelId })));
      await this.audit(tx, actor.id, 'user.channels', userId, { channelIds: ids });
      return { success: true };
    });
  }
}
