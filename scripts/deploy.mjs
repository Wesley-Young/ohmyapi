import { validateProductionConfig } from '../daemon/src/config.ts';

import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`));
    });
  });
}

try {
  if (!['setup', 'deploy'].includes(mode)) throw new Error('Usage: node scripts/deploy.mjs <setup|deploy>');
  loadEnvFile(new URL('../.env', import.meta.url));
  process.env.NODE_ENV = 'production';
  validateProductionConfig();

  // The workspace builds from source, so development dependencies are required.
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await run(pnpm, ['install', '--frozen-lockfile', '--prod=false']);
  await run(pnpm, ['build']);
  await run(process.execPath, ['daemon/dist/cli/migrate.js']);
  if (mode === 'setup') await run(process.execPath, ['daemon/dist/cli/init.js']);

  console.info('Deployment prepared. Start with pnpm start.');
  if (mode === 'setup') console.info('Remove BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD from .env.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment failed');
  process.exitCode = 1;
}
