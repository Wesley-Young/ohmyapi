import { serviceToken } from '@fraqjs/kernel';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, GatewayError } from '../../core/errors.ts';
import { formatMoney, parseMoney } from '../../core/money.ts';
import { recordAudit } from '../auth/audit.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Database } from '../database/client.ts';
import {
  channelModelPrices,
  channels,
  models,
  type PricingMode,
  priceRules,
  pricingModes,
} from '../database/schema/index.ts';
import type { KeyService } from '../keys/service.ts';
import { expandRules, type Quantities, quote, type Rule, validateRules } from './rules.ts';
import { multiplierInput, type PreviewInput, type PriceScope, ruleInput, type SavePriceInput } from './schemas.ts';
import { applySearchDefaults, defaultSearchPrices } from './search-defaults.ts';

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
  webSearchPrice: r.webSearchPriceMicros === null ? null : formatMoney(r.webSearchPriceMicros),
  webSearchPreviewPrice: r.webSearchPreviewPriceMicros === null ? null : formatMoney(r.webSearchPreviewPriceMicros),
});
const routingSnapshot = z.object({
  entryChannelId: z.uuid(),
  executionChannelId: z.uuid(),
  pricingChannelId: z.uuid(),
});
const snapshotInput = z.object({
  modelId: z.uuid(),
  rules: z
    .array(ruleInput.safeExtend({ id: z.uuid() }))
    .min(1)
    .max(200),
  multiplier: multiplierInput,
  multiplierSource: z.enum(['model', 'channel']),
  pricingMode: z.enum(pricingModes).default('unified'),
  routing: routingSnapshot.optional(),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type LockedPrice = {
  modelId: string;
  rules: Rule[];
  multiplierMicros: bigint;
  multiplierSource: 'model' | 'channel';
  pricingMode: PricingMode;
  routing?: z.infer<typeof routingSnapshot>;
  receivedAt: Date;
};

// 用户账单展示实际倍率和计费模式，成员标识仅供管理员核对。
export function publicPricingSnapshot(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const { routing: _routing, ...visible } = value;
  if (visible.pricing && typeof visible.pricing === 'object' && !Array.isArray(visible.pricing))
    visible.pricing = publicPricingSnapshot(visible.pricing as Record<string, unknown>);
  return visible;
}

export class PricingService {
  static readonly token = serviceToken<PricingService>('ohmyapi/pricing');
  private readonly db: Database;
  private readonly auth: AuthService;
  readonly currency: string;
  constructor({ db, auth, currency }: { db: Database; auth: AuthService; currency: string }) {
    this.db = db;
    this.auth = auth;
    this.currency = currency;
  }

  async plaza(offerings: Awaited<ReturnType<KeyService['offerings']>>) {
    const modelIds = [...new Set(offerings.map((row) => row.modelId))];
    const rules = modelIds.length
      ? await this.db
          .select()
          .from(priceRules)
          .where(inArray(priceRules.modelId, modelIds))
          .orderBy(priceRules.createdAt, priceRules.id)
      : [];
    const scaledPrice = (price: bigint | null, multiplier: bigint) => {
      if (price === null) return null;
      const product = price * multiplier;
      const fraction = (product % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
      return `${product / 1_000_000_000_000n}${fraction ? `.${fraction}` : ''}`;
    };
    return {
      currency: this.currency,
      models: modelIds
        .filter((id) => rules.some((rule) => rule.modelId === id && rule.kind === 'default'))
        .map((id) => {
          const rows = offerings.filter((row) => row.modelId === id);
          const model = rows[0];
          const channelPrices = [...new Map(rows.map((row) => [row.channelId, row])).values()]
            .sort((a, b) =>
              a.multiplierMicros < b.multiplierMicros
                ? -1
                : a.multiplierMicros > b.multiplierMicros
                  ? 1
                  : a.channelName.localeCompare(b.channelName),
            )
            .map((row) => ({
              id: row.channelId,
              name: row.channelName,
              multiplier: formatMoney(row.multiplierMicros),
              maxMultiplier: formatMoney(row.maxMultiplierMicros),
              pricingMode: row.pricingMode,
              endpoints: rows.filter((r) => r.channelId === row.channelId).map((r) => r.endpoint),
              rules: rules
                .filter((rule) => rule.modelId === id)
                .map((rule) => {
                  const effective = applySearchDefaults(rule, model.modelName);
                  return {
                    ...serializeRule(effective),
                    maximum: {
                      inputPrice: scaledPrice(rule.inputPriceMicros, row.maxMultiplierMicros) as string,
                      outputPrice: scaledPrice(rule.outputPriceMicros, row.maxMultiplierMicros) as string,
                      cacheReadPrice: scaledPrice(rule.cacheReadPriceMicros, row.maxMultiplierMicros),
                      cacheWritePrice: scaledPrice(rule.cacheWritePriceMicros, row.maxMultiplierMicros),
                      webSearchPrice: scaledPrice(effective.webSearchPriceMicros, row.maxMultiplierMicros),
                      webSearchPreviewPrice: scaledPrice(
                        effective.webSearchPreviewPriceMicros,
                        row.maxMultiplierMicros,
                      ),
                    },
                    inputPrice: scaledPrice(rule.inputPriceMicros, row.multiplierMicros) as string,
                    outputPrice: scaledPrice(rule.outputPriceMicros, row.multiplierMicros) as string,
                    cacheReadPrice: scaledPrice(rule.cacheReadPriceMicros, row.multiplierMicros),
                    cacheWritePrice: scaledPrice(rule.cacheWritePriceMicros, row.multiplierMicros),
                    webSearchPrice: scaledPrice(effective.webSearchPriceMicros, row.multiplierMicros),
                    webSearchPreviewPrice: scaledPrice(effective.webSearchPreviewPriceMicros, row.multiplierMicros),
                  };
                }),
            }));
          return {
            id,
            name: model.modelName,
            inputTokenLimit: model.inputTokenLimit,
            outputTokenLimit: model.outputTokenLimit,
            lowestPriceVariable: channelPrices[0].pricingMode === 'passthrough',
            lowestPrice: channelPrices[0].rules.find((rule) => rule.kind === 'default') ?? null,
            channels: channelPrices,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async list(scope: PriceScope) {
    const [model] = await this.db
      .select({ id: models.id, name: models.name })
      .from(models)
      .where(and(eq(models.id, scope.modelId), isNull(models.deletedAt)));
    if (!model) throw new AppError('not_found', '模型不存在或已删除');
    const rules = await this.db
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
    return {
      currency: this.currency,
      searchDefaults: defaultSearchPrices(model.name),
      rules: rules.map(serializeRule),
    };
  }

  async save(principal: Principal, input: SavePriceInput) {
    const expanded = expandRules(input.rules);
    if (expanded.length > 200) throw new AppError('bad_request', '拆分跨午夜时段后最多 200 条规则');
    if (expanded.length) {
      try {
        validateRules(expanded);
      } catch (error) {
        throw new AppError('bad_request', (error as Error).message);
      }
    }
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [model] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.id, input.modelId), isNull(models.deletedAt)))
        .for('update');
      if (!model) throw new AppError('not_found', '模型不存在');
      // Replace the complete set atomically; requests read either the old or the new set.
      await tx.delete(priceRules).where(eq(priceRules.modelId, input.modelId));
      if (expanded.length) await tx.insert(priceRules).values(expanded.map((r) => ({ ...r, modelId: input.modelId })));
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'price.save',
        targetType: 'model',
        targetId: input.modelId,
        metadata: { rules: input.rules },
      });
      return { success: true };
    });
  }

  async lockRoute(modelId: string, at: Date, entryChannelId: string, executionChannelId: string) {
    const [selected] = await this.db
      .select({
        price: {
          pricingChannelId: channelModelPrices.pricingChannelId,
          multiplierMicros: channelModelPrices.multiplierMicros,
          multiplierSource: channelModelPrices.multiplierSource,
        },
        mode: channels.pricingMode,
      })
      .from(channelModelPrices)
      .innerJoin(channels, eq(channels.id, channelModelPrices.channelId))
      .where(
        and(
          eq(channelModelPrices.channelId, entryChannelId),
          eq(channelModelPrices.modelId, modelId),
          or(
            and(eq(channels.pricingMode, 'unified'), eq(channelModelPrices.pricingChannelId, entryChannelId)),
            and(eq(channels.pricingMode, 'passthrough'), eq(channelModelPrices.pricingChannelId, executionChannelId)),
          ),
        ),
      );
    if (!selected) throw new GatewayError(503, 'channel_unavailable', 'The selected channel price is unavailable');
    const locked = await this.lock(modelId, at, selected.price.multiplierMicros, selected.price.multiplierSource);
    return (
      locked && {
        ...locked,
        pricingMode: selected.mode,
        routing: {
          entryChannelId,
          executionChannelId,
          pricingChannelId: selected.price.pricingChannelId,
        },
      }
    );
  }

  async lock(
    modelId: string,
    at: Date,
    multiplierMicros: bigint,
    multiplierSource: 'model' | 'channel',
  ): Promise<LockedPrice | null> {
    const rows = await this.db
      .select({ rule: priceRules, modelName: models.name })
      .from(priceRules)
      .innerJoin(models, eq(models.id, priceRules.modelId))
      .where(and(eq(priceRules.modelId, modelId), isNull(models.deletedAt)));
    // 锁定实际采用的默认值，后续改价和模型改名均沿用请求快照。
    const rules = rows.map((row) => applySearchDefaults(row.rule, row.modelName));
    if (!rules.length) return null;
    validateRules(rules);
    return { modelId, rules, multiplierMicros, multiplierSource, receivedAt: at, pricingMode: 'unified' };
  }

  snapshot(locked: LockedPrice) {
    return {
      modelId: locked.modelId,
      rules: locked.rules.map(serializeRule),
      multiplier: formatMoney(locked.multiplierMicros),
      multiplierSource: locked.multiplierSource,
      pricingMode: locked.pricingMode,
      routing: locked.routing,
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
      pricingMode: saved.pricingMode,
      routing: saved.routing,
    };
  }

  calculate(locked: LockedPrice, usage: Quantities) {
    return {
      currency: this.currency,
      ...quote(locked.rules, locked.receivedAt, usage, locked.multiplierMicros),
      multiplierSource: locked.multiplierSource,
      pricingMode: locked.pricingMode,
      routing: locked.routing,
      receivedAt: locked.receivedAt.toISOString(),
      billed: false,
    };
  }

  async preview(input: PreviewInput) {
    const at = new Date(input.at);
    let minimum = {
      multiplierMicros: parseMoney(input.multiplier ?? '1'),
      multiplierSource: 'channel' as 'channel' | 'model',
    };
    let maximum = minimum;
    let pricingMode: LockedPrice['pricingMode'] = 'unified';
    if (input.channelId) {
      const options = await this.db
        .select({
          price: {
            pricingChannelId: channelModelPrices.pricingChannelId,
            multiplierMicros: channelModelPrices.multiplierMicros,
            multiplierSource: channelModelPrices.multiplierSource,
          },
          mode: channels.pricingMode,
        })
        .from(channelModelPrices)
        .innerJoin(channels, eq(channels.id, channelModelPrices.channelId))
        .where(and(eq(channelModelPrices.channelId, input.channelId), eq(channelModelPrices.modelId, input.modelId)))
        .orderBy(channelModelPrices.multiplierMicros, channelModelPrices.pricingChannelId);
      if (!options.length) throw new AppError('bad_request', '渠道未提供此模型');
      minimum = options[0].price;
      maximum = options[options.length - 1].price;
      pricingMode = options[0].mode;
    }
    const locked = await this.lock(input.modelId, at, minimum.multiplierMicros, minimum.multiplierSource);
    if (!locked) throw new AppError('precondition_failed', '模型尚未配置价格');
    locked.pricingMode = pricingMode;
    const usage = {
      inputTokens: BigInt(input.inputTokens),
      outputTokens: BigInt(input.outputTokens),
      cacheReadTokens: BigInt(input.cacheReadTokens),
      cacheWriteTokens: BigInt(input.cacheWriteTokens),
      webSearchCalls: BigInt(input.webSearchCalls),
      webSearchPreviewCalls: BigInt(input.webSearchPreviewCalls),
      contextTokens: BigInt(input.inputTokens) + BigInt(input.cacheReadTokens) + BigInt(input.cacheWriteTokens),
    };
    if (usage.contextTokens > 9_223_372_036_854_775_807n) throw new AppError('bad_request', '上下文总量超出范围');
    try {
      return {
        ...this.calculate(locked, usage),
        maximum: this.calculate(
          { ...locked, multiplierMicros: maximum.multiplierMicros, multiplierSource: maximum.multiplierSource },
          usage,
        ),
      };
    } catch (error) {
      throw new AppError('bad_request', (error as Error).message);
    }
  }
}
