import { createApp } from './app.js';
import { readServerConfig } from './config.js';
import { GatewayService } from './services/gateway.js';

const ctx = createApp(readServerConfig());
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await ctx.tryResolve(GatewayService)?.dispose();
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
