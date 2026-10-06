import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import { formatMoney, parseMoney } from '../billing/conventions.js';
import {
  expandRules,
  multiplierInput,
  type Quantities,
  quote,
  type Rule,
  ruleInput,
  tokenInput,
  validatePublication,
} from '../billing/pricing.js';
import {
  adminAuditLogs,
  channelAvailableModels,
  channels,
  modelEndpoints,
  models,
  priceRules,
  priceVersions,
  systemSettings,
} from '../db/schema/index.js';
import type { AuthService, Principal, Transaction } from './auth.js';
import { type Endpoint, endpoints } from './catalog.js';

export const priceScope = z.object({ modelId: z.uuid(), endpoint: z.enum(endpoints) });
export const savePriceInput = z.object({ versionId: z.uuid(), rules: z.array(ruleInput).max(200) });
export const previewInput = priceScope.extend({
  versionId: z.uuid().optional(),
  channelId: z.uuid().optional(),
  at: z.iso.datetime({ offset: true }),
  inputTokens: tokenInput,
  outputTokens: tokenInput,
  cacheReadTokens: tokenInput,
  cacheWriteTokens: tokenInput,
  multiplier: multiplierInput.optional(),
});
const serializeRule = (r: typeof priceRules.$inferSelect) => ({
  id: r.id,
  label: r.label,
  kind: r.kind,
  contextMin: r.contextMin?.toString() ?? null,
  contextMax: r.contextMax?.toString() ?? null,
  weekdaysMask: r.weekdaysMask,
  startMinute: r.startMinute,
  endMinute: r.endMinute,
  inputPrice: formatMoney(r.inputPriceMicros),
  outputPrice: formatMoney(r.outputPriceMicros),
  cacheReadPrice: r.cacheReadPriceMicros === null ? null : formatMoney(r.cacheReadPriceMicros),
  cacheWritePrice: r.cacheWritePriceMicros === null ? null : formatMoney(r.cacheWritePriceMicros),
});
export type LockedPrice = {
  versionId: string;
  version: number;
  rules: Rule[];
  multiplierMicros: bigint;
  multiplierSource: 'model' | 'channel';
  receivedAt: Date;
};

export class PricingService {
  static readonly token = serviceToken<PricingService>('ohmyapi/pricing');
  private readonly auth: AuthService;
  readonly currency: string;
  constructor(auth: AuthService, currency: string) {
    this.auth = auth;
    this.currency = currency;
  }
  async list(scope: z.infer<typeof priceScope>) {
    const versions = await this.auth.db
      .select()
      .from(priceVersions)
      .where(and(eq(priceVersions.modelId, scope.modelId), eq(priceVersions.endpoint, scope.endpoint)))
      .orderBy(desc(priceVersions.version))
      .limit(100);
    const rules = versions.length
      ? await this.auth.db
          .select()
          .from(priceRules)
          .where(
            inArray(
              priceRules.priceVersionId,
              versions.map((v) => v.id),
            ),
          )
          .orderBy(priceRules.createdAt, priceRules.id)
      : [];
    const displayOrder = ['default', 'context', 'time', 'combined'];
    rules.sort(
      (a, b) =>
        displayOrder.indexOf(a.kind) - displayOrder.indexOf(b.kind) ||
        a.label.localeCompare(b.label, 'zh-CN') ||
        (a.weekdaysMask ?? 0) - (b.weekdaysMask ?? 0) ||
        (a.startMinute ?? 0) - (b.startMinute ?? 0),
    );
    const [settings] = await this.auth.db.select({ currency: systemSettings.currency }).from(systemSettings);
    return {
      currency: settings.currency,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        effectiveAt: v.effectiveAt?.toISOString() ?? null,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        rules: rules.filter((r) => r.priceVersionId === v.id).map(serializeRule),
      })),
    };
  }
  async createDraft(principal: Principal, scope: z.infer<typeof priceScope> & { sourceVersionId?: string }) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [model] = await tx.select().from(models).where(eq(models.id, scope.modelId)).for('update');
      const [endpoint] = await tx
        .select()
        .from(modelEndpoints)
        .where(and(eq(modelEndpoints.modelId, scope.modelId), eq(modelEndpoints.endpoint, scope.endpoint)));
      if (!model || !endpoint) throw new TRPCError({ code: 'BAD_REQUEST', message: '模型未声明此端点' });
      const [{ maximum }] = await tx
        .select({ maximum: sql<number>`coalesce(max(${priceVersions.version}), 0)::integer` })
        .from(priceVersions)
        .where(and(eq(priceVersions.modelId, scope.modelId), eq(priceVersions.endpoint, scope.endpoint)));
      let source: (typeof priceRules.$inferSelect)[] = [];
      if (scope.sourceVersionId) {
        const [version] = await tx
          .select()
          .from(priceVersions)
          .where(
            and(
              eq(priceVersions.id, scope.sourceVersionId),
              eq(priceVersions.modelId, scope.modelId),
              eq(priceVersions.endpoint, scope.endpoint),
            ),
          );
        if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: '来源版本不存在' });
        source = await tx.select().from(priceRules).where(eq(priceRules.priceVersionId, version.id));
      }
      const [version] = await tx
        .insert(priceVersions)
        .values({ modelId: scope.modelId, endpoint: scope.endpoint, version: maximum + 1, createdBy: actor.id })
        .returning({ id: priceVersions.id });
      if (source.length)
        await tx
          .insert(priceRules)
          .values(source.map(({ id: _id, createdAt: _time, ...r }) => ({ ...r, priceVersionId: version.id })));
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'price.create_draft',
        targetType: 'price_version',
        targetId: version.id,
        metadata: { ...scope, version: maximum + 1 },
      });
      return version;
    });
  }
  async saveDraft(principal: Principal, input: z.infer<typeof savePriceInput>) {
    const expanded = expandRules(input.rules);
    if (expanded.length > 200) throw new TRPCError({ code: 'BAD_REQUEST', message: '拆分跨午夜时段后最多 200 条规则' });
    if (expanded.filter((r) => r.kind === 'default').length > 1)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '只能有一条默认规则' });
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [version] = await tx
        .select()
        .from(priceVersions)
        .where(eq(priceVersions.id, input.versionId))
        .for('update');
      if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: '价格版本不存在' });
      if (version.status !== 'draft')
        throw new TRPCError({ code: 'CONFLICT', message: '已发布价格不可修改，请创建新草稿' });
      await tx.delete(priceRules).where(eq(priceRules.priceVersionId, version.id));
      if (expanded.length)
        await tx.insert(priceRules).values(expanded.map((r) => ({ ...r, priceVersionId: version.id })));
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'price.save_draft',
        targetType: 'price_version',
        targetId: version.id,
        metadata: { rules: input.rules },
      });
      return { success: true };
    });
  }
  async publish(principal: Principal, versionId: string, effectiveAt?: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [candidate] = await tx.select().from(priceVersions).where(eq(priceVersions.id, versionId));
      if (!candidate) throw new TRPCError({ code: 'NOT_FOUND', message: '价格版本不存在' });
      await tx.select({ id: models.id }).from(models).where(eq(models.id, candidate.modelId)).for('update');
      const [version] = await tx.select().from(priceVersions).where(eq(priceVersions.id, versionId)).for('update');
      if (version.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: '价格已发布' });
      const rules = await tx.select().from(priceRules).where(eq(priceRules.priceVersionId, versionId));
      try {
        validatePublication(rules);
      } catch (error) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (error as Error).message });
      }
      const now = new Date();
      const effective = effectiveAt ? new Date(effectiveAt) : now;
      if (effective < now)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '生效时间不能早于发布时间，可选择立即生效' });
      const [duplicate] = await tx
        .select({ id: priceVersions.id })
        .from(priceVersions)
        .where(
          and(
            eq(priceVersions.modelId, version.modelId),
            eq(priceVersions.endpoint, version.endpoint),
            eq(priceVersions.status, 'published'),
            eq(priceVersions.effectiveAt, effective),
          ),
        );
      if (duplicate) throw new TRPCError({ code: 'CONFLICT', message: '此生效时间已有价格版本' });
      await tx
        .update(priceVersions)
        .set({ status: 'published', publishedAt: now, effectiveAt: effective })
        .where(eq(priceVersions.id, versionId));
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'price.publish',
        targetType: 'price_version',
        targetId: versionId,
        metadata: { effectiveAt: effective.toISOString(), version: version.version },
      });
      return { success: true };
    });
  }
  async lock(
    modelId: string,
    endpoint: Endpoint,
    at: Date,
    multiplierMicros: bigint,
    multiplierSource: 'model' | 'channel',
  ): Promise<LockedPrice | null> {
    const [version] = await this.auth.db
      .select()
      .from(priceVersions)
      .where(
        and(
          eq(priceVersions.modelId, modelId),
          eq(priceVersions.endpoint, endpoint),
          eq(priceVersions.status, 'published'),
          lte(priceVersions.effectiveAt, at),
          lte(priceVersions.publishedAt, at),
        ),
      )
      .orderBy(desc(priceVersions.effectiveAt), desc(priceVersions.version))
      .limit(1);
    if (!version) return null;
    const rules = await this.auth.db.select().from(priceRules).where(eq(priceRules.priceVersionId, version.id));
    return {
      versionId: version.id,
      version: version.version,
      rules,
      multiplierMicros,
      multiplierSource,
      receivedAt: at,
    };
  }
  async restore(
    versionId: string,
    receivedAt: Date,
    multiplierMicros: bigint,
    multiplierSource: 'model' | 'channel',
    tx?: Transaction,
  ) {
    const db = tx ?? this.auth.db;
    const [version] = await db
      .select()
      .from(priceVersions)
      .where(and(eq(priceVersions.id, versionId), eq(priceVersions.status, 'published')));
    if (!version) return null;
    const rules = await db.select().from(priceRules).where(eq(priceRules.priceVersionId, versionId));
    return {
      versionId,
      version: version.version,
      modelId: version.modelId,
      endpoint: version.endpoint,
      receivedAt,
      multiplierMicros,
      multiplierSource,
      rules,
    };
  }
  calculate(locked: LockedPrice, usage: Quantities) {
    return {
      currency: this.currency,
      ...quote(locked.rules, locked.receivedAt, usage, locked.multiplierMicros),
      versionId: locked.versionId,
      version: locked.version,
      multiplierSource: locked.multiplierSource,
      receivedAt: locked.receivedAt.toISOString(),
      billed: false,
    };
  }
  async preview(input: z.infer<typeof previewInput>) {
    const at = new Date(input.at);
    let multiplierMicros = input.multiplier ? parseMoney(input.multiplier) : 1_000_000n;
    let multiplierSource: 'channel' | 'model' = 'channel';
    if (input.channelId) {
      const [channel] = await this.auth.db
        .select({ multiplier: channels.multiplierMicros, override: channelAvailableModels.multiplierMicros })
        .from(channels)
        .innerJoin(channelAvailableModels, eq(channels.id, channelAvailableModels.channelId))
        .where(and(eq(channels.id, input.channelId), eq(channelAvailableModels.modelId, input.modelId)));
      if (!channel) throw new TRPCError({ code: 'BAD_REQUEST', message: '渠道未提供此模型' });
      multiplierMicros = channel.override ?? channel.multiplier;
      multiplierSource = channel.override === null ? 'channel' : 'model';
    }
    let locked: LockedPrice | null;
    if (input.versionId) {
      const [version] = await this.auth.db
        .select()
        .from(priceVersions)
        .where(
          and(
            eq(priceVersions.id, input.versionId),
            eq(priceVersions.modelId, input.modelId),
            eq(priceVersions.endpoint, input.endpoint),
          ),
        );
      if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: '价格版本不存在' });
      const rules = await this.auth.db.select().from(priceRules).where(eq(priceRules.priceVersionId, version.id));
      try {
        validatePublication(rules);
      } catch (error) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (error as Error).message });
      }
      locked = {
        versionId: version.id,
        version: version.version,
        rules,
        multiplierMicros,
        multiplierSource,
        receivedAt: at,
      };
    } else locked = await this.lock(input.modelId, input.endpoint, at, multiplierMicros, multiplierSource);
    if (!locked) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '该时间没有生效的已发布价格' });
    const usage = {
      inputTokens: BigInt(input.inputTokens),
      outputTokens: BigInt(input.outputTokens),
      cacheReadTokens: BigInt(input.cacheReadTokens),
      cacheWriteTokens: BigInt(input.cacheWriteTokens),
      contextTokens: BigInt(input.inputTokens) + BigInt(input.cacheReadTokens) + BigInt(input.cacheWriteTokens),
    };
    if (usage.contextTokens > 9_223_372_036_854_775_807n)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '上下文总量超出范围' });
    try {
      return this.calculate(locked, usage);
    } catch (error) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (error as Error).message });
    }
  }
}
