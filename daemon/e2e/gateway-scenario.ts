import type { TRPCClient } from '@trpc/client';

import type { AppRouter } from '../src/trpc/router.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const endpoints = ['/v1/chat/completions', '/v1/responses', '/v1/messages'] as const;
type Rpc = TRPCClient<AppRouter>;

export async function gatewayScenario(url: string, admin: Rpc, user: Rpc, other: Rpc, userId: string) {
  const calls: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown>; expected: string }[] = [];
  let mode:
    | 'normal'
    | 'http-error'
    | 'missing'
    | 'timeout'
    | 'cancel'
    | 'redirect'
    | 'partial'
    | 'stream-error'
    | 'repeated-final' = 'normal';
  let disconnected = false;
  let streamGate: Promise<void> | undefined;
  let releaseStream: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const path = req.url ?? '';
    const captured = { path, headers: req.headers, body, expected: '' };
    calls.push(captured);
    const currentMode = mode;
    res.on('close', () => {
      if (!res.writableFinished) disconnected = true;
    });
    if (currentMode === 'timeout') return;
    if (currentMode === 'redirect') {
      res.writeHead(307, { location: 'http://127.0.0.1:1/credential-leak' });
      res.end();
      return;
    }
    if (currentMode === 'http-error') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7', 'set-cookie': 'secret=upstream' });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'mock limited' } }));
      return;
    }
    const chat = path.endsWith('/chat/completions');
    const messages = path.endsWith('/messages');
    const usage = chat
      ? { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } }
      : messages
        ? { input_tokens: 14, output_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }
        : { input_tokens: 20, output_tokens: 7, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } };
    const payload = chat
      ? {
          id: 'chat_mock',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop', index: 0 }],
          usage,
        }
      : messages
        ? {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '你好' }],
            stop_reason: 'end_turn',
            usage,
          }
        : { id: 'resp_mock', object: 'response', status: 'completed', output: [], usage };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'upstream_mock' });
      if (currentMode === 'missing') delete (payload as { usage?: unknown }).usage;
      captured.expected = JSON.stringify(payload);
      res.end(captured.expected);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'secret=upstream' });
    const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
    const start = chat
      ? event({ id: 'chat_mock', choices: [{ delta: { content: '你好' }, index: 0 }], usage: null })
      : messages
        ? event({ type: 'message_start', message: { id: 'msg_mock', usage: { ...usage, output_tokens: 0 } } })
        : event({ type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } });
    // Break UTF-8 and CRLF boundaries across real HTTP writes.
    const startBytes = Buffer.from(`: keepalive\r\n\r\n${start}`);
    for (let offset = 0; offset < startBytes.length; offset += 7) {
      res.write(startBytes.subarray(offset, offset + 7));
      await setTimeout(1);
    }
    if (currentMode === 'cancel') return;
    if (streamGate) await streamGate;
    await setTimeout(150);
    if (res.destroyed) return;
    if (currentMode === 'stream-error') {
      res.end(event({ type: 'error', error: { type: 'api_error', message: 'mock stream failed' } }));
      return;
    }
    const tail = chat
      ? `${currentMode === 'repeated-final' ? event({ id: 'chat_mock', choices: [], usage: { ...usage, completion_tokens: 5 } }) : ''}${event({ id: 'chat_mock', choices: [], usage })}${currentMode === 'repeated-final' ? event({ id: 'chat_mock', choices: [], usage }) : ''}data: [DONE]\r\n\r\n`
      : messages
        ? event({ type: 'message_delta', usage: { output_tokens: 5 } }) +
          event({ type: 'message_delta', usage: { output_tokens: 7 } }) +
          event({ type: 'message_stop' })
        : event({ type: 'response.completed', response: payload });
    captured.expected = startBytes.toString('utf8') + tail;
    const bytes = Buffer.from(tail);
    const sent = currentMode === 'partial' ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes;
    for (let offset = 0; offset < sent.length; offset += 11) {
      res.write(sent.subarray(offset, offset + 11));
      await setTimeout(1);
    }
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing upstream address');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const credential = 'mock-channel-secret';
    const model = await admin.admin.catalog.saveModel.mutate({
      name: 'gateway-test',
      enabled: true,
      endpoints: [...endpoints],
    });
    const anotherModel = await admin.admin.catalog.saveModel.mutate({
      name: 'chat-only',
      enabled: true,
      endpoints: [endpoints[0]],
    });
    const channelInput = {
      name: 'mock upstream',
      baseUrl,
      credential,
      endpoints: [...endpoints],
      enabled: true,
      timeoutMs: 5000,
      multiplier: '1.5',
      availableModels: [
        { modelId: model.id, multiplier: '0.5' },
        { modelId: anotherModel.id, multiplier: null },
      ],
    };
    const channel = await admin.admin.catalog.saveChannel.mutate(channelInput);
    for (const endpoint of endpoints) {
      const version = await admin.admin.pricing.createDraft.mutate({ modelId: model.id, endpoint });
      await admin.admin.pricing.saveDraft.mutate({
        versionId: version.id,
        rules: [
          {
            label: '默认',
            kind: 'default',
            contextMin: null,
            contextMax: null,
            weekdaysMask: null,
            startMinute: null,
            endMinute: null,
            inputPrice: '1',
            outputPrice: '2',
            cacheReadPrice: '0.5',
            cacheWritePrice: '0.25',
          },
        ],
      });
      await admin.admin.pricing.publish.mutate({ versionId: version.id });
    }
    await admin.admin.catalog.setGrants.mutate({ userId, modelIds: [model.id, anotherModel.id] });
    const key = await user.keys.create.mutate({ channelId: channel.id, name: 'gateway e2e', modelIds: [model.id] });
    const otherKey = await other.keys.create.mutate({
      channelId: (await other.keys.channels.query())[0].id,
      name: 'ungranted gateway e2e',
    });
    await assert.rejects(() => user.admin.catalog.list.query());
    await assert.rejects(() => user.admin.catalog.saveChannel.mutate(channelInput));
    const catalog = await admin.admin.catalog.list.query();
    assert.ok(!JSON.stringify(catalog).includes(credential));
    assert.ok(!JSON.stringify(catalog).includes('credentialEncrypted'));
    // Updating an existing channel with live bindings must retain its credential.
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, credential: undefined });
    const send = (
      endpoint: string,
      body: Record<string, unknown> = {},
      token = key.token,
      extraHeaders: Record<string, string> = {},
      signal?: AbortSignal,
    ) =>
      fetch(`${url}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(endpoint === endpoints[2]
            ? { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta' }
            : { authorization: `Bearer ${token}` }),
          ...extraHeaders,
        },
        body: JSON.stringify({
          model: 'gateway-test',
          ...(endpoint === endpoints[1]
            ? { max_output_tokens: 32 }
            : endpoint === endpoints[2]
              ? { max_tokens: 32 }
              : { max_completion_tokens: 32 }),
          ...(body.stream === true && endpoint === endpoints[0] ? { stream_options: { include_usage: true } } : {}),
          ...body,
        }),
        signal,
      });
    assert.equal((await send(endpoints[0], {}, 'invalid')).status, 401);
    assert.equal((await send(endpoints[2], {}, 'invalid')).status, 401);
    assert.equal((await send(endpoints[0], {}, otherKey.token)).status, 403);
    assert.equal((await send(endpoints[0], { model: 'chat-only' })).status, 403);
    assert.equal((await send(endpoints[2], { model: 'chat-only' })).status, 404);
    assert.equal((await send(endpoints[1], { background: true })).status, 400);
    assert.equal((await send(endpoints[0], { input: 'x'.repeat(5000) })).status, 413);
    assert.equal((await fetch(`${url}${endpoints[0]}`)).status, 405);
    assert.equal((await send(endpoints[0], { max_completion_tokens: undefined })).status, 400);
    assert.equal((await send(endpoints[0], { max_completion_tokens: 0 })).status, 400);
    assert.equal((await send(endpoints[0], { tools: [{ type: 'web_search' }] })).status, 400);
    assert.equal(
      (
        await send(endpoints[0], {
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] },
          ],
        })
      ).status,
      400,
    );

    const startingCalls = calls.length;
    const completedIds: string[] = [];
    for (const endpoint of endpoints) {
      for (const stream of [false, true]) {
        const response = await send(
          endpoint,
          {
            stream,
            messages: [{ role: 'user', content: 'hello' }],
            input: 'hello',
            stream_options: { include_usage: true },
          },
          key.token,
          { cookie: 'local=session', 'x-client-secret': 'do-not-forward', 'openai-organization': 'do-not-forward' },
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('set-cookie'), null);
        const id = response.headers.get('x-request-id');
        assert.ok(id);
        completedIds.push(id);
        const reader = response.body?.getReader();
        assert.ok(reader);
        const first = await reader.read();
        assert.ok(first.value?.length);
        if (stream) assert.equal(response.headers.get('x-accel-buffering'), 'no');
        if (stream) {
          assert.ok(
            !Buffer.from(first.value)
              .toString()
              .includes(
                endpoint === endpoints[0]
                  ? '[DONE]'
                  : endpoint === endpoints[1]
                    ? 'response.completed'
                    : 'message_stop',
              ),
            'SSE must deliver the first bytes before the final usage event',
          );
        }
        const responseChunks = [Buffer.from(first.value)];
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          responseChunks.push(Buffer.from(part.value));
        }
        const content = Buffer.concat(responseChunks).toString('utf8');
        if (stream) assert.match(content, /data:/);
        else assert.ok(JSON.parse(content).usage);
        const call = calls.at(-1);
        assert.ok(call);
        assert.equal(content, call.expected);
        assert.equal(call.path, endpoint);
        assert.equal(call.body.model, 'gateway-test');
        assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hello' }]);
        assert.equal(call.headers.cookie, undefined);
        assert.equal(call.headers['x-client-secret'], undefined);
        assert.equal(call.headers['openai-organization'], undefined);
        if (endpoint === endpoints[2]) {
          assert.equal(call.headers['x-api-key'], credential);
          assert.equal(call.headers.authorization, undefined);
          assert.equal(call.headers['anthropic-beta'], 'test-beta');
        } else {
          assert.equal(call.headers.authorization, `Bearer ${credential}`);
          assert.equal(call.headers['x-api-key'], undefined);
        }
      }
    }
    // A second usable channel never becomes a fallback for a channel-bound Key.
    const secondChannel = await admin.admin.catalog.saveChannel.mutate({
      ...channelInput,
      name: 'second upstream',
      credential: 'second-channel-secret',
      multiplier: '2',
      availableModels: [{ modelId: model.id, multiplier: null }],
    });
    const secondKey = await user.keys.create.mutate({ name: 'second channel', channelId: secondChannel.id });
    const pinned = await send(endpoints[0], {}, secondKey.token);
    await pinned.text();
    assert.equal(calls.at(-1)?.headers.authorization, 'Bearer second-channel-secret');
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, enabled: false });
    const beforeUnavailable = calls.length;
    assert.equal((await send(endpoints[0])).status, 503);
    assert.equal(calls.length, beforeUnavailable);
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, availableModels: [] });
    assert.equal((await send(endpoints[0])).status, 503);
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id });
    assert.equal(calls.length, startingCalls + 7);
    const records = await user.requests.query();
    for (const id of completedIds) {
      const record = records.items.find((r) => r.id === id);
      assert.ok(record);
      assert.equal(record.status, 'settled');
      assert.equal(record.chargedAmount, '0.000016');
      assert.equal(record.heldAmount, '0.000000');
      assert.equal(record.quotedAmount, '0.000016');
      assert.equal(record.pricing?.multiplier, '0.500000');
      assert.deepEqual(record.usage, { input: '14', output: '7', cacheRead: '4', cacheWrite: '2', context: '20' });
    }
    assert.ok(!(await other.requests.query()).items.some((r) => completedIds.includes(r.id)));
    assert.equal((await user.wallet.get.query()).balance, '9.999843');
    assert.equal((await user.wallet.get.query()).reserved, '0.000000');
    mode = 'repeated-final';
    const repeated = await send(endpoints[0], { stream: true });
    const repeatedId = repeated.headers.get('x-request-id');
    assert.ok(repeatedId);
    await repeated.text();
    const repeatedBill = await user.requestDetail.query({ requestId: repeatedId });
    assert.equal(repeatedBill.charged, '0.000016');
    assert.equal(repeatedBill.usage?.outputTokens, '7');
    assert.equal(repeatedBill.ledger.filter((e) => e.kind === 'settlement').length, 1);
    mode = 'normal';
    // Pin price version and multiplier at receipt, even when an administrator changes both during SSE.
    const originalVersion = (await admin.admin.pricing.list.query({ modelId: model.id, endpoint: endpoints[0] }))
      .versions[0];
    streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const held = await send(endpoints[0], { stream: true });
    const heldId = held.headers.get('x-request-id');
    const heldReader = held.body?.getReader();
    assert.ok(heldReader);
    await heldReader.read();
    const heldWallet = await user.wallet.get.query();
    assert.equal(heldWallet.reserved, '0.016416');
    const replacement = await admin.admin.pricing.createDraft.mutate({
      modelId: model.id,
      endpoint: endpoints[0],
      sourceVersionId: originalVersion.id,
    });
    await admin.admin.pricing.saveDraft.mutate({
      versionId: replacement.id,
      rules: originalVersion.rules.map((r) => ({ ...r, inputPrice: '9' })),
    });
    await admin.admin.pricing.publish.mutate({ versionId: replacement.id });
    await admin.admin.catalog.saveChannel.mutate({
      ...channelInput,
      id: channel.id,
      multiplier: '9',
      availableModels: [
        { modelId: model.id, multiplier: '9' },
        { modelId: anotherModel.id, multiplier: null },
      ],
    });
    releaseStream?.();
    streamGate = undefined;
    while (!(await heldReader.read()).done) {
      /* Consume the same response without making another upstream request. */
    }
    const heldRecord = (await user.requests.query()).items.find((r) => r.id === heldId);
    assert.ok(heldRecord);
    assert.equal(heldRecord.pricing?.versionId, originalVersion.id);
    assert.equal(heldRecord.pricing?.multiplier, '0.500000');
    assert.equal(heldRecord.quotedAmount, '0.000016');
    const repriced = await send(endpoints[0]);
    const repricedId = repriced.headers.get('x-request-id');
    await repriced.text();
    const repricedRecord = (await user.requests.query()).items.find((r) => r.id === repricedId);
    assert.ok(repricedRecord);
    assert.equal(repricedRecord.pricing?.versionId, replacement.id);
    assert.equal(repricedRecord.pricing?.multiplier, '9.000000');
    assert.equal(repricedRecord.quotedAmount, '0.001283');
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id });
    // Never retry an upstream rejection or follow a redirect.
    mode = 'http-error';
    const beforeError = calls.length;
    const error = await send(endpoints[0]);
    assert.equal(error.status, 429);
    assert.equal(error.headers.get('retry-after'), '7');
    assert.equal(error.headers.get('set-cookie'), null);
    assert.match(await error.text(), /mock limited/);
    assert.equal(calls.length, beforeError + 1);
    const rejectedBill = await user.requestDetail.query({ requestId: error.headers.get('x-request-id') as string });
    assert.equal(rejectedBill.status, 'released');
    assert.equal(rejectedBill.held, '0.000000');
    assert.equal(rejectedBill.charged, '0.000000');
    mode = 'redirect';
    const redirect = await send(endpoints[0]);
    assert.equal(redirect.status, 502);
    await redirect.text();
    mode = 'missing';
    const missing = await send(endpoints[0]);
    const missingId = missing.headers.get('x-request-id');
    await missing.text();
    assert.equal((await user.requests.query()).items.find((r) => r.id === missingId)?.errorCode, 'usage_missing');
    mode = 'partial';
    const partial = await send(endpoints[0], { stream: true });
    const partialId = partial.headers.get('x-request-id');
    await partial.text();
    assert.equal((await user.requests.query()).items.find((r) => r.id === partialId)?.status, 'needs_review');
    mode = 'stream-error';
    const streamError = await send(endpoints[2], { stream: true });
    const streamErrorId = streamError.headers.get('x-request-id');
    assert.match(await streamError.text(), /mock stream failed/);
    assert.equal((await user.requests.query()).items.find((r) => r.id === streamErrorId)?.errorCode, 'upstream_error');
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, timeoutMs: 150 });
    mode = 'timeout';
    disconnected = false;
    const timeout = await send(endpoints[0]);
    assert.equal(timeout.status, 504);
    await timeout.text();
    await setTimeout(50);
    assert.equal(disconnected, true);
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id });
    mode = 'cancel';
    disconnected = false;
    const controller = new AbortController();
    const cancelled = await send(endpoints[0], { stream: true }, key.token, {}, controller.signal);
    const cancelledId = cancelled.headers.get('x-request-id');
    const reader = cancelled.body?.getReader();
    assert.ok(reader);
    await reader.read();
    // Per-user concurrency applies across all Keys.
    const siblingController = new AbortController();
    const siblingCancelled = await send(endpoints[0], { stream: true }, secondKey.token, {}, siblingController.signal);
    const siblingCancelledId = siblingCancelled.headers.get('x-request-id');
    const siblingReader = siblingCancelled.body?.getReader();
    assert.ok(siblingReader);
    await siblingReader.read();
    assert.equal((await send(endpoints[0])).status, 429);
    siblingController.abort();
    await siblingReader.cancel().catch(() => {});
    controller.abort();
    await reader.cancel().catch(() => {});
    const deadline = Date.now() + 3000;
    for (;;) {
      const record = (await user.requests.query()).items.find((r) => r.id === cancelledId);
      if (disconnected && record?.status === 'needs_review') break;
      if (Date.now() > deadline) throw new Error('Client cancellation did not cancel and record the upstream request');
      await setTimeout(50);
    }
    // Manual resolution is role-restricted, idempotent and uses the pinned price.
    const missingDetail = await user.requestDetail.query({ requestId: missingId as string });
    assert.equal(missingDetail.status, 'needs_review');
    assert.equal(missingDetail.held, '0.147488');
    await assert.rejects(() => other.requestDetail.query({ requestId: missingId as string }));
    const resolution = {
      requestId: missingId as string,
      action: 'settle_usage' as const,
      usage: { inputTokens: '14', outputTokens: '7', cacheReadTokens: '4', cacheWriteTokens: '2' },
      reason: 'e2e confirmed upstream usage',
      idempotencyKey: randomUUID(),
    };
    await assert.rejects(() => user.admin.billing.resolve.mutate(resolution));
    const beforeManual = await user.wallet.get.query();
    await Promise.all([admin.admin.billing.resolve.mutate(resolution), admin.admin.billing.resolve.mutate(resolution)]);
    const resolved = await user.requestDetail.query({ requestId: missingId as string });
    assert.equal(resolved.status, 'settled');
    assert.equal(resolved.charged, '0.000072');
    assert.equal(resolved.ledger.filter((e) => e.kind === 'settlement').length, 1);
    assert.notEqual((await user.wallet.get.query()).reserved, beforeManual.reserved);
    await assert.rejects(() => admin.admin.billing.resolve.mutate({ ...resolution, reason: 'different evidence' }));
    for (const requestId of [
      redirect.headers.get('x-request-id'),
      partialId,
      streamErrorId,
      timeout.headers.get('x-request-id'),
      cancelledId,
      siblingCancelledId,
    ]) {
      assert.ok(requestId);
      const action = {
        requestId,
        action: 'release' as const,
        reason: 'e2e upstream reconciliation confirmed no billable consumption',
        idempotencyKey: randomUUID(),
      };
      await Promise.all([admin.admin.billing.resolve.mutate(action), admin.admin.billing.resolve.mutate(action)]);
      assert.equal((await user.requestDetail.query({ requestId })).status, 'released');
    }
    const correction = { requestId: completedIds[0], amount: '0', reason: 'e2e refund', idempotencyKey: randomUUID() };
    await Promise.all([admin.admin.billing.correct.mutate(correction), admin.admin.billing.correct.mutate(correction)]);
    assert.equal((await user.requestDetail.query({ requestId: completedIds[0] })).charged, '0.000000');
    await assert.rejects(() => admin.admin.billing.correct.mutate({ ...correction, amount: '1' }));
    await admin.admin.billing.correct.mutate({
      ...correction,
      amount: '0.000010',
      reason: 'e2e corrected final fee',
      idempotencyKey: randomUUID(),
    });
    const corrected = await user.requestDetail.query({ requestId: completedIds[0] });
    assert.equal(corrected.charged, '0.000010');
    assert.equal(corrected.ledger.filter((e) => e.kind === 'correction').length, 2);
    assert.equal((await admin.admin.billing.reconcile.query({ userId })).consistent, true);
    assert.equal((await user.wallet.get.query()).reserved, '0.000000');
    mode = 'normal';
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, enabled: false });
    assert.equal((await send(endpoints[0])).status, 503);
    await admin.admin.catalog.saveChannel.mutate({ ...channelInput, id: channel.id, enabled: true });
    await admin.admin.catalog.setGrants.mutate({ userId, modelIds: [] });
    assert.equal((await send(endpoints[0])).status, 403);
    await admin.admin.catalog.setGrants.mutate({ userId, modelIds: [model.id] });
    await admin.admin.users.setStatus.mutate({ userId, status: 'disabled' });
    assert.equal((await send(endpoints[0])).status, 401);
    await admin.admin.users.setStatus.mutate({ userId, status: 'active' });
    await user.auth.login.mutate({ username: 'alice', password: 'e2e-alice-reset-password' });
    await user.keys.revoke.mutate({ keyId: key.id });
    assert.equal((await send(endpoints[0])).status, 401);
    assert.ok(!JSON.stringify(await admin.admin.requests.query()).includes(credential));
  } finally {
    releaseStream?.();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  }
}
