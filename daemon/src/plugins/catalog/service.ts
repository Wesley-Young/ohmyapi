import { serviceToken } from '@fraqjs/kernel';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../../core/errors.js';
import { type EventLogger, errorDetails, formatEvent } from '../../core/logging.js';
import { formatMoney, parseMoney } from '../../core/money.js';
import { toPage } from '../../core/pagination.js';
import type { CredentialVault } from '../../core/vault.js';
import { type AuditAction, recordAudit } from '../auth/audit.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { Database, Transaction } from '../database/client.js';
import { containsText, paginate } from '../database/query.js';
import {
  aggregateChannelMembers,
  channelAvailableModels,
  channelEndpoints,
  channels,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  endpoints,
  models,
  priceRules,
  subscriptionAccounts,
  userChannelGrants,
  users,
} from '../database/schema/index.js';
import type { OutboundHttp } from '../outbound/index.js';
import { expandRules, validateRules } from '../pricing/rules.js';
import type { SubscriptionService } from '../subscription/service.js';
import { channelProxy } from './proxy.js';
import {
  type ChannelInput,
  type FetchChannelModelsInput,
  type ImportModelsInput,
  type ModelInput,
  modelName,
} from './schemas.js';

export class CatalogService {
  static readonly token = serviceToken<CatalogService>('ohmyapi/catalog');
  private readonly db: Database;
  private readonly auth: AuthService;
  private readonly vault: CredentialVault;
  private readonly subscription: SubscriptionService;
  private readonly outbound: OutboundHttp;
  private readonly logger: EventLogger;
  constructor(deps: {
    db: Database;
    auth: AuthService;
    vault: CredentialVault;
    subscription: SubscriptionService;
    outbound: OutboundHttp;
    logger: EventLogger;
  }) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.vault = deps.vault;
    this.subscription = deps.subscription;
    this.outbound = deps.outbound;
    this.logger = deps.logger;
  }

  async list() {
    const [channelRows, modelRows, channelScopes, available, activePrices, members] = await Promise.all([
      this.db
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
            modelCooldowns: subscriptionAccounts.modelCooldowns,
          },
          baseUrl: channels.baseUrl,
          proxyUrlEncrypted: channels.proxyUrlEncrypted,
          enabled: channels.enabled,
          isPublic: channels.isPublic,
          timeoutMs: channels.timeoutMs,
          multiplierMicros: channels.multiplierMicros,
        })
        .from(channels)
        .leftJoin(subscriptionAccounts, eq(channels.subscriptionAccountId, subscriptionAccounts.id))
        .where(isNull(channels.deletedAt))
        .orderBy(asc(channels.name)),
      this.db.select().from(models).where(isNull(models.deletedAt)).orderBy(asc(models.name)),
      this.db.select().from(effectiveChannelEndpoints),
      this.db.select().from(effectiveChannelModels),
      this.db.select({ modelId: priceRules.modelId }).from(priceRules).where(eq(priceRules.kind, 'default')),
      this.db.select().from(aggregateChannelMembers),
    ]);
    return {
      channels: channelRows.map(({ multiplierMicros, proxyUrlEncrypted, ...c }) => ({
        ...c,
        proxyUrl: proxyUrlEncrypted ? this.vault.decrypt(proxyUrlEncrypted) : null,
        subscription: c.subscription
          ? {
              provider: c.subscription.provider,
              email: this.subscription.accountEmail(c.subscription.credentialEncrypted, c.subscription.provider),
              maxConcurrent: c.subscription.maxConcurrent,
              expiresAt: c.subscription.expiresAt.toISOString(),
              errorCode: c.subscription.errorCode,
              cooldownUntil: c.subscription.cooldownUntil?.toISOString() ?? null,
              modelCooldowns: c.subscription.modelCooldowns,
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
    action: AuditAction,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await recordAudit(tx, { actorId, action, targetType: 'catalog', targetId, metadata });
  }

  async fetchChannelModels(principal: Principal, input: FetchChannelModelsInput) {
    const credential = await this.auth.authorized(principal, { admin: true }, async (tx) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(channels)
            .where(and(eq(channels.id, input.id), isNull(channels.deletedAt)))
        : [];
      if (input.id && !existing) throw new AppError('not_found', '渠道不存在');
      if (existing && existing.type !== 'api') throw new AppError('bad_request', '该渠道类型暂不支持拉取模型');
      if (input.credential) return input.credential;
      if (existing?.credentialEncrypted) return this.vault.decrypt(existing.credentialEncrypted);
      throw new AppError('bad_request', '请先填写上游凭据');
    });
    const proxyUrl = await channelProxy(this.auth, this.vault, principal, input.id, input.proxyUrl);
    const request = this.outbound.forProxy(proxyUrl);
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
        const response = await request(url, {
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
          throw new AppError(
            'bad_request',
            response.status === 404
              ? '上游不支持模型列表，请手动添加模型'
              : `获取模型失败，上游返回 HTTP ${response.status}，请检查地址和凭据`,
          );
        }
        stage = 'read_body';
        const reader = response.body?.getReader();
        if (!reader) throw new AppError('bad_request', '上游返回了空的模型列表');
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2 * 1024 * 1024) {
              stage = 'response_too_large';
              throw new AppError('bad_request', '上游模型列表过大');
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
        if (!page.success) throw new AppError('bad_request', '上游模型列表格式无效，请手动添加模型');
        for (const model of page.data.data) {
          const parsed = modelName.safeParse(model.id);
          if (parsed.success) names.add(parsed.data);
          else ignored++;
        }
        if (names.size > 1000) throw new AppError('bad_request', '每个渠道最多添加 1000 个模型');
        if (!page.data.has_more) break;
        const cursor = page.data.last_id;
        stage = 'pagination';
        if (!cursor || cursors.has(cursor)) throw new AppError('bad_request', '上游模型列表分页无效');
        cursors.add(cursor);
        url.searchParams.set('after_id', cursor);
      }
      stage = 'empty_models';
      if (!names.size) throw new AppError('bad_request', '上游未返回有效模型，请手动添加模型');
    } catch (error) {
      this.logger.warn(
        formatEvent('上游模型列表获取失败', {
          actorId: principal.user.id,
          channelId: input.id,
          stage,
          timedOut: signal.aborted,
          httpStatus,
          durationMs: Date.now() - startedAt,
          responseBytes: bytes,
          ...errorDetails(error),
        }),
      );
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', '无法获取上游模型，请检查地址、凭据和连接后重试');
    }
    this.logger.info(
      formatEvent('上游模型列表获取完成', {
        actorId: principal.user.id,
        channelId: input.id,
        modelCount: names.size,
        ignored,
        durationMs: Date.now() - startedAt,
      }),
    );
    return { names: [...names].sort(), ignored };
  }

  async saveChannel(principal: Principal, input: ChannelInput) {
    const credentials =
      input.type === 'subscription' && input.subscription
        ? await this.subscription.prepareCredentials(
            principal,
            input.subscription,
            await channelProxy(this.auth, this.vault, principal, input.id, input.proxyUrl),
          )
        : undefined;
    const result = await this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(channels)
            .where(and(eq(channels.id, input.id), isNull(channels.deletedAt)))
            .for('update')
        : [];
      if (input.id && !existing) throw new AppError('not_found', '渠道不存在');
      const pricingMode = input.pricingMode ?? existing?.pricingMode ?? 'unified';
      if (input.type !== 'aggregate' && pricingMode !== 'unified')
        throw new AppError('bad_request', '仅聚合渠道支持透传倍率');
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
        throw new AppError('bad_request', '渠道类型创建后不可更改，请新建渠道');
      if (input.type !== 'aggregate' && (!input.endpoints.length || input.members.length))
        throw new AppError('bad_request', '普通渠道需配置端点，且不能配置子渠道');
      let aggregateModels: { id: string; name: string }[] = [];
      if (input.type === 'aggregate') {
        if (input.baseUrl || input.credential || input.subscription || input.endpoints.length || input.proxyUrl)
          throw new AppError('bad_request', '聚合渠道的连接和端点由子渠道提供');
        if (!input.members.length || input.members.some((member) => member.channelId === input.id))
          throw new AppError('bad_request', '至少选择一个子渠道，且不能引用自身');
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
          throw new AppError('bad_request', '子渠道不存在、已删除或属于聚合类型');
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
          throw new AppError('bad_request', '子渠道需至少有一个共同模型和共同端点');
        if (
          input.availableModels &&
          configuredModels.some((model) => !aggregateModels.some((common) => common.name === model.name))
        )
          throw new AppError('bad_request', '只能为子渠道的共同模型设置倍率，请刷新后重试');
      } else if (input.type === 'api') {
        if (!input.baseUrl || (!existing && !input.credential))
          throw new AppError('bad_request', '请填写 Base URL 和上游凭据');
        if (input.subscription) throw new AppError('bad_request', 'API 渠道不能配置订阅凭据');
      } else {
        if (!input.subscription) throw new AppError('bad_request', '请填写订阅配置');
        if (input.baseUrl || input.credential)
          throw new AppError('bad_request', '订阅渠道使用账号凭据，无需填写 API 连接信息');
        const allowed =
          input.subscription.provider === 'claude' ? ['/v1/messages'] : ['/v1/responses', '/v1/responses/compact'];
        if (input.endpoints.some((endpoint) => !allowed.includes(endpoint)))
          throw new AppError(
            'bad_request',
            input.subscription.provider === 'claude'
              ? 'Claude 订阅渠道仅支持 Messages'
              : 'OpenAI 订阅渠道仅支持 Responses 和 compact',
          );
      }
      const [duplicate] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.name, input.name), isNull(channels.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new AppError('conflict', '渠道名称已存在');
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
      if (resolved.length !== names.length) throw new AppError('conflict', '模型已变更，请重试');
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
                provider: input.subscription.provider,
              },
              credentials,
            )
          : null;
      let proxyUrlEncrypted = existing?.proxyUrlEncrypted ?? null;
      if (input.type === 'aggregate' || input.proxyUrl === null) {
        proxyUrlEncrypted = null;
      } else if (
        input.proxyUrl !== undefined &&
        (!proxyUrlEncrypted || this.vault.decrypt(proxyUrlEncrypted) !== input.proxyUrl)
      ) {
        proxyUrlEncrypted = this.vault.encrypt(input.proxyUrl);
      }
      const values = {
        name: input.name,
        type: input.type,
        pricingMode,
        baseUrl: input.type === 'api' ? input.baseUrl?.replace(/\/+$/, '') : null,
        proxyUrlEncrypted,
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
        proxyChanged: values.proxyUrlEncrypted !== (existing?.proxyUrlEncrypted ?? null),
        proxyEnabled: Boolean(values.proxyUrlEncrypted),
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
      this.subscription.consumeAuthorization(principal, input.subscription.callbackUrl, input.subscription.provider);
    return result;
  }

  async saveModel(principal: Principal, input: ModelInput) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [existing] = input.id
        ? await tx
            .select()
            .from(models)
            .where(and(eq(models.id, input.id), isNull(models.deletedAt)))
            .for('update')
        : [];
      if (input.id && !existing) throw new AppError('not_found', '模型不存在');
      const [duplicate] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.name, input.name), isNull(models.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new AppError('conflict', '模型名称已存在');
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

  async importModels(principal: Principal, input: ImportModelsInput) {
    const prepared = input.models
      .map((entry) => {
        const rules = expandRules(entry.rules);
        try {
          validateRules(rules);
        } catch (error) {
          throw new AppError('bad_request', `${entry.model.name}：${(error as Error).message}`);
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
    return this.db
      .select({ channelId: userChannelGrants.channelId })
      .from(userChannelGrants)
      .innerJoin(channels, eq(channels.id, userChannelGrants.channelId))
      .where(and(eq(userChannelGrants.userId, userId), isNull(channels.deletedAt), eq(channels.isPublic, false)));
  }

  async channelGrants(channelId: string, page: number, search: string) {
    const [channel] = await this.db
      .select({ isPublic: channels.isPublic })
      .from(channels)
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    if (!channel) throw new AppError('not_found', '渠道不存在或已删除');
    if (channel.isPublic) throw new AppError('bad_request', '公开渠道默认对所有用户开放');
    const rows = await paginate(
      this.db
        .select({
          id: users.id,
          username: users.username,
          status: users.status,
          granted: sql<boolean>`${userChannelGrants.userId} is not null`,
        })
        .from(users)
        .leftJoin(
          userChannelGrants,
          and(eq(userChannelGrants.userId, users.id), eq(userChannelGrants.channelId, channelId)),
        )
        .where(and(eq(users.role, 'user'), isNull(users.deletedAt), containsText(users.username, search)))
        .orderBy(asc(users.username), asc(users.id))
        .$dynamic(),
      page,
    );
    return toPage(rows);
  }

  async setChannelGrants(principal: Principal, channelId: string, grants: { userId: string; granted: boolean }[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const userIds = grants.map((grant) => grant.userId).sort();
      const validUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, userIds), eq(users.role, 'user'), isNull(users.deletedAt)))
        .orderBy(asc(users.id))
        .for('update');
      if (validUsers.length !== userIds.length) throw new AppError('bad_request', '仅为未删除的普通用户设置渠道授权');
      const [channel] = await tx
        .select({ isPublic: channels.isPublic })
        .from(channels)
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .for('share');
      if (!channel) throw new AppError('not_found', '渠道不存在或已删除');
      if (channel.isPublic) throw new AppError('bad_request', '公开渠道默认对所有用户开放');
      const revokedIds = grants.filter((grant) => !grant.granted).map((grant) => grant.userId);
      if (revokedIds.length)
        await tx
          .delete(userChannelGrants)
          .where(and(eq(userChannelGrants.channelId, channelId), inArray(userChannelGrants.userId, revokedIds)));
      const grantedUsers = grants.filter((grant) => grant.granted);
      if (grantedUsers.length)
        await tx
          .insert(userChannelGrants)
          .values(grantedUsers.map(({ userId }) => ({ userId, channelId })))
          .onConflictDoNothing();
      await this.audit(tx, actor.id, 'channel.users', channelId, { grants });
      return { success: true };
    });
  }

  async deleteChannel(principal: Principal, channelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [channel] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .for('update');
      if (!channel) throw new AppError('not_found', '渠道不存在或已删除');
      const [reference] = await tx
        .select({ name: channels.name })
        .from(aggregateChannelMembers)
        .innerJoin(channels, eq(channels.id, aggregateChannelMembers.aggregateChannelId))
        .where(and(eq(aggregateChannelMembers.memberChannelId, channelId), isNull(channels.deletedAt)))
        .limit(1);
      if (reference) throw new AppError('conflict', `请先从聚合渠道「${reference.name}」移除此子渠道`);
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
      if (!model) throw new AppError('not_found', '模型不存在或已删除');
      await this.audit(tx, actor.id, 'model.delete', model.id, { name: model.name });
      return { success: true };
    });
  }

  async setGrants(principal: Principal, userId: string, channelIds: string[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user?.role !== 'user' || user.deletedAt)
        throw new AppError('bad_request', '仅为未删除的普通用户设置渠道授权');
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
        throw new AppError('bad_request', '渠道不存在或已公开');
      await tx.delete(userChannelGrants).where(eq(userChannelGrants.userId, userId));
      if (ids.length) await tx.insert(userChannelGrants).values(ids.map((channelId) => ({ userId, channelId })));
      await this.audit(tx, actor.id, 'user.channels', userId, { channelIds: ids });
      return { success: true };
    });
  }
}
