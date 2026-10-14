import { eq } from 'drizzle-orm';

import type { GatewayConfig } from '../../config.js';
import { requestErrorMessage } from '../../core/errors.js';
import { type EventLogger, errorDetails, formatEvent, type LogFields } from '../../core/logging.js';
import type { BillingSummary } from '../billing/requests.js';
import type { BillingService } from '../billing/service.js';
import type { Database } from '../database/client.js';
import type { Endpoint } from '../database/schema/index.js';
import { requestAttempts } from '../database/schema/index.js';
import { UsageCollector } from './usage.js';

type Options = {
  id: string;
  receivedAt: Date;
  endpoint: Endpoint;
  config: GatewayConfig;
  billing: BillingService;
  db: Database;
  logger: EventLogger;
  sampleLog: (key: string) => boolean;
};

export class ForwardBillingSession {
  readonly collector: UsageCollector;
  readonly bodyStats = { bytes: 0 };
  userId?: string;
  channelId?: string;
  executionChannelId?: string;
  attemptId?: string;
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
    const code =
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
                : collector.searchIncomplete || !collector.finalUsage
                  ? 'usage_not_final'
                  : undefined);
    const failureMessage = [this.failureDetails.errorMessage, this.failureDetails.causeMessage]
      .filter((value) => typeof value === 'string' && value)
      .join('\n');
    return {
      ...this.timing(),
      usage: collector.usage,
      usageFinal:
        collector.finalUsage &&
        !collector.invalid &&
        !collector.unknownCosts &&
        !collector.observationIncomplete &&
        !collector.searchIncomplete,
      usageEstimate: collector.usageEstimate,
      blockSettlement:
        collector.invalid ||
        collector.unknownCosts ||
        collector.observationIncomplete ||
        (collector.searchIncomplete && !collector.usageEstimate),
      httpStatus,
      upstreamRequestId: collector.upstreamId,
      noExecution: !dispatched || safeRejection,
      errorCode: code,
      errorMessage:
        [requestErrorMessage(code), failureMessage, collector.errorMessage].filter(Boolean).join('\n').slice(0, 4096) ||
        undefined,
    };
  }

  /**
   * 流式请求的 TTFT 为网关收到请求到首个非空生成内容的时间；TPS 只统计首个内容之后的生成阶段。
   * 上游报告了推理 Token 但流中没有完整推理文本时，推理发生在首个内容之前，不计入 TPS 分子。
   */
  private timing(): { ttftMs?: number; outputTps?: number } {
    const { collector, streaming } = this;
    const now = Date.now();
    const start = this.options.receivedAt.getTime();
    const first = streaming ? collector.estimate.firstOutputAt : undefined;
    const ttftMs = first === undefined ? undefined : Math.max(0, first - start);
    const usage = collector.usage;
    if (!usage || !this.dispatched) return { ttftMs };
    let tokens = Number(usage.outputTokens);
    if (streaming && !collector.estimate.reasoningStreamed) {
      const details = usage.rawUsage[
        this.options.endpoint === '/v1/chat/completions' ? 'completion_tokens_details' : 'output_tokens_details'
      ] as Record<string, unknown> | undefined;
      // OpenAI 使用 reasoning_tokens，Anthropic 使用 thinking_tokens。
      const reasoning = details?.reasoning_tokens ?? details?.thinking_tokens;
      if (typeof reasoning === 'number' && reasoning > 0) tokens = Math.max(0, tokens - reasoning);
    }
    const windowMs = streaming ? (first === undefined ? 0 : now - first) : now - start;
    // 内容被缓冲后一次性到达时窗口过短，速度没有意义。
    if (windowMs < 100 || !Number.isFinite(tokens)) return { ttftMs };
    return { ttftMs, outputTps: (tokens / windowMs) * 1000 };
  }

  // 最终用量与阻止结算分别保存，后续异常仍能覆盖已有的最终用量状态。
  async checkpoint() {
    const { id, billing, logger } = this.options;
    if (!this.finalCheckpoint && this.summary().usageFinal) {
      this.finalCheckpoint = true;
      try {
        await billing.checkpoint(id, this.summary());
      } catch (error) {
        logger.error(formatEvent('最终用量保存失败', { requestId: id, ...errorDetails(error) }));
      }
    }
    if (!this.blockedCheckpoint && this.summary().blockSettlement) {
      this.blockedCheckpoint = true;
      try {
        await billing.checkpoint(id, this.summary());
      } catch (error) {
        logger.error(formatEvent('用量校验状态保存失败', { requestId: id, ...errorDetails(error) }));
      }
    }
  }

  async finish(result: BillingSummary) {
    const { id, billing, logger } = this.options;
    if (this.attemptId) {
      try {
        await this.options.db
          .update(requestAttempts)
          .set({
            status: result.errorCode ? (result.noExecution || result.usageFinal ? 'failed' : 'unknown') : 'completed',
            noExecution: result.noExecution,
            finishedAt: new Date(),
            httpStatus: this.upstreamStatus,
            upstreamRequestId: result.upstreamRequestId,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          })
          .where(eq(requestAttempts.id, this.attemptId));
      } catch (error) {
        logger.error(
          formatEvent('上游尝试记录保存失败', { requestId: id, attemptId: this.attemptId, ...errorDetails(error) }),
        );
      }
    }
    try {
      if (this.recorded) await billing.finish(id, result);
    } catch (error) {
      logger.error(formatEvent('计费收尾未完成', { requestId: id, ...errorDetails(error) }));
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
      !['request_too_large', 'body_timeout', 'body_idle_timeout'].includes(code ?? '');
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
        formatEvent('网关请求结束', {
          requestId: id,
          endpoint,
          userId,
          channelId,
          executionChannelId: this.executionChannelId,
          attemptId: this.attemptId,
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
          usageEstimate: result.usageEstimate,
          blockSettlement: result.blockSettlement,
          maxBodyBytes: code === 'request_too_large' ? config.maxBodyBytes : undefined,
          timeoutMs:
            code === 'body_timeout'
              ? config.bodyTimeoutMs
              : code === 'body_idle_timeout'
                ? config.bodyIdleTimeoutMs
                : code === 'upstream_timeout'
                  ? upstreamTimeoutMs
                  : code === 'upstream_idle_timeout'
                    ? config.streamIdleTimeoutMs
                    : undefined,
          ...failureDetails,
        }),
      );
    }
  }
}
