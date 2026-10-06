import type { TRPCClient } from '@trpc/client';
import { TRPCClientError } from '@trpc/client';

import type { AppRouter } from '../src/trpc/router.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

type Rpc = TRPCClient<AppRouter>;
export type BillingTestControls = {
  client: () => Rpc;
  sql: (query: string) => Promise<void>;
  restart: (beforeStart?: () => Promise<void>) => Promise<void>;
};
export async function billingScenario(url: string, admin: Rpc, controls: BillingTestControls) {
  let mode: 'hold' | 'normal' | 'final-hold' | 'overrun' | 'unpriced-cache' = 'hold';
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Consume the real forwarded request. */
    }
    calls++;
    const usage = {
      prompt_tokens: mode === 'overrun' ? 1000000 : 10,
      completion_tokens: 5,
      ...(mode === 'unpriced-cache' ? { prompt_tokens_details: { cached_tokens: 3 } } : {}),
    };
    if (mode === 'hold' || mode === 'final-hold') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'hold')
        res.write(': waiting\n\ndata: {"id":"billing-held","choices":[{"delta":{"content":"hello"}}]}\n\n');
      else res.write(`data: ${JSON.stringify({ id: 'billing-final-held', choices: [], usage })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'billing-normal',
        object: 'chat.completion',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
        usage,
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock port');
  const user = controls.client();
  const account = await admin.admin.users.create.mutate({ username: 'billing-e2e' });
  await user.auth.login.mutate({ username: 'billing-e2e', password: account.password });
  const model = await admin.admin.catalog.saveModel.mutate({
    name: 'billing-test',
    endpoints: ['/v1/chat/completions'],
    enabled: true,
    inputTokenLimit: 512,
    outputTokenLimit: 16,
  });
  const channelInput = {
    name: 'billing mock',
    baseUrl: `http://127.0.0.1:${address.port}`,
    endpoints: ['/v1/chat/completions' as const],
    enabled: true,
    timeoutMs: 60000,
    multiplier: '1',
    availableModels: [{ modelId: model.id, multiplier: null }],
  };
  const channel = await admin.admin.catalog.saveChannel.mutate({ ...channelInput, credential: 'billing-mock-secret' });
  const version = await admin.admin.pricing.createDraft.mutate({ modelId: model.id, endpoint: '/v1/chat/completions' });
  await admin.admin.pricing.saveDraft.mutate({
    versionId: version.id,
    rules: [
      {
        label: 'billing default',
        kind: 'default',
        contextMin: null,
        contextMax: null,
        weekdaysMask: null,
        startMinute: null,
        endMinute: null,
        inputPrice: '1',
        outputPrice: '1',
        cacheReadPrice: '1',
        cacheWritePrice: '1',
      },
    ],
  });
  await admin.admin.pricing.publish.mutate({ versionId: version.id });
  await admin.admin.catalog.setGrants.mutate({ userId: account.user.id, modelIds: [model.id] });
  const key = await user.keys.create.mutate({ name: 'billing first', channelId: channel.id });
  const sibling = await user.keys.create.mutate({ name: 'billing second', channelId: channel.id });
  const send = (stream = false, token = key.token) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'billing-test',
        max_completion_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
    });
  const adjust = (amount: string) =>
    admin.admin.wallet.adjust.mutate({
      userId: account.user.id,
      amount,
      reason: 'e2e billing budget',
      idempotencyKey: randomUUID(),
    });
  const release = (requestId: string) =>
    admin.admin.billing.resolve.mutate({
      requestId,
      action: 'release',
      reason: 'e2e confirmed upstream did not bill',
      idempotencyKey: randomUUID(),
    });
  const consistent = async () =>
    assert.equal((await admin.admin.billing.reconcile.query({ userId: account.user.id })).consistent, true);
  try {
    // Balance admission occurs before the upstream sees anything.
    const noBalance = await send();
    assert.equal(noBalance.status, 402);
    await noBalance.text();
    assert.equal(calls, 0);
    await adjust('0.000528');
    const held = await send(true);
    assert.equal(held.status, 200);
    const heldId = held.headers.get('x-request-id');
    assert.ok(heldId);
    const heldReader = held.body?.getReader();
    assert.ok(heldReader);
    await heldReader.read();
    const second = await send(false, sibling.token);
    assert.equal(second.status, 402);
    await second.text();
    assert.equal(calls, 1);
    assert.equal((await user.wallet.get.query()).available, '0.000000');
    await assert.rejects(
      () => adjust('-0.000001'),
      (e: unknown) => e instanceof TRPCClientError && e.data?.code === 'BAD_REQUEST',
    );
    await consistent();
    // Real SIGKILL: an unknown in-flight request keeps its hold across restart.
    await controls.restart();
    await heldReader.cancel().catch(() => {});
    const recovered = await user.requestDetail.query({ requestId: heldId });
    assert.equal(recovered.status, 'needs_review');
    assert.equal(recovered.errorCode, 'process_interrupted');
    assert.equal(recovered.held, '0.000528');
    await release(heldId);
    assert.equal((await user.wallet.get.query()).reserved, '0.000000');
    await consistent();
    mode = 'normal';
    const normal = await send();
    assert.equal(normal.status, 200);
    const normalId = normal.headers.get('x-request-id');
    assert.ok(normalId);
    await normal.text();
    assert.equal((await user.requestDetail.query({ requestId: normalId })).charged, '0.000015');
    assert.equal((await user.wallet.get.query()).balance, '0.000513');
    await adjust('0.010000');
    // A database error after wallet updates must roll back the complete reservation transaction.
    await controls.sql(
      `create function e2e_reserve_failure() returns trigger language plpgsql as $$ begin if NEW.kind = 'reserve' then raise exception 'e2e injected reservation failure'; end if; return NEW; end; $$; create trigger e2e_reserve_failure before insert on wallet_ledger for each row execute function e2e_reserve_failure();`,
    );
    const walletBeforeFailure = await user.wallet.get.query();
    const beforeFailureCalls = calls;
    try {
      const failed = await send();
      assert.equal(failed.status, 502);
      await failed.text();
      assert.deepEqual(await user.wallet.get.query(), walletBeforeFailure);
      assert.equal(calls, beforeFailureCalls);
    } finally {
      await controls.sql('drop trigger e2e_reserve_failure on wallet_ledger; drop function e2e_reserve_failure();');
    }
    await consistent();
    // Pause the real transition to forwarding, then crash before any upstream request.
    await controls.sql(
      `create function e2e_pause_forward() returns trigger language plpgsql as $$ begin if NEW.status = 'forwarding' and OLD.status = 'reserved' and NEW.user_id = '${account.user.id}' then perform pg_sleep(60); end if; return NEW; end; $$; create trigger e2e_pause_forward before update on requests for each row execute function e2e_pause_forward();`,
    );
    const beforePauseCalls = calls;
    const pendingRequest = send().catch(() => null);
    let reservedId: string | undefined;
    const reserveDeadline = Date.now() + 5000;
    while (!reservedId) {
      reservedId = (await user.requests.query()).items.find(
        (r) => r.model === 'billing-test' && r.status === 'reserved',
      )?.id;
      if (Date.now() > reserveDeadline) throw new Error('Real request did not reach committed reservation');
      if (!reservedId) await setTimeout(30);
    }
    await controls.restart(async () => {
      await controls.sql(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state = 'active' and query like 'update "requests"%'; drop trigger e2e_pause_forward on requests; drop function e2e_pause_forward();`,
      );
    });
    await pendingRequest;
    assert.equal(calls, beforePauseCalls);
    const beforeForwardRecovered = await user.requestDetail.query({ requestId: reservedId });
    assert.equal(beforeForwardRecovered.status, 'released');
    assert.equal(beforeForwardRecovered.held, '0.000000');
    assert.equal(beforeForwardRecovered.charged, '0.000000');
    await consistent();
    // A final usage checkpoint survives a crash before HTTP completion and settles exactly once.
    mode = 'final-hold';
    const finalHeld = await send(true);
    const finalId = finalHeld.headers.get('x-request-id');
    assert.ok(finalId);
    const finalReader = finalHeld.body?.getReader();
    assert.ok(finalReader);
    let received = '';
    while (!received.includes('[DONE]')) {
      const chunk = await finalReader.read();
      if (chunk.done) throw new Error('Mock stream ended before final usage');
      received += Buffer.from(chunk.value).toString();
    }
    assert.equal((await user.requestDetail.query({ requestId: finalId })).usageFinal, true);
    await controls.restart();
    await finalReader.cancel().catch(() => {});
    const finalRecovered = await user.requestDetail.query({ requestId: finalId });
    assert.equal(finalRecovered.status, 'settled');
    assert.equal(finalRecovered.charged, '0.000015');
    assert.equal(finalRecovered.ledger.filter((e) => e.kind === 'settlement').length, 1);
    await controls.restart();
    assert.equal(
      (await user.requestDetail.query({ requestId: finalId })).ledger.filter((e) => e.kind === 'settlement').length,
      1,
    );
    await consistent();
    // Final evidence is committed before settlement; a failed settlement transaction retries without replaying upstream.
    mode = 'normal';
    await controls.sql(
      `create function e2e_settlement_failure() returns trigger language plpgsql as $$ begin if NEW.kind = 'settlement' and NEW.user_id = '${account.user.id}' then raise exception 'e2e injected settlement failure'; end if; return NEW; end; $$; create trigger e2e_settlement_failure before insert on wallet_ledger for each row execute function e2e_settlement_failure();`,
    );
    const beforeRetryWallet = await user.wallet.get.query();
    const beforeRetryCalls = calls;
    let retryId: string;
    try {
      const deferred = await send();
      retryId = deferred.headers.get('x-request-id') as string;
      assert.ok(retryId);
      await deferred.text();
      const deferredBill = await user.requestDetail.query({ requestId: retryId });
      assert.equal(deferredBill.status, 'settling');
      assert.equal(deferredBill.usageFinal, true);
      assert.equal(deferredBill.ledger.filter((e) => e.kind === 'settlement').length, 0);
      assert.equal((await user.wallet.get.query()).balance, beforeRetryWallet.balance);
      assert.equal((await user.wallet.get.query()).reserved, '0.000528');
    } finally {
      await controls.sql(
        'drop trigger e2e_settlement_failure on wallet_ledger; drop function e2e_settlement_failure();',
      );
    }
    const retryDeadline = Date.now() + 20000;
    for (;;) {
      const retried = await user.requestDetail.query({ requestId: retryId });
      if (retried.status === 'settled') {
        assert.equal(retried.charged, '0.000015');
        assert.equal(retried.ledger.filter((e) => e.kind === 'settlement').length, 1);
        break;
      }
      if (Date.now() > retryDeadline) throw new Error('Persisted settlement did not recover after database failure');
      await setTimeout(100);
    }
    assert.equal(calls, beforeRetryCalls + 1);
    await consistent();
    // A persistently failing bill must not prevent startup or hide the retained hold from administrators.
    await controls.sql(
      `create function e2e_settlement_failure() returns trigger language plpgsql as $$ begin if NEW.kind = 'settlement' and NEW.user_id = '${account.user.id}' then raise exception 'e2e injected settlement failure'; end if; return NEW; end; $$; create trigger e2e_settlement_failure before insert on wallet_ledger for each row execute function e2e_settlement_failure();`,
    );
    let failedId: string;
    try {
      const failed = await send();
      failedId = failed.headers.get('x-request-id') as string;
      await failed.text();
      await controls.restart();
      const reviewed = await user.requestDetail.query({ requestId: failedId });
      assert.equal(reviewed.status, 'needs_review');
      assert.equal(reviewed.usageFinal, true);
      assert.equal(reviewed.held, '0.000528');
      assert.equal(reviewed.errorCode, 'billing_processing_failed');
    } finally {
      await controls.sql(
        'drop trigger e2e_settlement_failure on wallet_ledger; drop function e2e_settlement_failure();',
      );
    }
    await admin.admin.billing.resolve.mutate({
      requestId: failedId,
      action: 'settle_usage',
      usage: { inputTokens: '10', outputTokens: '5', cacheReadTokens: '0', cacheWriteTokens: '0' },
      reason: 'e2e confirmed final usage after repairing financial write',
      idempotencyKey: randomUUID(),
    });
    assert.equal((await user.requestDetail.query({ requestId: failedId })).charged, '0.000015');
    await consistent();
    const cacheVersion = await admin.admin.pricing.createDraft.mutate({
      modelId: model.id,
      endpoint: '/v1/chat/completions',
      sourceVersionId: version.id,
    });
    const originalRules = (
      await admin.admin.pricing.list.query({ modelId: model.id, endpoint: '/v1/chat/completions' })
    ).versions.find((v) => v.id === version.id)?.rules;
    assert.ok(originalRules);
    await admin.admin.pricing.saveDraft.mutate({
      versionId: cacheVersion.id,
      rules: originalRules.map((r) => ({ ...r, cacheReadPrice: null })),
    });
    await admin.admin.pricing.publish.mutate({ versionId: cacheVersion.id });
    mode = 'unpriced-cache';
    const unpriced = await send();
    const unpricedId = unpriced.headers.get('x-request-id');
    assert.ok(unpricedId);
    await unpriced.text();
    const unpricedBill = await user.requestDetail.query({ requestId: unpricedId });
    assert.equal(unpricedBill.status, 'needs_review');
    assert.equal(unpricedBill.errorCode, 'price_unconfigured');
    assert.equal(unpricedBill.usageFinal, true);
    assert.equal(unpricedBill.held, '0.000528');
    const confirmed = {
      requestId: unpricedId,
      action: 'settle_amount' as const,
      amount: '0.000020',
      reason: 'e2e confirmed historical cached pricing with upstream records',
      idempotencyKey: randomUUID(),
    };
    await Promise.all([admin.admin.billing.resolve.mutate(confirmed), admin.admin.billing.resolve.mutate(confirmed)]);
    const confirmedBill = await user.requestDetail.query({ requestId: unpricedId });
    assert.equal(confirmedBill.charged, '0.000020');
    assert.equal(confirmedBill.pricing?.source, 'administrator_amount');
    await consistent();
    // A zero multiplier requires neither a positive reserve nor a spurious reserve ledger row.
    mode = 'normal';
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, multiplier: '0' });
    const free = await send();
    const freeId = free.headers.get('x-request-id');
    assert.ok(freeId);
    await free.text();
    const freeBill = await user.requestDetail.query({ requestId: freeId });
    assert.equal(freeBill.status, 'settled');
    assert.equal(freeBill.charged, '0.000000');
    assert.equal(freeBill.ledger.filter((e) => e.kind === 'reserve').length, 0);
    await consistent();
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id });
    mode = 'overrun';
    const overrun = await send();
    const overrunId = overrun.headers.get('x-request-id');
    assert.ok(overrunId);
    await overrun.text();
    const overrunBill = await user.requestDetail.query({ requestId: overrunId });
    assert.equal(overrunBill.charged, '1.000005');
    assert.equal(overrunBill.held, '0.000000');
    assert.equal(overrunBill.ledger.find((e) => e.kind === 'settlement')?.metadata.exceededReservation, true);
    assert.equal((await user.wallet.get.query()).balance, '-0.989557');
    const beforeDebt = calls;
    const debt = await send();
    assert.equal(debt.status, 402);
    await debt.text();
    assert.equal(calls, beforeDebt);
    await consistent();
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
  }
}
