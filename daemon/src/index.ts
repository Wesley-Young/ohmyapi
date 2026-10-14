import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { errorDetails, formatEvent, globalLogger } from './core/logging.ts';

let ctx: ReturnType<typeof createApp> | undefined;
let stopping = false;

async function shutdown(reason: string) {
  if (!ctx || stopping) return;
  stopping = true;
  ctx.logger.info(formatEvent('服务开始停止', { reason }));
  try {
    await ctx.stop();
    ctx.logger.info('服务已停止');
  } catch (error) {
    ctx.logger.error(formatEvent('服务停止失败', errorDetails(error)));
    process.exitCode = 1;
  }
}

try {
  ctx = createApp(loadConfig());
  await ctx.start();
  ctx.logger.info('服务启动完成');
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  (ctx?.logger ?? globalLogger).error(formatEvent('服务启动失败', errorDetails(error)));
  process.exitCode = 1;
  await shutdown('startup_failed');
}
