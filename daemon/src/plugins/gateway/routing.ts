import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Transaction } from '../auth/service.js';
import type { Endpoint } from '../catalog/service.js';
import type { Database } from '../database/client.js';
import {
  aggregateChannelMembers,
  channels,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  subscriptionAccounts,
} from '../database/schema/index.js';
import { availableSubscription } from '../subscription/availability.js';
import { supportsAggregateRequest } from '../subscription/openai/request.js';
import type { SubscriptionService } from '../subscription/service.js';
import { GatewayError } from './errors.js';

type Channel = typeof channels.$inferSelect;

export async function selectExecutionChannel(
  db: Database,
  subscription: SubscriptionService,
  entry: Channel,
  parsed: Record<string, unknown>,
  endpoint: Endpoint,
) {
  if (entry.type !== 'aggregate') return entry;
  const rows = await db
    .select({ channel: channels, member: aggregateChannelMembers, account: subscriptionAccounts })
    .from(aggregateChannelMembers)
    .innerJoin(channels, eq(channels.id, aggregateChannelMembers.memberChannelId))
    .leftJoin(subscriptionAccounts, eq(subscriptionAccounts.id, channels.subscriptionAccountId))
    .where(
      and(
        eq(aggregateChannelMembers.aggregateChannelId, entry.id),
        eq(channels.enabled, true),
        isNull(channels.deletedAt),
        availableSubscription(),
      ),
    )
    .orderBy(desc(aggregateChannelMembers.priority), channels.id);
  const compatible = rows.filter(
    ({ channel }) =>
      channel.type === 'api' || (channel.type === 'subscription' && supportsAggregateRequest(parsed, endpoint)),
  );
  if (rows.length && !compatible.length)
    throw new GatewayError(400, 'aggregate_request_unsupported', 'No member can preserve the requested parameters');
  const available = compatible.filter(
    ({ channel, account }) =>
      channel.type === 'api' ||
      (account &&
        (!account.cooldownUntil || account.cooldownUntil.getTime() <= Date.now()) &&
        subscription.concurrency.active(account.id) < account.maxConcurrent),
  );
  if (!available.length)
    throw new GatewayError(503, 'aggregate_unavailable', 'No aggregate member is currently available');
  const preferred = available.filter((row) => row.member.priority === available[0].member.priority);
  let weight = Math.random() * preferred.reduce((sum, row) => sum + row.member.weight, 0);
  for (const row of preferred) {
    weight -= row.member.weight;
    if (weight < 0) return row.channel;
  }
  return preferred[preferred.length - 1].channel;
}

// 在预占和发送前复查入口交集及实际成员，配置变更不能绕过成员关系或能力校验。
export async function lockExecutionRoute(
  tx: Transaction,
  input: { channelId: string; modelId: string; endpoint: Endpoint; executionChannel: Channel },
) {
  const [entry] = await tx
    .select({ type: channels.type })
    .from(channels)
    .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.channelId, channels.id))
    .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
    .where(
      and(
        eq(channels.id, input.channelId),
        eq(channels.enabled, true),
        isNull(channels.deletedAt),
        eq(effectiveChannelModels.modelId, input.modelId),
        eq(effectiveChannelEndpoints.endpoint, input.endpoint),
      ),
    )
    .for('share', { of: channels });
  if (!entry) throw new GatewayError(503, 'channel_unavailable', 'The entry channel capability changed');
  const selected = input.executionChannel;
  if (entry.type === 'aggregate') {
    const [member] = await tx
      .select()
      .from(aggregateChannelMembers)
      .where(
        and(
          eq(aggregateChannelMembers.aggregateChannelId, input.channelId),
          eq(aggregateChannelMembers.memberChannelId, selected.id),
        ),
      )
      .for('share');
    if (!member) throw new GatewayError(503, 'channel_unavailable', 'The selected member was removed');
  } else if (input.channelId !== selected.id) {
    throw new GatewayError(503, 'channel_unavailable', 'The selected channel does not match the entry');
  }
  const [actual] = await tx
    .select({ channel: channels })
    .from(channels)
    .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.channelId, channels.id))
    .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
    .where(
      and(
        eq(channels.id, selected.id),
        eq(channels.enabled, true),
        isNull(channels.deletedAt),
        eq(effectiveChannelModels.modelId, input.modelId),
        eq(effectiveChannelEndpoints.endpoint, input.endpoint),
        availableSubscription(),
      ),
    )
    .for('share', { of: channels });
  const current = actual?.channel;
  if (
    !current ||
    current.type === 'aggregate' ||
    current.type !== selected.type ||
    current.baseUrl !== selected.baseUrl ||
    current.credentialEncrypted !== selected.credentialEncrypted ||
    current.subscriptionAccountId !== selected.subscriptionAccountId
  )
    throw new GatewayError(503, 'channel_unavailable', 'The selected channel configuration changed');
}
