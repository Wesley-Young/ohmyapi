import { serviceToken } from '@fraqjs/kernel';

import { ConcurrencyLimiter } from '../../core/concurrency.ts';

/**
 * API 渠道进行中的请求数，按渠道 ID 计数。网关在选择执行渠道时占用名额，目录展示当前计数。
 * 订阅渠道按账号计数，见订阅模块。
 */
export class ChannelConcurrency extends ConcurrencyLimiter {
  static readonly token = serviceToken<ChannelConcurrency>('ohmyapi/channel-concurrency');
}
