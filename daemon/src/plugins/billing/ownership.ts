import { Client } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import { GatewayError } from '../../core/errors.js';
import { type EventLogger, errorDetails, formatEvent } from '../../core/logging.js';

import { randomUUID } from 'node:crypto';

/**
 * 计费所有权：通过专用连接持有 PostgreSQL advisory lock，保证同一数据库只有一个实例处理计费。
 * 连接中断或健康检查失败后不再就绪，由上层停止转发。
 */
export class BillingOwnership {
  readonly ownerId = randomUUID();
  private lease?: Client;
  private healthy = false;
  private closing = false;
  private lostHandler?: () => void;
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
    this.lostHandler = handler;
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
    const lost = (error?: unknown) => {
      if (this.closing || !this.healthy) return;
      this.healthy = false;
      this.logger.error(
        formatEvent('计费所有权连接中断，停止转发', {
          ownerId: this.ownerId,
          ...this.stats(),
          ...(error === undefined ? {} : errorDetails(error)),
        }),
      );
      this.lostHandler?.();
    };
    lease.on('error', lost);
    lease.on('end', lost);
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

  /** 定期确认连接仍然可用；失败后转为不可用并通知上层。 */
  async check() {
    try {
      await this.lease?.query('select 1');
      return true;
    } catch (error) {
      this.healthy = false;
      this.lostHandler?.();
      this.logger.error(
        formatEvent('计费所有权健康检查失败', { ownerId: this.ownerId, ...this.stats(), ...errorDetails(error) }),
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
