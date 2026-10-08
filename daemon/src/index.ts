import { createApp } from './app.js';
import { readServerConfig } from './config.js';
import { errorDetails } from './logging.js';

const ctx = createApp(readServerConfig());
let stopping = false;

async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  ctx.logger.info(`服务开始停止 ${JSON.stringify({ reason })}`);
  try {
    await ctx.stop();
    ctx.logger.info('服务已停止');
  } catch (error) {
    ctx.logger.error(`服务停止失败 ${JSON.stringify(errorDetails(error))}`);
    process.exitCode = 1;
  }
}

try {
  await ctx.start();
  ctx.logger.info('服务启动完成');
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  ctx.logger.error(`服务启动失败 ${JSON.stringify(errorDetails(error))}`);
  process.exitCode = 1;
  await shutdown('startup_failed');
}
