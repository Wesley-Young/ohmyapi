import { createApp } from './app.js';
import { readServerConfig } from './config.js';

const ctx = createApp(readServerConfig());
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await ctx.stop();
  } catch (error) {
    ctx.logger.error('Failed to stop ohmyapi', error);
    process.exitCode = 1;
  }
}

try {
  await ctx.start();
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  ctx.logger.error('Failed to start ohmyapi', error);
  process.exitCode = 1;
  await shutdown();
}
