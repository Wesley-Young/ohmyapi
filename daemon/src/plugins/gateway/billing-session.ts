import type { readGatewayConfig } from '../../config.js';
import { type EventLogger, errorDetails, type LogFields } from '../../logging.js';
import type { BillingService, BillingSummary } from '../billing/service.js';
import type { Endpoint } from '../catalog/service.js';
import { UsageCollector } from './usage.js';

type Options = {
  id: string;
  receivedAt: Date;
  endpoint: Endpoint;
  config: ReturnType<typeof readGatewayConfig>;
  billing: BillingService;
  logger: EventLogger;
  sampleLog: (key: string) => boolean;
};

export class ForwardBillingSession {
  readonly collector: UsageCollector;
  readonly bodyStats = { bytes: 0 };
  userId?: string;
  channelId?: string;
  modelName?: string;
  streaming?: boolean;
  httpStatus?: number;
  upstreamStatus?: number;
  upstreamTimeoutMs?: number;
  failureDetails: LogFields = {};
  dispatched = false;
  recorded = false;
  safeRejection = false;
  private finalCheckpoint = false;
  private blockedCheckpoint = false;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    this.collector = new UsageCollector(options.endpoint);
  }

  summary(errorCode?: string): BillingSummary {
    const { collector, httpStatus, dispatched, safeRejection } = this;
    return {
      usage: collector.usage,
      usageFinal:
        collector.finalUsage && !collector.invalid && !collector.unknownCosts && !collector.observationIncomplete,
      blockSettlement: collector.invalid || collector.unknownCosts || collector.observationIncomplete,
      httpStatus,
      upstreamRequestId: collector.upstreamId,
      noExecution: !dispatched || safeRejection,
      errorCode:
        errorCode ??
        (collector.observationIncomplete
          ? 'usage_observation_limit'
          : collector.unknownCosts
            ? 'unsupported_usage'
            : collector.failed
              ? 'upstream_error'
              : collector.invalid
                ? 'invalid_usage'
                : !collector.usage
                  ? 'usage_missing'
                  : !collector.finalUsage
                    ? 'usage_not_final'
                    : undefined),
    };
  }

  // 最终用量与阻止结算分别保存，后续异常仍能覆盖已有的最终用量状态。
  async checkpoint() {
    const { id, billing, logger } = this.options;
    if (!this.finalCheckpoint && this.summary().usageFinal) {
      this.finalCheckpoint = true;
      try {
        await billing.checkpoint(id, this.summary());
      } catch (error) {
        logger.error(`最终用量保存失败 ${JSON.stringify({ requestId: id, ...errorDetails(error) })}`);
      }
    }
    if (!this.blockedCheckpoint && this.summary().blockSettlement) {
      this.blockedCheckpoint = true;
      try {
        await billing.checkpoint(id, this.summary());
      } catch (error) {
        logger.error(`用量校验状态保存失败 ${JSON.stringify({ requestId: id, ...errorDetails(error) })}`);
      }
    }
  }

  async finish(result: BillingSummary) {
    const { id, billing, logger } = this.options;
    try {
      if (this.recorded) await billing.finish(id, result);
    } catch (error) {
      logger.error(`计费收尾未完成 ${JSON.stringify({ requestId: id, ...errorDetails(error) })}`);
    }
  }

  log(result: BillingSummary) {
    const { id, receivedAt, endpoint, config, logger, sampleLog } = this.options;
    const {
      userId,
      channelId,
      modelName,
      streaming,
      dispatched,
      recorded,
      httpStatus,
      upstreamStatus,
      bodyStats,
      upstreamTimeoutMs,
      failureDetails,
    } = this;
    const code = result.errorCode;
    const routineRejection =
      !dispatched &&
      httpStatus !== undefined &&
      httpStatus < 500 &&
      !['request_too_large', 'body_timeout'].includes(code ?? '');
    if (!routineRejection || sampleLog(code ?? 'rejected')) {
      const level =
        code === 'client_disconnected' || code === 'request_cancelled'
          ? 'debug'
          : code === 'server_shutdown'
            ? 'info'
            : (httpStatus ?? 0) >= 500
              ? 'error'
              : code || (httpStatus ?? 0) >= 400
                ? 'warn'
                : 'info';
      logger[level](
        `网关请求结束 ${JSON.stringify({
          requestId: id,
          endpoint,
          userId,
          channelId,
          model: modelName,
          streaming,
          dispatched,
          recorded,
          httpStatus,
          upstreamStatus,
          upstreamRequestId: result.upstreamRequestId,
          durationMs: Date.now() - receivedAt.getTime(),
          bodyBytes: bodyStats.bytes,
          errorCode: code,
          usageFinal: result.usageFinal,
          blockSettlement: result.blockSettlement,
          maxBodyBytes: code === 'request_too_large' ? config.maxBodyBytes : undefined,
          timeoutMs:
            code === 'body_timeout'
              ? config.bodyTimeoutMs
              : code === 'upstream_timeout'
                ? upstreamTimeoutMs
                : code === 'upstream_idle_timeout'
                  ? config.streamIdleTimeoutMs
                  : undefined,
          ...failureDetails,
        })}`,
      );
    }
  }
}
