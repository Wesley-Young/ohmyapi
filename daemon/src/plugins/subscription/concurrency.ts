import { GatewayError } from '../gateway/errors.js';

// 网关由现有计费主租约保证单实例运行；同一账号跨渠道共享计数。
export class SubscriptionConcurrency {
  private readonly counts = new Map<string, number>();
  active(id: string) {
    return this.counts.get(id) ?? 0;
  }
  acquire(id: string, maximum: number) {
    const active = this.active(id);
    if (active >= maximum)
      throw new GatewayError(
        429,
        'subscription_concurrency_exceeded',
        'The subscription account concurrency limit was reached',
      );
    this.counts.set(id, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.active(id) - 1;
      if (remaining > 0) this.counts.set(id, remaining);
      else this.counts.delete(id);
    };
  }
}
