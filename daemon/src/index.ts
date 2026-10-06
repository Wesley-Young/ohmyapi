import { createApp } from './app.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const ctx = createApp({ host, port });
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await ctx.stop();
  } catch (error) {
    console.error('Failed to stop ohmyapi', error);
    process.exitCode = 1;
  }
}

try {
  await ctx.start();
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  console.error('Failed to start ohmyapi', error);
  process.exitCode = 1;
  await shutdown();
}
