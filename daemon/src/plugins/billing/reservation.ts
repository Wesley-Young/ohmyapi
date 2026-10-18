import type { Endpoint } from '../database/schema/index.ts';
import type { LockedPrice } from '../pricing/service.ts';

/**
 * 计费准入所需的请求信息。用户、Key、渠道、模型和端点的准入由网关在路由时确认，这里不再重复校验；
 * 准入之后的管理变更只影响后续请求。
 */
export type ReservationInput = {
  requestId: string;
  userId: string;
  modelId: string;
  channelId: string;
  price: LockedPrice;
  /** 本次请求采用的输出上限，随价格快照保存。 */
  outputLimit: number;
  body: Record<string, unknown>;
  endpoint: Endpoint;
  /** 实际执行渠道绑定的订阅账号，与准入一起写入请求记录。 */
  subscriptionAccountId: string | null;
  /** 实际发往上游的推理强度，与准入一起写入请求记录。 */
  reasoningEffort: string | null;
};
