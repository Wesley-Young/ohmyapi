import { Client } from 'pg';

import type { DatabaseConfig } from '../../config.ts';
import { GatewayError } from '../../core/errors.ts';
import { type EventLogger, errorDetails, formatEvent } from '../../core/logging.ts';

import { randomUUID } from 'node:crypto';

/** 健康检查连续失败达到此次数才判定失去所有权；单次超时可能来自数据库或事件循环的短暂延迟。 */
const maxCheckFailures = 3;

/**
 * 计费所有权：通过专用连接持有 PostgreSQL advisory lock，保证同一数据库只有一个实例处理计费。
 * 连接中断说明会话和锁已经释放，立即判定失去所有权；健康检查连续失败同样判定失去。
 * 失去后不再就绪，由上层停止转发并退出进程。
 */
export class BillingOwnership {
  readonly ownerId = randomUUID();
  private lease?: Client;
  private healthy = false;
  private closing = false;
  private checkFailures = 0;
  private readonly lostHandlers: (() => void)[] = [];
  private readonly logger: EventLogger;
  private readonly stats: () => { activeRequests: number; pendingRetries: number };

  constructor(deps: { logger: EventLogger; stats: () => { activeRequests: number; pendingRetries: number } }) {
    this.logger = deps.logger;
    this.stats = deps.stats;
  }

  get isHealthy() {
    return this.healthy;
  }

  assertReady() {
    if (!this.healthy) throw new GatewayError(503, 'billing_unavailable', 'Billing is unavailable');
  }

  onLost(handler: () => void) {
    this.lostHandlers.push(handler);
  }

  private lose(message: string, error?: unknown) {
    if (this.closing || !this.healthy) return;
    this.healthy = false;
    this.logger.error(
      formatEvent(message, {
        ownerId: this.ownerId,
        ...this.stats(),
        ...(error === undefined ? {} : errorDetails(error)),
      }),
    );
    for (const handler of this.lostHandlers) handler();
  }

  /** 建立专用连接并获取锁；失败时调用方需执行 abandon()。 */
  async acquire(config: DatabaseConfig) {
    const lease = new Client({
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      query_timeout: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
    this.lease = lease;
    const lost = (error?: unknown) => this.lose('计费所有权连接中断，停止转发', error);
    lease.on('error', lost);
    lease.on('end', () => lost());
    await lease.connect();
    const { rows } = await lease.query<{ locked: boolean }>('select pg_try_advisory_lock(1330138459) as locked');
    if (!rows[0].locked) throw new Error('Another ohmyapi instance owns billing for this database');
    this.healthy = true;
    this.logger.info(formatEvent('计费所有权已获取', { ownerId: this.ownerId }));
  }

  /** 启动失败时放弃所有权并关闭连接。 */
  async abandon() {
    this.healthy = false;
    const lease = this.lease;
    this.lease = undefined;
    await lease?.end().catch(() => {});
  }

  /**
   * 定期确认连接仍然可用。失败时返回 false，调用方跳过本轮依赖所有权的工作；
   * 连续失败达到上限后转为不可用并通知上层。
   */
  async check() {
    if (!this.healthy) return false;
    try {
      await this.lease?.query('select 1');
      if (this.checkFailures)
        this.logger.info(
          formatEvent('计费所有权健康检查已恢复', { ownerId: this.ownerId, failures: this.checkFailures }),
        );
      this.checkFailures = 0;
      return this.healthy;
    } catch (error) {
      if (!this.healthy) return false;
      this.checkFailures++;
      if (this.checkFailures >= maxCheckFailures) {
        this.lose('计费所有权健康检查连续失败，停止转发', error);
        return false;
      }
      this.logger.warn(
        formatEvent('计费所有权健康检查失败，稍后重试', {
          ownerId: this.ownerId,
          attempt: this.checkFailures,
          maxAttempts: maxCheckFailures,
          ...this.stats(),
          ...errorDetails(error),
        }),
      );
      return false;
    }
  }

  async dispose() {
    if (this.closing) return;
    this.closing = true;
    this.healthy = false;
    const lease = this.lease;
    this.lease = undefined;
    await lease?.end();
  }
}
