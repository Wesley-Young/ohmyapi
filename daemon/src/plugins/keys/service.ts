import { serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, gt, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import { formatMoney } from '../../core/money.js';
import { toPage } from '../../core/pagination.js';
import { recordAudit } from '../auth/audit.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { Database, Transaction } from '../database/client.js';
import { activeApiKey, activeChannel, activeModel, paginate } from '../database/query.js';
import {
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  effectiveChannelModels as channelAvailableModels,
  effectiveChannelEndpoints as channelEndpoints,
  channelModelPrices,
  channels,
  models,
  priceRules,
  requests,
  userChannelGrants,
} from '../database/schema/index.js';
import { availableSubscription } from '../subscription/availability.js';
import type { CreateKeyInput, UpdateKeyInput } from './schemas.js';

import { randomBytes } from 'node:crypto';

export class KeyService {
  static readonly token = serviceToken<KeyService>('ohmyapi/keys');
  private readonly db: Database;
  private readonly auth: AuthService;
  constructor({ db, auth }: { db: Database; auth: AuthService }) {
    this.db = db;
    this.auth = auth;
  }

  async availableModels(principal: Principal) {
    if (principal.user.role === 'admin')
      return this.db
        .select({ id: models.id, name: models.name })
        .from(models)
        .where(activeModel())
        .orderBy(models.name);
    const offerings = await this.offerings(principal.user);
    return [...new Map(offerings.map((row) => [row.modelId, { id: row.modelId, name: row.modelName }])).values()].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
  }

  /** 用户可调用的渠道、模型和端点组合；在事务中调用时传入 tx 以读取一致的授权状态。 */
  async offerings({ id: userId, role }: { id: string; role: string }, db: Database | Transaction = this.db) {
    const allowed =
      role === 'admin' ? undefined : or(eq(channels.isPublic, true), eq(userChannelGrants.userId, userId));
    const base = db
      .selectDistinct({
        channelId: channels.id,
        channelName: channels.name,
        multiplierMicros: channelModelPrices.multiplierMicros,
        pricingMode: channels.pricingMode,
        endpoint: channelEndpoints.endpoint,
        inputTokenLimit: models.inputTokenLimit,
        outputTokenLimit: models.outputTokenLimit,
        modelId: models.id,
        modelName: models.name,
      })
      .from(channels)
      .innerJoin(channelAvailableModels, eq(channels.id, channelAvailableModels.channelId))
      .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
      .innerJoin(
        channelModelPrices,
        and(eq(channelModelPrices.channelId, channels.id), eq(channelModelPrices.modelId, models.id)),
      )
      .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
      .leftJoin(
        userChannelGrants,
        and(eq(userChannelGrants.channelId, channels.id), eq(userChannelGrants.userId, userId)),
      )
      .where(and(activeChannel(), availableSubscription(), activeModel(), allowed))
      .orderBy(channels.name, models.name);
    const rows = await base;
    const ranges = new Map<string, (typeof rows)[number] & { maxMultiplierMicros: bigint }>();
    for (const row of rows) {
      const key = `${row.channelId}:${row.modelId}:${row.endpoint}`;
      const previous = ranges.get(key);
      if (!previous) ranges.set(key, { ...row, maxMultiplierMicros: row.multiplierMicros });
      else {
        if (row.multiplierMicros < previous.multiplierMicros) previous.multiplierMicros = row.multiplierMicros;
        if (row.multiplierMicros > previous.maxMultiplierMicros) previous.maxMultiplierMicros = row.multiplierMicros;
      }
    }
    return [...ranges.values()];
  }

  async availableChannels(principal: Principal) {
    const rows = await this.offerings(principal.user);
    return [...new Set(rows.map((r) => r.channelId))].map((id) => {
      const filteredRows = rows.filter((r) => r.channelId === id);
      return {
        id,
        name: filteredRows[0].channelName,
        endpoints: [...new Set(filteredRows.map((r) => r.endpoint))],
        models: [...new Map(filteredRows.map((r) => [r.modelId, { id: r.modelId, name: r.modelName }])).values()],
      };
    });
  }

  async playgroundOptions(principal: Principal) {
    const rows = await this.db
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
          activeApiKey(),
          inArray(channelEndpoints.endpoint, ['/v1/chat/completions', '/v1/responses', '/v1/messages']),
          activeChannel(),
          availableSubscription(),
          activeModel(),
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
      if (!key) throw new AppError('not_found', 'Key 不存在');
      if (key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()))
        throw new AppError('bad_request', 'Key 已失效');
      const [existing] = await tx.select().from(apiKeyChannels).where(eq(apiKeyChannels.apiKeyId, keyId));
      if (existing) throw new AppError('conflict', 'Key 已绑定渠道，请通过编辑修改');
      const offerings = await this.offerings(user, tx);
      if (!offerings.some((o) => o.channelId === channelId))
        throw new AppError('forbidden', '渠道不可用、未授权或没有可用模型');
      await tx.insert(apiKeyChannels).values({ apiKeyId: keyId, channelId });
      return { success: true };
    });
  }

  async list(principal: Principal, page: number) {
    const userId = principal.user.id;
    const [offerings, rows] = await Promise.all([
      this.offerings(principal.user),
      paginate(
        this.db
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
          .$dynamic(),
        page,
      ),
    ]);
    const { items, hasMore } = toPage(rows);
    const keyIds = items.map((key) => key.id);
    const settled = (window: SQL) =>
      sql<string>`coalesce(sum(${requests.chargedMicros}) filter (where ${requests.status} = 'settled' and ${requests.receivedAt} >= now() - ${window}), 0)::text`;
    const [grants, usage] = items.length
      ? await Promise.all([
          this.db
            .select({ keyId: apiKeyModelGrants.apiKeyId, id: models.id, name: models.name })
            .from(apiKeyModelGrants)
            .innerJoin(models, eq(models.id, apiKeyModelGrants.modelId))
            .where(inArray(apiKeyModelGrants.apiKeyId, keyIds)),
          this.db
            .select({
              keyId: requests.apiKeyId,
              last24Hours: settled(sql`interval '24 hours'`),
              last30Days: settled(sql`interval '30 days'`),
            })
            .from(requests)
            .where(
              and(
                eq(requests.userId, userId),
                inArray(requests.apiKeyId, keyIds),
                sql`${requests.receivedAt} >= now() - interval '30 days' and ${requests.receivedAt} <= now()`,
              ),
            )
            .groupBy(requests.apiKeyId),
        ])
      : [[], []];
    const usageByKey = new Map(usage.map((row) => [row.keyId, row]));
    // CC Switch export needs an available channel that serves more than the Anthropic Messages endpoint.
    const exportableChannels = new Set(
      offerings.filter((row) => row.endpoint !== '/v1/messages').map((row) => row.channelId),
    );
    return {
      items: items.map((key) => ({
        ...key,
        exportable: !key.revokedAt && key.channelId !== null && exportableChannels.has(key.channelId),
        expiresAt: key.expiresAt?.toISOString() ?? null,
        revokedAt: key.revokedAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
        modelNames: grants.filter((grant) => grant.keyId === key.id).map((grant) => grant.name),
        modelIds: grants.filter((grant) => grant.keyId === key.id).map((grant) => grant.id),
        chargedAmount24h: formatMoney(BigInt(usageByKey.get(key.id)?.last24Hours ?? 0)),
        chargedAmount30d: formatMoney(BigInt(usageByKey.get(key.id)?.last30Days ?? 0)),
      })),
      hasMore,
    };
  }

  async create(principal: Principal, input: CreateKeyInput) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
      if (expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError('bad_request', '有效期必须晚于当前时间');
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, user.id), activeApiKey()));
      if (count >= 100) throw new AppError('bad_request', '最多保留 100 个有效 Key');
      const modelIds = [...new Set(input.modelIds ?? [])];
      const offerings = (await this.offerings(user, tx)).filter((o) => o.channelId === input.channelId);
      if (!offerings.length) throw new AppError('forbidden', '渠道不可用、未授权或没有可用模型');
      if (modelIds.some((id) => !offerings.some((o) => o.modelId === id)))
        throw new AppError('forbidden', '包含渠道不可用或未授权的模型');
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

  async update(principal: Principal, input: UpdateKeyInput) {
    return this.auth.authorized(principal, {}, async (tx, user) => {
      const [key] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.userId, user.id), isNull(apiKeys.deletedAt)))
        .for('update');
      if (!key) throw new AppError('not_found', 'Key 不存在或已删除');
      if (key.revokedAt) throw new AppError('bad_request', 'Key 已撤销');
      const now = new Date();
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && expiresAt <= now && expiresAt.getTime() !== key.expiresAt?.getTime())
        throw new AppError('bad_request', '有效期必须晚于当前时间');
      if (key.expiresAt && key.expiresAt <= now && (!expiresAt || expiresAt > now)) {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::integer` })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.userId, user.id),
              isNull(apiKeys.revokedAt),
              isNull(apiKeys.deletedAt),
              or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
            ),
          );
        if (count >= 100) throw new AppError('bad_request', '最多保留 100 个有效 Key');
      }
      const [binding] = await tx.select().from(apiKeyChannels).where(eq(apiKeyChannels.apiKeyId, key.id));
      const channelId = input.channelId ?? binding?.channelId;
      const channelChanged = channelId !== binding?.channelId;
      const modelIds =
        input.modelIds === undefined
          ? (await tx.select().from(apiKeyModelGrants).where(eq(apiKeyModelGrants.apiKeyId, key.id))).map(
              (grant) => grant.modelId,
            )
          : [...new Set(input.modelIds ?? [])];
      if (channelChanged || input.modelIds !== undefined) {
        const offerings = (await this.offerings(user, tx)).filter((o) => o.channelId === channelId);
        if (!offerings.length) throw new AppError('forbidden', '渠道不可用、未授权或没有可用模型');
        if (modelIds.some((id) => !offerings.some((o) => o.modelId === id)))
          throw new AppError('forbidden', '包含渠道不可用或未授权的模型，请重新选择');
      }
      await tx
        .update(apiKeys)
        .set({
          name: input.name,
          expiresAt,
          restrictModels: input.modelIds === undefined ? key.restrictModels : input.modelIds !== null,
        })
        .where(eq(apiKeys.id, key.id));
      if (channelChanged && channelId)
        await tx
          .insert(apiKeyChannels)
          .values({ apiKeyId: key.id, channelId })
          .onConflictDoUpdate({ target: apiKeyChannels.apiKeyId, set: { channelId } });
      if (input.modelIds !== undefined) {
        await tx.delete(apiKeyModelGrants).where(eq(apiKeyModelGrants.apiKeyId, key.id));
        if (modelIds.length)
          await tx.insert(apiKeyModelGrants).values(modelIds.map((modelId) => ({ apiKeyId: key.id, modelId })));
      }
      return { success: true };
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
      if (!key) throw new AppError('not_found', 'Key 不存在或已删除');
      await recordAudit(tx, {
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
