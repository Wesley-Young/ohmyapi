import { type Endpoint, isGeminiPathModel } from '@ohmyapi/protocols';
import { and, eq, exists, inArray, sql } from 'drizzle-orm';

import { formatMoney } from '../../core/money.ts';
import { channelOfferings } from '../catalog/offerings.ts';
import type { Database } from '../database/client.ts';
import {
  channelModelPrices,
  channels,
  effectiveChannelEndpoints,
  models,
  priceRules,
} from '../database/schema/index.ts';

const endpoints = [
  '/v1/responses',
  '/v1/messages',
  '/v1/chat/completions',
  '/v1beta/generateContent',
] as const satisfies readonly Endpoint[];
type ChatEndpoint = (typeof endpoints)[number];
export function isPlaygroundEndpoint(endpoint: Endpoint): endpoint is ChatEndpoint {
  return endpoints.some((item) => item === endpoint);
}

type Model = {
  id: string;
  name: string;
  outputTokenLimit: number;
  endpoints: ChatEndpoint[];
  minimum: bigint;
  maximum: bigint;
};

export async function playgroundOptions(db: Database, user: { id: string; role: string }) {
  // 聚合渠道的模型和端点各自取并集；对话需要同一成员同时支持二者。透传倍率只计入支持该组合的成员。
  const compatible = sql`(${channels.type} <> 'aggregate' or exists (
    select 1 from aggregate_channel_members membership
    join channels child on child.id = membership.member_channel_id and child.deleted_at is null
    join channel_available_models cm on cm.channel_id = child.id and cm.model_id = ${models.id}
    join channel_endpoints ce on ce.channel_id = child.id and ce.endpoint = ${effectiveChannelEndpoints.endpoint}
    where membership.aggregate_channel_id = ${channels.id}
      and (${channels.pricingMode} = 'unified' or child.id = ${channelModelPrices.pricingChannelId})
  ))`;
  const priced = db
    .select({ id: priceRules.id })
    .from(priceRules)
    .where(and(eq(priceRules.modelId, models.id), eq(priceRules.kind, 'default')));
  const rows = await channelOfferings(
    db,
    user,
    and(inArray(effectiveChannelEndpoints.endpoint, endpoints), exists(priced), compatible),
  );
  const options = new Map<string, { id: string; name: string; models: Map<string, Model> }>();
  for (const row of rows) {
    if (
      !isPlaygroundEndpoint(row.endpoint) ||
      (row.endpoint === '/v1beta/generateContent' && !isGeminiPathModel(row.modelName))
    )
      continue;
    let channel = options.get(row.channelId);
    if (!channel) {
      channel = { id: row.channelId, name: row.channelName, models: new Map() };
      options.set(row.channelId, channel);
    }
    let model = channel.models.get(row.modelId);
    if (!model) {
      model = {
        id: row.modelId,
        name: row.modelName,
        outputTokenLimit: row.outputTokenLimit,
        endpoints: [],
        minimum: row.multiplierMicros,
        maximum: row.maxMultiplierMicros,
      };
      channel.models.set(row.modelId, model);
    }
    model.endpoints.push(row.endpoint);
    if (row.multiplierMicros < model.minimum) model.minimum = row.multiplierMicros;
    if (row.maxMultiplierMicros > model.maximum) model.maximum = row.maxMultiplierMicros;
  }
  return Array.from(options.values(), (channel) => ({
    id: channel.id,
    name: channel.name,
    models: Array.from(channel.models.values(), (model) => ({
      ...model,
      endpoints: endpoints.filter((endpoint) => model.endpoints.includes(endpoint)),
      minimum: formatMoney(model.minimum),
      maximum: formatMoney(model.maximum),
    })),
  }));
}
