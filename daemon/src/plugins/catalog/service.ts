import { serviceToken } from '@fraqjs/kernel';
import { isGeminiPathModel } from '@ohmyapi/protocols';
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import { type EventLogger, errorDetails, formatEvent } from '../../core/logging.ts';
import { formatMoney, parseMoney } from '../../core/money.ts';
import type { CredentialVault } from '../../core/vault.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Database, Transaction } from '../database/client.ts';
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
  type ReasoningEffortRule,
  subscriptionAccounts,
} from '../database/schema/index.ts';
import { channelProxy } from '../outbound/channel-proxy.ts';
import type { OutboundHttp } from '../outbound/index.ts';
import { providerSupports } from '../subscription/providers.ts';
import type { SubscriptionService } from '../subscription/service.ts';
import { auditCatalog } from './audit.ts';
import type { ChannelConcurrency } from './concurrency.ts';
import { compareChannels } from './order.ts';
import type { ChannelInput, FetchChannelModelsInput } from './schemas.ts';
import { fetchUpstreamModels, type UpstreamModelsTrace } from './upstream-models.ts';

type Channel = typeof channels.$inferSelect;
type ConfiguredModel = {
  name: string;
  multiplier: string | null;
  upstreamModel: string | null;
  reasoningEffortRules: ReasoningEffortRule[];
};

export class CatalogService {
  static readonly token = serviceToken<CatalogService>('ohmyapi/catalog');
  private readonly db: Database;
  private readonly auth: AuthService;
  private readonly vault: CredentialVault;
  private readonly subscription: SubscriptionService;
  private readonly outbound: OutboundHttp;
  private readonly concurrency: ChannelConcurrency;
  private readonly logger: EventLogger;
  constructor(deps: {
    db: Database;
    auth: AuthService;
    vault: CredentialVault;
    subscription: SubscriptionService;
    outbound: OutboundHttp;
    concurrency: ChannelConcurrency;
    logger: EventLogger;
  }) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.vault = deps.vault;
    this.subscription = deps.subscription;
    this.outbound = deps.outbound;
    this.concurrency = deps.concurrency;
    this.logger = deps.logger;
  }

  async list() {
    const [channelRows, modelRows, channelScopes, available, rewrites, activePrices, members] = await Promise.all([
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
          maxConcurrent: channels.maxConcurrent,
          multiplierMicros: channels.multiplierMicros,
        })
        .from(channels)
        .leftJoin(subscriptionAccounts, eq(channels.subscriptionAccountId, subscriptionAccounts.id))
        .where(isNull(channels.deletedAt)),
      this.db.select().from(models).where(isNull(models.deletedAt)).orderBy(asc(models.name)),
      this.db.select().from(effectiveChannelEndpoints),
      this.db.select().from(effectiveChannelModels),
      this.db
        .select({
          channelId: channelAvailableModels.channelId,
          modelId: channelAvailableModels.modelId,
          upstreamModel: channelAvailableModels.upstreamModel,
          reasoningEffortRules: channelAvailableModels.reasoningEffortRules,
        })
        .from(channelAvailableModels)
        .where(
          or(
            isNotNull(channelAvailableModels.upstreamModel),
            sql`${channelAvailableModels.reasoningEffortRules} <> '[]'::jsonb`,
          ),
        ),
      this.db.select({ modelId: priceRules.modelId }).from(priceRules).where(eq(priceRules.kind, 'default')),
      this.db.select().from(aggregateChannelMembers),
    ]);
    channelRows.sort(compareChannels);
    return {
      channels: channelRows.map(({ multiplierMicros, proxyUrlEncrypted, ...c }) => ({
        ...c,
        proxyUrl: proxyUrlEncrypted ? this.vault.decrypt(proxyUrlEncrypted) : null,
        active: c.type === 'api' ? this.concurrency.active(c.id) : 0,
        subscription: c.subscription
          ? {
              provider: c.subscription.provider,
              email: this.subscription.accountEmail(c.subscription.credentialEncrypted, c.subscription.provider),
              maxConcurrent: c.subscription.maxConcurrent,
              expiresAt: c.subscription.expiresAt.toISOString(),
              errorCode: c.subscription.errorCode,
              cooldownUntil: c.subscription.cooldownUntil?.toISOString() ?? null,
              modelCooldowns: c.subscription.modelCooldowns,
              active: this.subscription.activeRequests(c.subscription.id),
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
          .map((a) => {
            const rewrite = rewrites.find((r) => r.channelId === a.channelId && r.modelId === a.modelId);
            return {
              modelId: a.modelId,
              multiplier: a.multiplierMicros === null ? null : formatMoney(a.multiplierMicros),
              upstreamModel: rewrite?.upstreamModel ?? null,
              reasoningEffortRules: rewrite?.reasoningEffortRules ?? [],
            };
          }),
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
    const signal = AbortSignal.timeout(20_000);
    const trace: UpstreamModelsTrace = { stage: 'fetch', format: 'openai', bytes: 0 };
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof fetchUpstreamModels>>;
    try {
      result = await fetchUpstreamModels(request, input.baseUrl, credential, signal, trace);
    } catch (error) {
      this.logger.warn(
        formatEvent('上游模型列表获取失败', {
          actorId: principal.user.id,
          channelId: input.id,
          stage: trace.stage,
          format: trace.format,
          timedOut: signal.aborted,
          httpStatus: trace.httpStatus,
          durationMs: Date.now() - startedAt,
          responseBytes: trace.bytes,
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
        modelCount: result.names.length,
        ignored: result.ignored,
        durationMs: Date.now() - startedAt,
      }),
    );
    return result;
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
      // 未提交模型列表、上游名称或推理强度规则时沿用已有配置；透传倍率的聚合渠道不单独配置模型。
      const previous = existing ? await this.configuredModels(tx, existing.id) : [];
      const configuredModels = passthrough
        ? []
        : (input.availableModels?.map((model) => {
            const before = previous.find((entry) => entry.name === model.name);
            const upstreamModel =
              model.upstreamModel === undefined ? (before?.upstreamModel ?? null) : model.upstreamModel;
            return {
              name: model.name,
              multiplier: model.multiplier,
              upstreamModel: upstreamModel === model.name ? null : upstreamModel,
              reasoningEffortRules: model.reasoningEffortRules ?? before?.reasoningEffortRules ?? [],
            };
          }) ?? previous);
      const aggregateModels = await this.validateChannelType(tx, input, existing, configuredModels);
      const [duplicate] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.name, input.name), isNull(channels.deletedAt)));
      if (duplicate && duplicate.id !== input.id) throw new AppError('conflict', '渠道名称已存在');
      const names = (input.type === 'aggregate' ? aggregateModels : configuredModels).map((m) => m.name).sort();
      const resolved = await this.ensureModels(tx, actor.id, names, input.type !== 'aggregate');
      const available = resolved.map((model) => {
        const configured = configuredModels.find((row) => row.name === model.name);
        return {
          modelId: model.id,
          multiplier: configured?.multiplier ?? null,
          upstreamModel: configured?.upstreamModel ?? null,
          reasoningEffortRules: configured?.reasoningEffortRules ?? [],
        };
      });
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
      const values = this.channelValues(input, existing, pricingMode, subscriptionAccountId);
      const row = await this.writeChannel(tx, existing, values, input, available, passthrough);
      await auditCatalog(tx, actor.id, 'channel.save', row.id, {
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
        maxConcurrent: input.type === 'api' ? values.maxConcurrent : input.subscription?.maxConcurrent,
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

  private async configuredModels(tx: Transaction, channelId: string): Promise<ConfiguredModel[]> {
    const rows = await tx
      .select({
        name: models.name,
        multiplierMicros: channelAvailableModels.multiplierMicros,
        upstreamModel: channelAvailableModels.upstreamModel,
        reasoningEffortRules: channelAvailableModels.reasoningEffortRules,
      })
      .from(channelAvailableModels)
      .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
      .where(and(eq(channelAvailableModels.channelId, channelId), isNull(models.deletedAt)));
    return rows.map((model) => ({
      name: model.name,
      multiplier: model.multiplierMicros === null ? null : formatMoney(model.multiplierMicros),
      upstreamModel: model.upstreamModel,
      reasoningEffortRules: model.reasoningEffortRules,
    }));
  }

  /** 按渠道类型校验连接、端点和子渠道；聚合渠道返回子渠道的共同模型。 */
  private async validateChannelType(
    tx: Transaction,
    input: ChannelInput,
    existing: Channel | undefined,
    configuredModels: ConfiguredModel[],
  ) {
    if (input.type === 'aggregate' && configuredModels.some((model) => model.upstreamModel !== null))
      throw new AppError('bad_request', '聚合渠道的上游模型名由子渠道配置');
    if (input.type === 'aggregate' && configuredModels.some((model) => model.reasoningEffortRules.length))
      throw new AppError('bad_request', '聚合渠道的推理强度映射由子渠道配置');
    // Gemini 端点的模型名位于上游路径中。
    const pathless = input.endpoints.includes('/v1beta/generateContent')
      ? configuredModels.find((model) => model.upstreamModel !== null && !isGeminiPathModel(model.upstreamModel))
      : undefined;
    if (pathless)
      throw new AppError(
        'bad_request',
        `支持 Gemini 端点的渠道，上游模型名只能包含字母、数字、_、- 和 .：${pathless.upstreamModel}`,
      );
    if (existing && existing.type !== input.type)
      throw new AppError('bad_request', '渠道类型创建后不可更改，请新建渠道');
    if (input.type !== 'aggregate' && (!input.endpoints.length || input.members.length))
      throw new AppError('bad_request', '普通渠道需配置端点，且不能配置子渠道');
    if (input.type !== 'api' && input.maxConcurrent != null)
      throw new AppError('bad_request', '只有 API 渠道可以设置渠道并发上限');
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
      if (children.length !== memberIds.length) throw new AppError('bad_request', '子渠道不存在、已删除或属于聚合类型');
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
        memberIds.every((id) => childEndpoints.some((entry) => entry.channelId === id && entry.endpoint === endpoint)),
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
      const { provider } = input.subscription;
      if (input.endpoints.some((endpoint) => !providerSupports(provider, endpoint)))
        throw new AppError(
          'bad_request',
          {
            openai: 'OpenAI 订阅渠道仅支持 Responses 和 compact',
            claude: 'Claude 订阅渠道仅支持 Messages',
            antigravity: 'Antigravity 订阅渠道仅支持 Gemini 端点',
          }[provider],
        );
    }
    return aggregateModels;
  }

  /** 解析模型名称；普通渠道引用的新模型先以默认上限创建占位记录。 */
  private async ensureModels(tx: Transaction, actorId: string, names: string[], createMissing: boolean) {
    if (names.length && createMissing) {
      const created = await tx
        .insert(models)
        .values(names.map((name) => ({ name, inputTokenLimit: 1_000_000, outputTokenLimit: 128_000 })))
        .onConflictDoNothing({ target: models.name, where: isNull(models.deletedAt) })
        .returning({ id: models.id, name: models.name });
      for (const model of created)
        await auditCatalog(tx, actorId, 'model.placeholder', model.id, {
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
    return resolved;
  }

  /** 渠道字段：加密凭据和代理地址，未修改时保留原有密文。 */
  private channelValues(
    input: ChannelInput,
    existing: Channel | undefined,
    pricingMode: Channel['pricingMode'],
    subscriptionAccountId: string | null,
  ) {
    const passthrough = pricingMode === 'passthrough';
    let proxyUrlEncrypted = existing?.proxyUrlEncrypted ?? null;
    if (input.type === 'aggregate' || input.proxyUrl === null) {
      proxyUrlEncrypted = null;
    } else if (
      input.proxyUrl !== undefined &&
      (!proxyUrlEncrypted || this.vault.decrypt(proxyUrlEncrypted) !== input.proxyUrl)
    ) {
      proxyUrlEncrypted = this.vault.encrypt(input.proxyUrl);
    }
    return {
      name: input.name,
      type: input.type,
      pricingMode,
      baseUrl: input.type === 'api' ? input.baseUrl?.replace(/\/+$/, '') : null,
      proxyUrlEncrypted,
      subscriptionAccountId,
      enabled: input.enabled,
      isPublic: input.isPublic,
      timeoutMs: input.timeoutMs,
      // 未提交时沿用已有配置，null 表示不限。
      maxConcurrent:
        input.type !== 'api'
          ? null
          : input.maxConcurrent === undefined
            ? (existing?.maxConcurrent ?? null)
            : input.maxConcurrent,
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
  }

  /** 写入渠道及其端点、子渠道和可用模型。 */
  private async writeChannel(
    tx: Transaction,
    existing: Channel | undefined,
    values: ReturnType<CatalogService['channelValues']>,
    input: ChannelInput,
    available: {
      modelId: string;
      multiplier: string | null;
      upstreamModel: string | null;
      reasoningEffortRules: ReasoningEffortRule[];
    }[],
    passthrough: boolean,
  ) {
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
          upstreamModel: m.upstreamModel,
          reasoningEffortRules: m.reasoningEffortRules,
        })),
      );
    return row;
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
      await auditCatalog(tx, actor.id, 'channel.delete', channel.id, { name: channel.name });
      return { success: true };
    });
  }
}
