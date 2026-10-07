import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthService, Principal } from '../auth/service.js';
import { formatMoney, parseMoney } from '../billing/conventions.js';
import { adminAuditLogs, channelAvailableModels, channels, models, priceRules } from '../database/schema/index.js';
import {
  expandRules,
  multiplierInput,
  type Quantities,
  quote,
  type Rule,
  ruleInput,
  tokenInput,
  validateRules,
} from './rules.js';

export const priceScope = z.object({ modelId: z.uuid() });
export const savePriceInput = priceScope.extend({ rules: z.array(ruleInput).max(200) });
export const previewInput = priceScope.extend({
  channelId: z.uuid().optional(),
  at: z.iso.datetime({ offset: true }),
  inputTokens: tokenInput,
  outputTokens: tokenInput,
  cacheReadTokens: tokenInput,
  cacheWriteTokens: tokenInput,
  multiplier: multiplierInput.optional(),
});
const serializeRule = (r: Rule) => ({
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
const snapshotInput = z.object({
  modelId: z.uuid(),
  rules: z
    .array(ruleInput.safeExtend({ id: z.uuid() }))
    .min(1)
    .max(200),
  multiplier: multiplierInput,
  multiplierSource: z.enum(['model', 'channel']),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type LockedPrice = {
  modelId: string;
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
    const [model] = await this.auth.db
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.id, scope.modelId), isNull(models.deletedAt)));
    if (!model) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在或已删除' });
    const rules = await this.auth.db
      .select()
      .from(priceRules)
      .where(eq(priceRules.modelId, scope.modelId))
      .orderBy(priceRules.createdAt, priceRules.id);
    const displayOrder = ['default', 'context', 'time', 'combined'];
    rules.sort(
      (a, b) =>
        displayOrder.indexOf(a.kind) - displayOrder.indexOf(b.kind) ||
        a.label.localeCompare(b.label, 'zh-CN') ||
        (a.weekdaysMask ?? 0) - (b.weekdaysMask ?? 0) ||
        (a.startMinute ?? 0) - (b.startMinute ?? 0),
    );
    return { currency: this.currency, rules: rules.map(serializeRule) };
  }
  async save(principal: Principal, input: z.infer<typeof savePriceInput>) {
    const expanded = expandRules(input.rules);
    if (expanded.length > 200) throw new TRPCError({ code: 'BAD_REQUEST', message: '拆分跨午夜时段后最多 200 条规则' });
    if (expanded.length) {
      try {
        validateRules(expanded);
      } catch (error) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (error as Error).message });
      }
    }
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [model] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.id, input.modelId), isNull(models.deletedAt)))
        .for('update');
      if (!model) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在' });
      // Replace the complete set atomically; requests read either the old or the new set.
      await tx.delete(priceRules).where(eq(priceRules.modelId, input.modelId));
      if (expanded.length) await tx.insert(priceRules).values(expanded.map((r) => ({ ...r, modelId: input.modelId })));
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'price.save',
        targetType: 'model',
        targetId: input.modelId,
        metadata: { rules: input.rules },
      });
      return { success: true };
    });
  }
  async lock(
    modelId: string,
    at: Date,
    multiplierMicros: bigint,
    multiplierSource: 'model' | 'channel',
  ): Promise<LockedPrice | null> {
    const rows = await this.auth.db
      .select({ rule: priceRules })
      .from(priceRules)
      .innerJoin(models, eq(models.id, priceRules.modelId))
      .where(and(eq(priceRules.modelId, modelId), isNull(models.deletedAt)));
    const rules = rows.map((row) => row.rule);
    if (!rules.length) return null;
    validateRules(rules);
    return { modelId, rules, multiplierMicros, multiplierSource, receivedAt: at };
  }
  snapshot(locked: LockedPrice) {
    return {
      modelId: locked.modelId,
      rules: locked.rules.map(serializeRule),
      multiplier: formatMoney(locked.multiplierMicros),
      multiplierSource: locked.multiplierSource,
      receivedAt: locked.receivedAt.toISOString(),
    };
  }
  restore(snapshot: unknown, receivedAt: Date): LockedPrice {
    const saved = snapshotInput.parse(snapshot);
    if (new Date(saved.receivedAt).getTime() !== receivedAt.getTime()) throw new Error('Price snapshot time mismatch');
    const rules = saved.rules.map((r) => ({ ...expandRules([r])[0], id: r.id }));
    validateRules(rules);
    return {
      modelId: saved.modelId,
      rules,
      receivedAt,
      multiplierMicros: parseMoney(saved.multiplier),
      multiplierSource: saved.multiplierSource,
    };
  }
  calculate(locked: LockedPrice, usage: Quantities) {
    return {
      currency: this.currency,
      ...quote(locked.rules, locked.receivedAt, usage, locked.multiplierMicros),
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
        .where(
          and(
            eq(channels.id, input.channelId),
            eq(channelAvailableModels.modelId, input.modelId),
            isNull(channels.deletedAt),
          ),
        );
      if (!channel) throw new TRPCError({ code: 'BAD_REQUEST', message: '渠道未提供此模型' });
      multiplierMicros = channel.override ?? channel.multiplier;
      multiplierSource = channel.override === null ? 'channel' : 'model';
    }
    const locked = await this.lock(input.modelId, at, multiplierMicros, multiplierSource);
    if (!locked) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '模型尚未配置价格' });
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
