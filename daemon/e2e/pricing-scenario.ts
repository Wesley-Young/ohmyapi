import type { TRPCClient } from '@trpc/client';
import { TRPCClientError } from '@trpc/client';

import type { AppRouter } from '../src/trpc/router.js';

import assert from 'node:assert/strict';

type Rpc = TRPCClient<AppRouter>;
const endpoint = '/v1/chat/completions' as const;
export async function pricingScenario(admin: Rpc, user: Rpc) {
  const model = await admin.admin.catalog.saveModel.mutate({
    name: 'pricing-e2e',
    enabled: true,
    endpoints: [endpoint],
  });
  const scope = { modelId: model.id, endpoint };
  const base = {
    label: '默认',
    kind: 'default' as const,
    contextMin: null,
    contextMax: null,
    weekdaysMask: null,
    startMinute: null,
    endMinute: null,
    inputPrice: '1',
    outputPrice: '2',
    cacheReadPrice: '0.5',
    cacheWritePrice: '0.25',
  };
  const rules = [
    base,
    {
      ...base,
      label: '长上下文',
      kind: 'context' as const,
      contextMin: '128000',
      inputPrice: '3',
      outputPrice: '4',
      cacheReadPrice: '1',
      cacheWritePrice: '2',
    },
    {
      ...base,
      label: '周一夜间',
      kind: 'time' as const,
      weekdaysMask: 1,
      startMinute: 1320,
      endMinute: 120,
      inputPrice: '5',
      outputPrice: '6',
      cacheReadPrice: '2',
      cacheWritePrice: '3',
    },
    {
      ...base,
      label: '夜间长上下文',
      kind: 'combined' as const,
      contextMin: '128000',
      weekdaysMask: 1,
      startMinute: 1320,
      endMinute: 120,
      inputPrice: '7',
      outputPrice: '8',
      cacheReadPrice: '3',
      cacheWritePrice: '4',
    },
  ];
  const draft = await admin.admin.pricing.createDraft.mutate(scope);
  await admin.admin.pricing.saveDraft.mutate({ versionId: draft.id, rules });
  const saved = await admin.admin.pricing.list.query(scope);
  assert.equal(saved.versions[0].rules.length, 6); // Two midnight conditions each expand to two legs.
  const preview = (inputTokens: string, at: string, extras = {}) =>
    admin.admin.pricing.preview.mutate({
      ...scope,
      versionId: draft.id,
      inputTokens,
      outputTokens: '0',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      at,
      ...extras,
    });
  const below = await preview('127999', '2026-10-05T13:59:59Z');
  assert.equal(below.ruleKind, 'default');
  assert.equal(below.total, '0.127999');
  const threshold = await preview('128000', '2026-10-05T13:59:59Z');
  assert.equal(threshold.ruleKind, 'context');
  assert.equal(threshold.total, '0.384000');
  const time = await preview('127999', '2026-10-05T14:00:00Z');
  assert.equal(time.ruleKind, 'time');
  assert.equal(time.total, '0.639995');
  const combined = await preview('128000', '2026-10-05T14:00:00Z');
  assert.equal(combined.ruleKind, 'combined');
  assert.equal(combined.total, '0.896000');
  assert.equal((await preview('128000', '2026-10-05T17:59:59Z')).ruleKind, 'combined'); // Tuesday 01:59:59.
  assert.equal((await preview('128000', '2026-10-05T18:00:00Z')).ruleKind, 'context'); // Tuesday 02:00 exclusive.
  assert.equal((await preview('128000', '2026-10-04T15:00:00Z')).ruleKind, 'context'); // Sunday is not Monday.
  assert.equal((await preview('128000', '2026-10-04T17:00:00Z')).ruleKind, 'context'); // Monday early morning belongs to Sunday.
  const cache = await preview('127990', '2026-10-05T15:00:00Z', { cacheReadTokens: '5', cacheWriteTokens: '5' });
  assert.equal(cache.contextTokens, '128000');
  assert.equal(cache.total, '0.895965');
  const rounded = await preview('1', '2026-10-04T12:00:00Z', { cacheWriteTokens: '1', multiplier: '0.5' });
  assert.equal(rounded.total, '0.000001');
  assert.equal(rounded.items[0].amount, '0.000000500000000000');
  const channelInput = {
    name: 'pricing multipliers',
    baseUrl: 'http://127.0.0.1:1',
    enabled: true,
    timeoutMs: 1000,
    endpoints: [endpoint],
    multiplier: '1.5',
    availableModels: [{ modelId: model.id, multiplier: '0.5' }],
  };
  const channel = await admin.admin.catalog.saveChannel.mutate({ ...channelInput, credential: 'pricing-test-only' });
  const overridden = await preview('1000000', '2026-10-04T12:00:00Z', { channelId: channel.id });
  assert.equal(overridden.total, '1.500000');
  assert.equal(overridden.multiplierSource, 'model');
  await admin.admin.catalog.saveChannel.mutate({
    ...channelInput,
    id: channel.id,
    availableModels: [{ modelId: model.id, multiplier: null }],
  });
  const inherited = await preview('1000000', '2026-10-04T12:00:00Z', { channelId: channel.id });
  assert.equal(inherited.total, '4.500000');
  assert.equal(inherited.multiplierSource, 'channel');
  const rejects = (action: () => Promise<unknown>, code: string) =>
    assert.rejects(action, (e: unknown) => e instanceof TRPCClientError && e.data?.code === code);
  await rejects(() => preview('not-a-number', '2026-10-05T12:00:00Z'), 'BAD_REQUEST');
  await rejects(() => preview('1', '2026-10-05T12:00:00Z', { multiplier: 'invalid' }), 'BAD_REQUEST');
  await rejects(() => user.admin.pricing.list.query(scope), 'FORBIDDEN');
  await rejects(
    () =>
      user.admin.pricing.preview.mutate({
        ...scope,
        at: new Date().toISOString(),
        inputTokens: '1',
        outputTokens: '0',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
      }),
    'FORBIDDEN',
  );
  await admin.admin.pricing.publish.mutate({ versionId: draft.id });
  await rejects(() => admin.admin.pricing.saveDraft.mutate({ versionId: draft.id, rules: [base] }), 'CONFLICT');
  const conflicting = await admin.admin.pricing.createDraft.mutate({ ...scope, sourceVersionId: draft.id });
  await admin.admin.pricing.saveDraft.mutate({
    versionId: conflicting.id,
    rules: [...rules, { ...rules[1], label: '重叠上下文', contextMin: '128001' }],
  });
  await rejects(() => admin.admin.pricing.publish.mutate({ versionId: conflicting.id }), 'BAD_REQUEST');
  await admin.admin.pricing.saveDraft.mutate({ versionId: conflicting.id, rules: [rules[1]] });
  await rejects(() => admin.admin.pricing.publish.mutate({ versionId: conflicting.id }), 'BAD_REQUEST');
  await admin.admin.pricing.saveDraft.mutate({ versionId: conflicting.id, rules: [{ ...base, cacheReadPrice: null }] });
  await rejects(
    () =>
      admin.admin.pricing.preview.mutate({
        ...scope,
        versionId: conflicting.id,
        at: new Date().toISOString(),
        inputTokens: '0',
        outputTokens: '0',
        cacheReadTokens: '1',
        cacheWriteTokens: '0',
      }),
    'BAD_REQUEST',
  );
  const future = await admin.admin.pricing.createDraft.mutate(scope);
  await admin.admin.pricing.saveDraft.mutate({
    versionId: future.id,
    rules: [{ ...base, label: '未来价', inputPrice: '9' }],
  });
  const effective = new Date(Date.now() + 86400000);
  await admin.admin.pricing.publish.mutate({ versionId: future.id, effectiveAt: effective.toISOString() });
  const before = await admin.admin.pricing.preview.mutate({
    ...scope,
    at: new Date(effective.getTime() - 1).toISOString(),
    inputTokens: '1000000',
    outputTokens: '0',
    cacheReadTokens: '0',
    cacheWriteTokens: '0',
  });
  assert.equal(before.versionId, draft.id);
  const after = await admin.admin.pricing.preview.mutate({
    ...scope,
    at: effective.toISOString(),
    inputTokens: '1000000',
    outputTokens: '0',
    cacheReadTokens: '0',
    cacheWriteTokens: '0',
  });
  assert.equal(after.versionId, future.id);
  assert.equal(after.total, '9.000000');
}
