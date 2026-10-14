import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { billingConventions, formatMoney } from '../../core/money.js';
import type { Database } from '../database/client.js';
import { models, priceRules, requests, requestUsage } from '../database/schema/index.js';
import { matchRule, type Rule, ruleSignature } from '../pricing/rules.js';
import { applySearchDefaults } from '../pricing/search-defaults.js';

type SnapshotRule = {
  kind: Rule['kind'];
  contextMin: string | null;
  contextMax: string | null;
  weekdaysMask: number | null;
  startMinute: number | null;
  endMinute: number | null;
};

const ceilMicros = (numerator: bigint) =>
  (numerator + billingConventions.priceTokenUnit - 1n) / billingConventions.priceTokenUnit;

/**
 * 估算订阅账号在 [start, end) 内的等效 API 费用：按（模型, 命中规则）汇总用量，
 * 再乘以当前价格。规则已变化时按条件匹配当前规则，匹配不到则退回默认规则。
 */
export async function estimateCycleUsage(db: Database, accountId: string, start: Date, end: Date) {
  const ruleId = sql<string | null>`${requests.pricingSnapshot}->>'ruleId'`;
  const confirmed = sql<boolean>`(${requests.status} = 'settled' and ${requests.usageFinal})`;
  // 快照没有命中规则的请求逐条返回，按请求时间和上下文长度匹配当前规则。
  const single = sql<string | null>`case when ${requests.pricingSnapshot}->>'ruleId' is null then ${requests.id} end`;
  const groups = await db
    .select({
      modelId: requests.modelId,
      ruleId,
      confirmed,
      single,
      requests: sql<number>`count(*)::integer`,
      sampleId: sql<string>`min(${requests.id}::text)`,
      receivedAtMs: sql<string>`floor(extract(epoch from max(${requests.receivedAt})) * 1000)::text`,
      contextTokens: sql<string>`max(${requestUsage.contextTokens})::text`,
      inputTokens: sql<string>`sum(${requestUsage.inputTokens})::text`,
      outputTokens: sql<string>`sum(${requestUsage.outputTokens})::text`,
      cacheReadTokens: sql<string>`sum(${requestUsage.cacheReadTokens})::text`,
      cacheWriteTokens: sql<string>`sum(${requestUsage.cacheWriteTokens})::text`,
      webSearchCalls: sql<string>`sum(${requestUsage.webSearchCalls})::text`,
      webSearchPreviewCalls: sql<string>`sum(${requestUsage.webSearchPreviewCalls})::text`,
    })
    .from(requests)
    .innerJoin(requestUsage, eq(requestUsage.requestId, requests.id))
    .where(
      and(eq(requests.subscriptionAccountId, accountId), gte(requests.receivedAt, start), lt(requests.receivedAt, end)),
    )
    .groupBy(requests.modelId, ruleId, confirmed, single);

  const modelIds = [...new Set(groups.flatMap((g) => (g.modelId ? [g.modelId] : [])))];
  const samples = new Map<string, string>();
  for (const g of groups) if (g.ruleId && !samples.has(g.ruleId)) samples.set(g.ruleId, g.sampleId);
  const [names, currentRows, historical] = await Promise.all([
    modelIds.length
      ? db.select({ id: models.id, name: models.name }).from(models).where(inArray(models.id, modelIds))
      : [],
    modelIds.length
      ? db
          .select({ rule: priceRules, modelName: models.name })
          .from(priceRules)
          .innerJoin(models, eq(models.id, priceRules.modelId))
          .where(and(inArray(priceRules.modelId, modelIds), isNull(models.deletedAt)))
      : [],
    samples.size
      ? db
          .select({
            ruleId,
            rule: sql<SnapshotRule | null>`jsonb_path_query_first(${requests.reservationSnapshot}, '$.pricing.rules[*] ? (@.id == $id)', jsonb_build_object('id', ${requests.pricingSnapshot}->>'ruleId'))`,
          })
          .from(requests)
          .where(inArray(requests.id, [...samples.values()]))
      : [],
  ]);
  const modelNames = new Map(names.map((m) => [m.id, m.name]));
  const currentRules = new Map<string, Rule[]>();
  for (const row of currentRows) {
    const list = currentRules.get(row.rule.modelId) ?? [];
    list.push(applySearchDefaults(row.rule, row.modelName));
    currentRules.set(row.rule.modelId, list);
  }
  const historicalSignatures = new Map(
    historical.flatMap((row) => (row.ruleId && row.rule ? [[row.ruleId, ruleSignature(row.rule)] as const] : [])),
  );

  let total = 0n;
  let fallback = 0n;
  let unconfirmed = 0n;
  let requestCount = 0;
  let unconfirmedRequests = 0;
  let fallbackRequests = 0;
  let unpricedRequests = 0;
  const byModel = new Map<
    string,
    {
      name: string | null;
      requests: number;
      inputTokens: bigint;
      outputTokens: bigint;
      cacheReadTokens: bigint;
      cacheWriteTokens: bigint;
      numerator: bigint;
    }
  >();
  for (const g of groups) {
    const quantities = {
      inputTokens: BigInt(g.inputTokens),
      outputTokens: BigInt(g.outputTokens),
      cacheReadTokens: BigInt(g.cacheReadTokens),
      cacheWriteTokens: BigInt(g.cacheWriteTokens),
      webSearchCalls: BigInt(g.webSearchCalls),
      webSearchPreviewCalls: BigInt(g.webSearchPreviewCalls),
    };
    const rules = (g.modelId && currentRules.get(g.modelId)) || [];
    const defaultRule = rules.find((r) => r.kind === 'default');
    let rule: Rule | undefined;
    let fellBack = false;
    if (g.ruleId) {
      const signature = historicalSignatures.get(g.ruleId);
      rule = signature === undefined ? undefined : rules.find((r) => ruleSignature(r) === signature);
      if (!rule) {
        rule = defaultRule;
        fellBack = true;
      }
    } else {
      rule = matchRule(rules, new Date(Number(g.receivedAtMs)), BigInt(g.contextTokens)) ?? defaultRule;
    }
    let numerator = 0n;
    let unpriced = !rule;
    if (rule)
      for (const [tokens, price, scale] of [
        [quantities.inputTokens, rule.inputPriceMicros, 1n],
        [quantities.outputTokens, rule.outputPriceMicros, 1n],
        [quantities.cacheReadTokens, rule.cacheReadPriceMicros, 1n],
        [quantities.cacheWriteTokens, rule.cacheWritePriceMicros, 1n],
        [quantities.webSearchCalls, rule.webSearchPriceMicros, 1000n],
        [quantities.webSearchPreviewCalls, rule.webSearchPreviewPriceMicros, 1000n],
      ] as const) {
        if (tokens > 0n && price === null) unpriced = true;
        else numerator += tokens * (price ?? 0n) * scale;
      }
    total += numerator;
    requestCount += g.requests;
    if (fellBack && rule) {
      fallback += numerator;
      fallbackRequests += g.requests;
    }
    if (!g.confirmed) {
      unconfirmed += numerator;
      unconfirmedRequests += g.requests;
    }
    if (unpriced) unpricedRequests += g.requests;
    const key = g.modelId ?? '';
    const entry = byModel.get(key) ?? {
      name: g.modelId ? (modelNames.get(g.modelId) ?? null) : null,
      requests: 0,
      inputTokens: 0n,
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      numerator: 0n,
    };
    entry.requests += g.requests;
    entry.inputTokens += quantities.inputTokens;
    entry.outputTokens += quantities.outputTokens;
    entry.cacheReadTokens += quantities.cacheReadTokens;
    entry.cacheWriteTokens += quantities.cacheWriteTokens;
    entry.numerator += numerator;
    byModel.set(key, entry);
  }
  return {
    amount: formatMoney(ceilMicros(total)),
    requests: requestCount,
    fallback: { amount: formatMoney(ceilMicros(fallback)), requests: fallbackRequests },
    unconfirmed: { amount: formatMoney(ceilMicros(unconfirmed)), requests: unconfirmedRequests },
    unpricedRequests,
    models: [...byModel.entries()]
      .sort(([, a], [, b]) =>
        b.numerator > a.numerator ? 1 : b.numerator < a.numerator ? -1 : b.requests - a.requests,
      )
      .map(([modelId, m]) => ({
        modelId: modelId || null,
        name: m.name,
        requests: m.requests,
        inputTokens: m.inputTokens.toString(),
        outputTokens: m.outputTokens.toString(),
        cacheReadTokens: m.cacheReadTokens.toString(),
        cacheWriteTokens: m.cacheWriteTokens.toString(),
        amount: formatMoney(ceilMicros(m.numerator)),
      })),
  };
}
