import { GatewayError } from '@ohmyapi/protocols';

import { ConcurrencyLimiter } from '../../core/concurrency.ts';

// 网关由现有计费主租约保证单实例运行；同一账号跨渠道共享计数。
export class SubscriptionConcurrency extends ConcurrencyLimiter {
  acquire(id: string, maximum: number) {
    const release = this.tryAcquire(id, maximum);
    if (!release)
      throw new GatewayError(
        429,
        'subscription_concurrency_exceeded',
        'The subscription account concurrency limit was reached',
      );
    return release;
  }
}
