import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { errorDetails, formatEvent, globalLogger } from './core/logging.ts';
import { GatewayService } from './plugins/gateway/service.ts';

let app: ReturnType<typeof createApp> | undefined;
let stopping = false;
let forcing = false;

/** 停止接受新请求，等待进行中的请求自然结束后再停止服务。 */
async function shutdown(reason: string) {
  if (!app || stopping) return;
  stopping = true;
  const { ctx, server } = app;
  try {
    if (reason !== 'startup_failed') {
      const gateway = ctx.resolve(GatewayService);
      ctx.logger.info(
        formatEvent('服务开始停止，等待进行中的请求结束', {
          reason,
          activeRequests: server.activeRequests,
          activeGatewayRequests: gateway.activeRequests,
        }),
      );
      await Promise.all([server.close(), gateway.drain()]);
    }
    await ctx.stop();
    ctx.logger.info('服务已停止');
  } catch (error) {
    ctx.logger.error(formatEvent('服务停止失败', errorDetails(error)));
    process.exitCode = 1;
  }
}

/** 再次收到信号时放弃等待：中止进行中的网关请求（仍完成计费收尾）并断开所有连接。 */
async function forceShutdown(reason: string) {
  if (!app || forcing) return;
  forcing = true;
  const { ctx, server } = app;
  ctx.logger.warn(formatEvent('强制停止，中断进行中的请求', { reason }));
  try {
    await ctx.resolve(GatewayService).dispose();
  } finally {
    server.terminate();
  }
}

function onSignal(signal: NodeJS.Signals) {
  if (stopping) void forceShutdown(signal);
  else void shutdown(signal);
}

try {
  app = createApp(loadConfig());
  await app.ctx.start();
  app.ctx.logger.info('服务启动完成');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
} catch (error) {
  (app?.ctx.logger ?? globalLogger).error(formatEvent('服务启动失败', errorDetails(error)));
  process.exitCode = 1;
  await shutdown('startup_failed');
}
