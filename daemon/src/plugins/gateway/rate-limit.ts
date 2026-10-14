import { GatewayError } from '../../core/errors.js';

/** 按用户限制并发请求数和每分钟请求数；超限返回 429。 */
export class UserRateLimiter {
  private readonly limits = new Map<string, { active: number; count: number; reset: number }>();
  private readonly limit: { maxConcurrent: number; requestsPerMinute: number };
  constructor(limit: { maxConcurrent: number; requestsPerMinute: number }) {
    this.limit = limit;
  }

  /** 占用一个并发名额，返回释放函数。 */
  acquire(userId: string) {
    const now = Date.now();
    for (const [key, entry] of this.limits) if (!entry.active && entry.reset <= now) this.limits.delete(key);
    const entry = this.limits.get(userId) ?? { active: 0, count: 0, reset: now + 60_000 };
    if (entry.reset <= now) {
      entry.count = 0;
      entry.reset = now + 60_000;
    }
    if (
      entry.active >= this.limit.maxConcurrent ||
      entry.count >= this.limit.requestsPerMinute ||
      this.limits.size >= 10_000
    )
      throw new GatewayError(429, 'rate_limit_exceeded', 'User request limit exceeded');
    entry.active++;
    entry.count++;
    this.limits.set(userId, entry);
    return () => {
      entry.active--;
    };
  }
}
