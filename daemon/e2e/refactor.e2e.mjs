// 重构期间的临时 e2e 安全网：通过真实入口（tRPC + 网关）验证关键业务流程，重构完成后删除。
// 运行：pnpm --filter @ohmyapi/daemon e2e（需要本地 Postgres，见 compose.yaml）。
import { Client } from 'pg';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const daemonDir = fileURLToPath(new URL('../', import.meta.url));
process.loadEnvFile(new URL('../../.env', import.meta.url));
const adminUrl = new URL(process.env.DATABASE_URL);
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = '/ohmyapi_e2e';
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(port),
  DATABASE_URL: databaseUrl.toString(),
  BILLING_CURRENCY: 'USD',
  SESSION_COOKIE_SECURE: 'false',
  CHANNEL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  BOOTSTRAP_ADMIN_USERNAME: 'admin',
  BOOTSTRAP_ADMIN_PASSWORD: 'admin-password-e2e',
};

// ---- 进程管理 ----
let daemon;
let logs = '';
function run(script) {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: daemonDir, env });
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  return child;
}
async function runToEnd(script) {
  const child = run(script);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${script} failed\n${logs}`);
}
async function startDaemon() {
  for (let attempt = 0; attempt < 20; attempt++) {
    daemon = run('src/index.ts');
    let exited = false;
    daemon.once('exit', () => {
      exited = true;
    });
    for (let i = 0; i < 100 && !exited; i++) {
      const ready = await fetch(`${base}/api/ready`).catch(() => undefined);
      if (ready?.status === 200) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 上一进程的计费所有权锁可能尚未被数据库释放，稍后重试。
    if (!exited) daemon.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`daemon did not become ready\n${logs}`);
}
async function stopDaemon(signal = 'SIGTERM') {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit');
  daemon.kill(signal);
  await exited;
}

// ---- 模拟上游 ----
const upstreamCalls = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  upstreamCalls.push({ url: req.url, headers: req.headers, body });
  const prompt = JSON.stringify(body.messages ?? '');
  if (req.url.startsWith('/v1/models')) {
    assert.equal(req.headers.authorization, 'Bearer upstream-secret');
    const second = req.url.includes('after_id=page-1');
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify(
          second
            ? { data: [{ id: 'other-model' }], has_more: false }
            : { data: [{ id: 'e2e-model' }, { id: 'bad name!' }], has_more: true, last_id: 'page-1' },
        ),
      );
    return;
  }
  if (req.url === '/v1/chat/completions' && req.headers.authorization !== 'Bearer upstream-secret') {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"bad key"}}');
    return;
  }
  if (req.url === '/v1/chat/completions' && body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'up-stream' });
    const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    event({ id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'he' } }] });
    // 'hang' 请求只返回一个片段且不结束，用于模拟进程中断。
    if (prompt.includes('hang')) return;
    event({ id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'llo' } }] });
    event({
      id: 'c2',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 2000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'up-chat' }).end(
      JSON.stringify({
        id: 'c1',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } },
      }),
    );
    return;
  }
  if (req.url === '/v1/messages') {
    assert.equal(req.headers['x-api-key'], 'upstream-secret');
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'up-msg' }).end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// ---- tRPC 客户端 ----
class Session {
  cookie;
  async call(method, path, input) {
    const query = method === 'GET' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
    const res = await fetch(`${base}/api/trpc/${path}${query}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-ohmyapi-request': '1',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: method === 'POST' && input !== undefined ? JSON.stringify(input) : undefined,
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      this.cookie = pair.endsWith('=') ? undefined : pair;
    }
    const json = await res.json();
    if (json.error) {
      const error = new Error(`${path}: ${json.error.message}`);
      error.code = json.error.data?.code;
      error.status = res.status;
      error.rpcMessage = json.error.message;
      error.fieldErrors = json.error.data?.fieldErrors;
      throw error;
    }
    return json.result.data;
  }
  query(path, input) {
    return this.call('GET', path, input);
  }
  mutate(path, input) {
    return this.call('POST', path, input);
  }
}
async function rejects(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    if (message !== undefined) assert.equal(error.rpcMessage, message);
    return true;
  });
}

const gateway = (path, key, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });

// ---- 共享状态 ----
const admin = new Session();
const user = new Session();
const state = {};

before(async () => {
  const pg = new Client({ connectionString: adminUrl.toString() });
  await pg.connect();
  await pg.query('drop database if exists ohmyapi_e2e with (force)');
  await pg.query('create database ohmyapi_e2e');
  await pg.end();
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  state.upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  await runToEnd('src/cli/migrate.ts');
  await runToEnd('src/cli/init.ts');
  await startDaemon();
});

after(async () => {
  await stopDaemon();
  upstream.close();
});

test('认证、目录配置、Key 与网关结算主流程', async () => {
  // 认证
  assert.equal(await admin.query('auth.me'), null);
  await rejects(
    admin.mutate('auth.login', { username: 'admin', password: 'wrong-password' }),
    'UNAUTHORIZED',
    '用户名或密码错误',
  );
  // 输入校验错误返回首条校验消息和字段错误
  await assert.rejects(admin.mutate('auth.login', { username: 'A', password: 'x' }), (error) => {
    assert.equal(error.code, 'BAD_REQUEST');
    assert.equal(error.status, 400);
    assert.equal(error.rpcMessage, '用户名需为 3–64 位小写字母、数字、点、下划线或连字符');
    assert.ok(error.fieldErrors.username);
    return true;
  });
  const me = await admin.mutate('auth.login', { username: 'admin', password: 'admin-password-e2e' });
  assert.equal(me.role, 'admin');
  const created = await admin.mutate('admin.users.create', { username: 'alice', password: 'alice-password' });
  state.userId = created.user.id;
  await user.mutate('auth.login', { username: 'alice', password: 'alice-password' });
  await rejects(user.query('admin.users.list'), 'FORBIDDEN', '需要管理员权限');
  await rejects(admin.mutate('admin.users.create', { username: 'alice', password: 'alice-password' }), 'CONFLICT');
  await rejects(admin.query('admin.users.get', { userId: randomUUID() }), 'NOT_FOUND', '用户不存在');

  // 渠道、模型与价格
  const channel = await admin.mutate('admin.catalog.saveChannel', {
    name: 'e2e-api',
    type: 'api',
    baseUrl: state.upstreamUrl,
    credential: 'upstream-secret',
    enabled: true,
    isPublic: false,
    timeoutMs: 30_000,
    availableModels: [{ name: 'e2e-model', multiplier: null }],
    endpoints: ['/v1/chat/completions', '/v1/messages'],
  });
  state.channelId = channel.id;
  assert.deepEqual(
    channel.unpricedModels.map((m) => m.name),
    ['e2e-model'],
  );
  const catalog = await admin.query('admin.catalog.list');
  const model = catalog.models.find((m) => m.name === 'e2e-model');
  assert.equal(model.priced, false);
  await admin.mutate('admin.pricing.save', {
    modelId: model.id,
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
        cacheWritePrice: '1.25',
      },
    ],
  });
  assert.equal((await admin.query('admin.pricing.list', { modelId: model.id })).rules.length, 1);

  // 渠道授权与 Key
  await rejects(
    user.mutate('keys.create', { name: 'k', channelId: channel.id }),
    'FORBIDDEN',
    '渠道不可用、未授权或没有可用模型',
  );
  await admin.mutate('admin.catalog.setGrants', { userId: state.userId, channelIds: [channel.id] });
  // 分页与搜索：LIKE 通配符按字面匹配
  const found = await admin.query('admin.users.list', { page: 0, search: 'lic' });
  assert.deepEqual(
    found.items.map((u) => u.username),
    ['alice'],
  );
  assert.equal(found.hasMore, false);
  assert.equal((await admin.query('admin.users.list', { page: 0, search: 'a_i' })).items.length, 0);
  assert.equal((await admin.query('admin.users.list', { page: 1, search: '' })).items.length, 0);
  const grants = await admin.query('admin.catalog.channelGrants', { channelId: channel.id, page: 0, search: 'ali' });
  assert.deepEqual(grants, {
    items: [{ id: state.userId, username: 'alice', status: 'active', granted: true }],
    hasMore: false,
  });
  assert.deepEqual(
    (await user.query('keys.channels')).map((c) => c.id),
    [channel.id],
  );
  const plaza = await user.query('modelPlaza');
  assert.deepEqual(
    plaza.models.map((m) => m.name),
    ['e2e-model'],
  );
  const key = await user.mutate('keys.create', { name: 'main', channelId: channel.id });
  state.key = key.token;
  assert.equal((await user.query('keys.list', { page: 0 })).items.length, 1);

  // 模型列表
  const openaiModels = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${state.key}` } });
  assert.equal(openaiModels.status, 200);
  assert.deepEqual(
    (await openaiModels.json()).data.map((m) => m.id),
    ['e2e-model'],
  );
  const anthropicModels = await fetch(`${base}/v1/models`, {
    headers: { 'x-api-key': state.key, 'anthropic-version': '2023-06-01' },
  });
  assert.equal((await anthropicModels.json()).data[0].type, 'model');

  // 网关拒绝路径
  const noKey = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(noKey.status, 401);
  assert.equal((await noKey.json()).error.type, 'authentication_error');
  const notJson = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: `Bearer ${state.key}` },
    body: '{}',
  });
  assert.equal(notJson.status, 415);
  assert.equal((await notJson.json()).error.code, 'unsupported_media_type');
  const badJson = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.key}` },
    body: '{',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'invalid_json');
  const wrongMethod = await fetch(`${base}/v1/messages`, { headers: { 'x-api-key': state.key } });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await wrongMethod.json(), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Only POST is supported' },
    request_id: wrongMethod.headers.get('x-request-id'),
  });
  const unknownModel = await gateway('/v1/chat/completions', state.key, { model: 'nope', messages: [] });
  assert.equal(unknownModel.status, 404);
  assert.equal((await unknownModel.json()).error.code, 'model_not_found');
  const poor = await gateway('/v1/chat/completions', state.key, {
    model: 'e2e-model',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  });
  assert.equal(poor.status, 402);
  assert.equal((await poor.json()).error.code, 'insufficient_balance');

  // 充值
  await admin.mutate('admin.wallet.adjust', {
    userId: state.userId,
    amount: '10',
    reason: 'e2e 充值',
    idempotencyKey: randomUUID(),
  });

  // 非流式 Chat：输入 800、缓存读取 200、输出 500 → 0.001900
  const chat = await gateway('/v1/chat/completions', state.key, {
    model: 'e2e-model',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1000,
  });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, 'hello');
  const chatId = chat.headers.get('x-request-id');

  // 流式 Chat：输入 2000、输出 1000 → 0.004000，且向上游注入 include_usage
  const stream = await gateway('/v1/chat/completions', state.key, {
    model: 'e2e-model',
    messages: [{ role: 'user', content: 'stream please' }],
    stream: true,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const text = await stream.text();
  assert.match(text, /"llo"/);
  assert.match(text, /\[DONE\]/);
  assert.equal(upstreamCalls.at(-1).body.stream_options.include_usage, true);
  const streamId = stream.headers.get('x-request-id');

  // Messages：输入 300、缓存读取 100、输出 50 → 0.000450
  const message = await gateway(
    '/v1/messages',
    state.key,
    { model: 'e2e-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    { 'anthropic-version': '2023-06-01' },
  );
  assert.equal(message.status, 200);
  assert.equal((await message.json()).type, 'message');
  const messageId = message.headers.get('x-request-id');

  // 结算可能在响应返回后异步完成。
  let list;
  for (let i = 0; i < 50; i++) {
    list = await user.query('requests', { page: 0 });
    if (list.items.filter((r) => r.status === 'settled').length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const byId = Object.fromEntries(list.items.map((r) => [r.id, r]));
  assert.equal(byId[chatId].status, 'settled');
  assert.equal(byId[chatId].chargedAmount, '0.001900');
  assert.deepEqual(byId[chatId].usage, {
    input: '800',
    output: '500',
    cacheRead: '200',
    cacheWrite: '0',
    context: '1000',
    webSearchCalls: '0',
    webSearchPreviewCalls: '0',
  });
  assert.equal(byId[chatId].upstreamRequestId, 'c1');
  assert.equal(byId[streamId].chargedAmount, '0.004000');
  assert.equal(byId[streamId].streaming, true);
  assert.equal(byId[messageId].chargedAmount, '0.000450');
  assert.equal(byId[messageId].endpoint, '/v1/messages');
  const rejected = list.items.filter((r) => r.status === 'rejected').map((r) => r.errorCode);
  assert.deepEqual(rejected.sort(), ['insufficient_balance', 'model_not_found']);
  assert.equal(byId[chatId].pricing.routing, undefined);

  const detail = await user.query('requestDetail', { requestId: chatId });
  assert.deepEqual(
    detail.ledger.map((e) => [e.kind, e.amount]),
    [
      ['reserve', '0.000000'],
      ['settlement', '-0.001900'],
    ],
  );
  assert.equal(detail.preview.total, '0.001900');
  assert.deepEqual(detail.attempts, []);
  const adminDetail = await admin.query('requestDetail', { requestId: chatId });
  assert.equal(adminDetail.attempts.length, 1);

  const wallet = await user.query('wallet.get');
  assert.equal(wallet.balance, '9.993650');
  assert.equal(wallet.reserved, '0.000000');
  const ledger = await user.query('wallet.ledger', { page: 0 });
  assert.equal(ledger.items.length, 7);
  assert.ok(await user.query('wallet.stats'));
  assert.ok(await admin.query('admin.stats'));
  assert.equal((await admin.query('admin.billing.reconcile', { userId: state.userId })).consistent, true);

  // 修改密码会轮换会话，旧会话失效
  const stale = new Session();
  stale.cookie = user.cookie;
  await user.mutate('auth.changePassword', { currentPassword: 'alice-password', newPassword: 'alice-password-2' });
  assert.equal(await stale.query('auth.me'), null);
  assert.equal((await user.query('auth.me')).username, 'alice');
});

test('进程中断后的计费恢复与人工核对', async () => {
  // 三个流式请求在上游挂起时强制终止进程。
  const hung = [];
  for (let i = 0; i < 3; i++) {
    const res = await gateway('/v1/chat/completions', state.key, {
      model: 'e2e-model',
      messages: [{ role: 'user', content: `hang ${i}` }],
      stream: true,
      max_tokens: 100,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read();
    hung.push({ id: res.headers.get('x-request-id'), reader });
  }
  const before = await user.query('wallet.get');
  assert.notEqual(before.reserved, '0.000000');
  await stopDaemon('SIGKILL');
  for (const { reader } of hung) await reader.read().catch(() => {});
  await startDaemon();

  const review = await admin.query('admin.requests', { page: 0, reviewOnly: true });
  assert.deepEqual(review.items.map((r) => r.id).sort(), hung.map((h) => h.id).sort());
  for (const item of review.items) assert.equal(item.errorCode, 'process_interrupted');
  assert.equal(await admin.query('admin.reviewCount'), 3);
  assert.equal((await admin.query('admin.billing.reconcile', { userId: state.userId })).consistent, true);

  // 按确认用量结算（输入 100、输出 10 → 0.000120），重复提交保持幂等。
  const settle = {
    requestId: hung[0].id,
    action: 'settle_usage',
    reason: '上游账单',
    idempotencyKey: randomUUID(),
    usage: { inputTokens: '100', outputTokens: '10', cacheReadTokens: '0', cacheWriteTokens: '0' },
  };
  assert.equal((await admin.mutate('admin.billing.resolve', settle)).userId, state.userId);
  assert.equal((await admin.mutate('admin.billing.resolve', settle)).userId, state.userId);
  await rejects(admin.mutate('admin.billing.resolve', { ...settle, reason: '不同内容' }), 'CONFLICT');

  // 释放预占
  await admin.mutate('admin.billing.resolve', {
    requestId: hung[1].id,
    action: 'release',
    reason: '上游未执行',
    idempotencyKey: randomUUID(),
  });
  // 批量零元结算
  const zero = await admin.mutate('admin.billing.resolveZero', {
    requestIds: [hung[2].id],
    reason: '批量核对',
    idempotencyKey: randomUUID(),
  });
  assert.equal(zero.count, 1);
  await rejects(
    admin.mutate('admin.billing.resolve', {
      requestId: hung[2].id,
      action: 'release',
      reason: '重复',
      idempotencyKey: randomUUID(),
    }),
    'CONFLICT',
  );

  // 修正已结算费用（0.000120 → 0.000100，退还 0.000020）
  const correct = {
    requestId: hung[0].id,
    amount: '0.0001',
    reason: '账单修正',
    idempotencyKey: randomUUID(),
  };
  await admin.mutate('admin.billing.correct', correct);
  await admin.mutate('admin.billing.correct', correct);

  const statuses = Object.fromEntries(
    (await user.query('requests', { page: 0 })).items.map((r) => [r.id, [r.status, r.chargedAmount]]),
  );
  assert.deepEqual(statuses[hung[0].id], ['settled', '0.000100']);
  assert.deepEqual(statuses[hung[1].id], ['released', '0.000000']);
  assert.deepEqual(statuses[hung[2].id], ['settled', '0.000000']);
  assert.equal(await admin.query('admin.reviewCount'), 0);
  const detail = await user.query('requestDetail', { requestId: hung[0].id });
  assert.deepEqual(
    detail.ledger.map((e) => [e.kind, e.amount]),
    [
      ['reserve', '0.000000'],
      ['settlement', '-0.000120'],
      ['correction', '0.000020'],
    ],
  );
  const wallet = await user.query('wallet.get');
  assert.equal(wallet.balance, '9.993550');
  assert.equal(wallet.reserved, '0.000000');
  assert.equal((await admin.query('admin.billing.reconcile', { userId: state.userId })).consistent, true);

  // 撤销渠道授权后，已有 Key 立即失去调用权限
  await admin.mutate('admin.catalog.setGrants', { userId: state.userId, channelIds: [] });
  const revoked = await gateway('/v1/chat/completions', state.key, {
    model: 'e2e-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(revoked.status, 403);
  assert.equal((await revoked.json()).error.code, 'channel_forbidden');
});

test('模型目录与聚合渠道', async () => {
  // 从上游分页拉取模型，跳过名称无效的模型
  const fetched = await admin.mutate('admin.catalog.fetchChannelModels', {
    id: state.channelId,
    baseUrl: state.upstreamUrl,
  });
  assert.deepEqual(fetched, { names: ['e2e-model', 'other-model'], ignored: 1 });

  // 修改模型上限
  const model = (await admin.query('admin.catalog.list')).models.find((m) => m.name === 'e2e-model');
  await admin.mutate('admin.catalog.saveModel', {
    id: model.id,
    name: 'e2e-model',
    enabled: true,
    inputTokenLimit: 500_000,
    outputTokenLimit: 64_000,
  });
  const updated = (await admin.query('admin.catalog.list')).models.find((m) => m.id === model.id);
  assert.deepEqual([updated.inputTokenLimit, updated.outputTokenLimit, updated.priced], [500_000, 64_000, true]);

  // 公开的聚合渠道继承子渠道的共同模型和端点
  const aggregate = await admin.mutate('admin.catalog.saveChannel', {
    name: 'e2e-aggregate',
    type: 'aggregate',
    enabled: true,
    isPublic: true,
    timeoutMs: 30_000,
    members: [{ channelId: state.channelId }],
  });
  assert.deepEqual(aggregate.unpricedModels, []);
  const listed = (await admin.query('admin.catalog.list')).channels.find((c) => c.id === aggregate.id);
  assert.deepEqual(listed.availableModels, [{ modelId: model.id, multiplier: null }]);
  assert.deepEqual(listed.endpoints, ['/v1/chat/completions', '/v1/messages']);
  assert.deepEqual(listed.members, [{ channelId: state.channelId, priority: 0, weight: 1 }]);
  const key = await user.mutate('keys.create', { name: 'aggregate', channelId: aggregate.id });
  const chat = await gateway('/v1/chat/completions', key.token, {
    model: 'e2e-model',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  });
  assert.equal(chat.status, 200);
  const requestId = chat.headers.get('x-request-id');
  let detail;
  for (let i = 0; i < 50; i++) {
    detail = await admin.query('requestDetail', { requestId });
    if (detail.status === 'settled') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(detail.status, 'settled');
  assert.equal(detail.charged, '0.001900');
  assert.equal(detail.channelId, aggregate.id);
  assert.deepEqual(
    detail.attempts.map((a) => a.channelId),
    [state.channelId],
  );

  // 删除聚合渠道后，绑定的 Key 不再可用
  await admin.mutate('admin.catalog.deleteChannel', { channelId: aggregate.id });
  const gone = await gateway('/v1/chat/completions', key.token, { model: 'e2e-model', messages: [] });
  assert.equal(gone.status, 503);
  assert.equal((await gone.json()).error.code, 'channel_unavailable');
  assert.equal((await admin.query('admin.billing.reconcile', { userId: state.userId })).consistent, true);
});
