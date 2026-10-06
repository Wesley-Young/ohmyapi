import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';

import type { AppRouter } from '../src/trpc/router.js';
import { billingScenario } from './billing-scenario.js';
import { gatewayScenario } from './gateway-scenario.js';
import { pricingScenario } from './pricing-scenario.js';

import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No available test port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function agent(url: string, initialCookie = '') {
  let cookie = initialCookie;
  let lastCookie = '';
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${url}/api/trpc`,
        fetch: async (input, options) => {
          const headers = new Headers(options?.headers);
          headers.set('X-Ohmyapi-Request', '1');
          if (cookie) headers.set('Cookie', cookie);
          const response = await fetch(input, { ...options, headers });
          const session = response.headers.getSetCookie().find((header) => header.startsWith('ohmyapi_session='));
          if (session) {
            cookie = session.split(';')[0];
            lastCookie = session;
          }
          return response;
        },
      }),
    ],
  });
  return { client, cookie: () => cookie, setCookie: () => lastCookie };
}

async function rejected(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof TRPCClientError && error.data?.code === code);
}

async function waitReady(url: string, process: ChildProcess, output: () => string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (process.exitCode !== null) throw new Error(`Test application exited: ${output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* Wait for the real HTTP listener. */
    }
    if (Date.now() > deadline) throw new Error(`Test application did not become ready: ${output()}`);
    await setTimeout(100);
  }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

test('billing gateway through real CLI, PostgreSQL and HTTP: permissions, settlement, reconciliation and crash recovery', {
  timeout: 720_000,
}, async () => {
  const container = `ohmyapi-e2e-${randomUUID()}`;
  let started = false;
  let backend: ChildProcess | undefined;
  let frontend: ChildProcess | undefined;
  let output = '';
  try {
    const databasePassword = randomBytes(24).toString('hex');
    await exec(
      'docker',
      [
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '-p',
        '127.0.0.1::5432',
        '-e',
        `POSTGRES_PASSWORD=${databasePassword}`,
        '-e',
        'POSTGRES_DB=ohmyapi',
        '--tmpfs',
        '/var/lib/postgresql/data',
        'postgres:17-alpine',
      ],
      { timeout: 120_000 },
    );
    started = true;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await exec('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'ohmyapi']);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('Test PostgreSQL did not become ready');
        await setTimeout(250);
      }
    }
    const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
    const databasePort = stdout.trim().split(':').at(-1);
    const port = await freePort();
    const webPort = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const adminPassword = 'e2e-initial-admin-password';
    const env = {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:${databasePassword}@127.0.0.1:${databasePort}/ohmyapi`,
      BILLING_CURRENCY: 'USD',
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      HOST: '127.0.0.1',
      PORT: `${port}`,
      SESSION_COOKIE_SECURE: 'false',
      GATEWAY_ENABLED: 'true',
      CHANNEL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      GATEWAY_USER_CONCURRENCY: '2',
      GATEWAY_MAX_BODY_BYTES: '4096',
      APP_ORIGIN: `http://127.0.0.1:${webPort}`,
    };
    // Initialize an empty database through the deployed CLI; repeated runs are idempotent.
    await exec(process.execPath, ['dist/cli/migrate.js'], { cwd, env });
    await exec(process.execPath, ['dist/cli/migrate.js'], { cwd, env });
    await exec(process.execPath, ['dist/cli/init.js'], { cwd, env });
    await exec(process.execPath, ['dist/cli/init.js'], { cwd, env });
    backend = spawn(process.execPath, ['dist/index.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    backend.stdout?.on('data', (data) => {
      output = (output + data.toString()).slice(-8000);
    });
    backend.stderr?.on('data', (data) => {
      output = (output + data.toString()).slice(-8000);
    });
    await waitReady(`${url}/api/ready`, backend, () => output);
    await assert.rejects(
      () =>
        exec(process.execPath, ['dist/index.js'], {
          cwd,
          env: { ...env, PORT: `${port === 65535 ? port - 1 : port + 1}` },
          timeout: 10000,
        }),
      (e: unknown) => e instanceof Error && e.message.includes('Another ohmyapi instance owns billing'),
    );

    const admin = agent(url);
    const anonymous = agent(url);
    assert.equal(await anonymous.client.auth.me.query(), null);
    await rejected(() => anonymous.client.wallet.get.query(), 'UNAUTHORIZED');
    await rejected(
      () => admin.client.auth.login.mutate({ username: 'admin', password: 'incorrect-password' }),
      'UNAUTHORIZED',
    );
    const adminUser = await admin.client.auth.login.mutate({ username: 'admin', password: adminPassword });
    assert.equal(adminUser.role, 'admin');
    assert.ok(!('passwordHash' in adminUser));
    assert.match(admin.setCookie(), /HttpOnly/i);
    assert.match(admin.setCookie(), /SameSite=Strict/i);
    assert.ok(!('mustChangePassword' in adminUser));
    const alice = await admin.client.admin.users.create.mutate({ username: 'alice' });
    const bob = await admin.client.admin.users.create.mutate({ username: 'bob' });
    assert.equal(alice.password.length, 16);
    assert.equal(bob.password.length, 16);
    assert.notEqual(alice.password, bob.password);
    await rejected(() => admin.client.admin.users.create.mutate({ username: 'alice' }), 'CONFLICT');
    const user = agent(url);
    const other = agent(url);
    await user.client.auth.login.mutate({ username: 'alice', password: alice.password });
    await other.client.auth.login.mutate({ username: 'bob', password: bob.password });
    assert.equal((await user.client.wallet.get.query()).balance, '0.000000');
    await rejected(() => user.client.admin.users.list.query(), 'FORBIDDEN');
    await rejected(() => user.client.admin.wallet.get.query({ userId: bob.user.id }), 'FORBIDDEN');
    const credit = {
      userId: alice.user.id,
      amount: '10.000001',
      reason: 'e2e manual credit',
      idempotencyKey: randomUUID(),
    };
    await rejected(() => user.client.admin.wallet.adjust.mutate(credit), 'FORBIDDEN');
    const entries = await Promise.all([
      admin.client.admin.wallet.adjust.mutate(credit),
      admin.client.admin.wallet.adjust.mutate(credit),
    ]);
    assert.equal(entries[0].id, entries[1].id);
    assert.equal((await user.client.wallet.get.query()).balance, '10.000001');
    assert.equal((await user.client.wallet.ledger.query()).items.length, 1);
    assert.equal((await other.client.wallet.get.query()).balance, '0.000000');
    await rejected(() => admin.client.admin.wallet.adjust.mutate({ ...credit, amount: '20' }), 'CONFLICT');
    await rejected(
      () => admin.client.admin.wallet.adjust.mutate({ ...credit, amount: '-11', idempotencyKey: randomUUID() }),
      'BAD_REQUEST',
    );
    await admin.client.admin.wallet.adjust.mutate({ ...credit, amount: '-0.000001', idempotencyKey: randomUUID() });
    assert.equal((await user.client.wallet.get.query()).balance, '10.000000');
    const fixtureModel = await admin.client.admin.catalog.saveModel.mutate({
      name: 'account-fixture',
      enabled: true,
      endpoints: ['/v1/chat/completions'],
    });
    const fixtureChannel = await admin.client.admin.catalog.saveChannel.mutate({
      name: 'account fixture channel',
      baseUrl: 'http://127.0.0.1:1',
      credential: 'test-only-fixture',
      enabled: true,
      timeoutMs: 1000,
      endpoints: ['/v1/chat/completions'],
      availableModels: [{ modelId: fixtureModel.id, multiplier: null }],
    });
    await admin.client.admin.catalog.setGrants.mutate({ userId: alice.user.id, modelIds: [fixtureModel.id] });
    await admin.client.admin.catalog.setGrants.mutate({ userId: bob.user.id, modelIds: [fixtureModel.id] });
    const key = await user.client.keys.create.mutate({ name: 'alice key', channelId: fixtureChannel.id });
    const otherKey = await other.client.keys.create.mutate({ name: 'bob key', channelId: fixtureChannel.id });
    assert.match(key.token, /^oma_[A-Za-z0-9_-]{43}$/);
    const listed = await user.client.keys.list.query();
    assert.equal(listed.items.length, 1);
    assert.ok(!JSON.stringify(listed).includes(key.token));
    assert.ok(!JSON.stringify(listed).includes('keyHash'));
    await rejected(() => user.client.keys.revoke.mutate({ keyId: otherKey.id }), 'NOT_FOUND');
    await rejected(
      () =>
        user.client.keys.create.mutate({ channelId: fixtureChannel.id, name: 'bad model', modelIds: [randomUUID()] }),
      'FORBIDDEN',
    );
    await rejected(
      () =>
        user.client.keys.create.mutate({
          channelId: fixtureChannel.id,
          name: 'expired',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      'BAD_REQUEST',
    );
    await user.client.keys.revoke.mutate({ keyId: key.id });
    assert.ok((await user.client.keys.list.query()).items[0].revokedAt);
    const activeKey = await user.client.keys.create.mutate({ channelId: fixtureChannel.id, name: 'reset later' });
    const sibling = agent(url);
    await sibling.client.auth.login.mutate({ username: 'alice', password: alice.password });
    const previousCookie = user.cookie();
    const newPassword = 'e2e-alice-new-password';
    await user.client.auth.changePassword.mutate({ currentPassword: alice.password, newPassword });
    assert.notEqual(user.cookie(), previousCookie);
    await rejected(() => agent(url, previousCookie).client.wallet.get.query(), 'UNAUTHORIZED');
    await rejected(() => sibling.client.wallet.get.query(), 'UNAUTHORIZED');
    const missingHeader = await fetch(`${url}/api/trpc/auth.logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie() },
      body: '{}',
    });
    assert.equal(missingHeader.status, 403);
    const badOrigin = await fetch(`${url}/api/trpc/auth.logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ohmyapi-Request': '1',
        Origin: 'https://untrusted.example',
        Cookie: admin.cookie(),
      },
      body: '{}',
    });
    assert.equal(badOrigin.status, 403);
    await admin.client.admin.users.setStatus.mutate({ userId: alice.user.id, status: 'disabled' });
    await rejected(() => user.client.wallet.get.query(), 'UNAUTHORIZED');
    await rejected(() => user.client.auth.login.mutate({ username: 'alice', password: newPassword }), 'UNAUTHORIZED');
    await admin.client.admin.users.setStatus.mutate({ userId: alice.user.id, status: 'active' });
    await rejected(() => user.client.wallet.get.query(), 'UNAUTHORIZED');
    await user.client.auth.login.mutate({ username: 'alice', password: newPassword });
    await admin.client.admin.users.revokeSessions.mutate({ userId: alice.user.id });
    await rejected(() => user.client.wallet.get.query(), 'UNAUTHORIZED');
    const resetPassword = 'e2e-alice-reset-password';
    await admin.client.admin.users.resetPassword.mutate({ userId: alice.user.id, password: resetPassword });
    await rejected(() => user.client.auth.login.mutate({ username: 'alice', password: newPassword }), 'UNAUTHORIZED');
    await user.client.auth.login.mutate({ username: 'alice', password: resetPassword });
    assert.ok((await user.client.keys.list.query()).items.find((item) => item.id === activeKey.id)?.revokedAt);
    assert.equal((await user.client.wallet.get.query()).balance, '10.000000');
    const replay = agent(url, user.cookie());
    await user.client.auth.logout.mutate();
    await rejected(() => replay.client.wallet.get.query(), 'UNAUTHORIZED');
    await rejected(
      () => admin.client.admin.users.setStatus.mutate({ userId: adminUser.id, status: 'disabled' }),
      'FORBIDDEN',
    );
    assert.ok(!JSON.stringify(await admin.client.admin.users.list.query()).includes('passwordHash'));

    await user.client.auth.login.mutate({ username: 'alice', password: resetPassword });
    await pricingScenario(admin.client, user.client);
    await gatewayScenario(url, admin.client, user.client, other.client, alice.user.id);
    await billingScenario(url, admin.client, {
      client: () => agent(url).client,
      sql: async (query) => {
        await exec('docker', [
          'exec',
          container,
          'psql',
          '-U',
          'postgres',
          '-d',
          'ohmyapi',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          query,
        ]);
      },
      restart: async (beforeStart) => {
        if (backend && backend.exitCode === null && !backend.signalCode) {
          const exited = new Promise<void>((resolve) => backend?.once('exit', () => resolve()));
          backend.kill('SIGKILL');
          await exited;
        }
        await beforeStart?.();
        backend = spawn(process.execPath, ['dist/index.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        backend.stdout?.on('data', (data) => {
          output = (output + data.toString()).slice(-8000);
        });
        backend.stderr?.on('data', (data) => {
          output = (output + data.toString()).slice(-8000);
        });
        await waitReady(`${url}/api/ready`, backend, () => output);
      },
    });

    // Optional interactive review uses this same isolated application and data.
    if (process.env.E2E_REVIEW_FILE) {
      const reviewFile = process.env.E2E_REVIEW_FILE;
      frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', `${webPort}`], {
        cwd: fileURLToPath(new URL('../../web/', import.meta.url)),
        env: { ...env, VITE_API_PROXY_TARGET: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      frontend.stdout?.on('data', (data) => {
        output = (output + data.toString()).slice(-8000);
      });
      frontend.stderr?.on('data', (data) => {
        output = (output + data.toString()).slice(-8000);
      });
      await waitReady(`http://127.0.0.1:${webPort}`, frontend, () => output);
      await writeFile(
        reviewFile,
        JSON.stringify({
          url: `http://127.0.0.1:${webPort}`,
          username: 'admin',
          password: adminPassword,
          alicePassword: resetPassword,
        }),
        { mode: 0o600 },
      );
      console.info('HTTP e2e passed; isolated browser review is ready');
      const reviewDeadline = Date.now() + 600_000;
      for (;;) {
        try {
          await access(`${reviewFile}.done`);
          break;
        } catch {
          if (Date.now() > reviewDeadline) throw new Error('Browser review timed out');
          await setTimeout(250);
        }
      }
    }
  } finally {
    await stop(frontend);
    await stop(backend);
    if (started) await exec('docker', ['rm', '-f', container]);
  }
});
