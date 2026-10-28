import type { GatewayConfig } from '../../config.ts';
import { type EventLogger, formatEvent } from '../../core/logging.ts';

/** openUntil 存在时渠道处于熔断；冷却结束后第一个开始的尝试是试探，probing 期间其他请求仍视为熔断。 */
type State = { failures: number; cooldownMs: number; openUntil?: number; probing: boolean };

/** 一次尝试的结果，只采用第一次上报。 */
export type HealthReport = {
  success(): void;
  failure(errorCode: string, retryAfterMs?: number): void;
  /** 结果与渠道健康无关，例如客户端取消或请求本身的错误。 */
  neutral(): void;
};

/**
 * 渠道熔断，按渠道 ID 记录在当前进程内。连续失败达到阈值后熔断，熔断期间选择执行渠道时排在其他成员之后；
 * 冷却结束后放行一个试探请求，成功即恢复，失败则冷却时长加倍。
 */
export class ChannelHealth {
  private readonly states = new Map<string, State>();
  private readonly config: GatewayConfig;
  private readonly logger: EventLogger;

  constructor(config: GatewayConfig, logger: EventLogger) {
    this.config = config;
    this.logger = logger;
  }

  /** 渠道正常，或冷却已结束且没有进行中的试探。 */
  ready(channelId: string) {
    const state = this.states.get(channelId);
    return !state?.openUntil || (state.openUntil <= Date.now() && !state.probing);
  }

  /** 开始一次尝试；冷却结束后的第一次尝试成为试探。 */
  begin(channelId: string): HealthReport {
    const state = this.states.get(channelId);
    const probe = Boolean(state?.openUntil && state.openUntil <= Date.now() && !state.probing);
    if (state && probe) state.probing = true;
    let reported = false;
    const settle = (apply: () => void) => {
      if (reported) return;
      reported = true;
      const current = this.states.get(channelId);
      if (probe && current) current.probing = false;
      apply();
    };
    return {
      success: () => settle(() => this.recover(channelId)),
      failure: (errorCode, retryAfterMs) => settle(() => this.fail(channelId, errorCode, retryAfterMs)),
      neutral: () => settle(() => {}),
    };
  }

  private recover(channelId: string) {
    const state = this.states.get(channelId);
    if (!state) return;
    this.states.delete(channelId);
    if (state.openUntil) this.logger.info(formatEvent('渠道恢复', { channelId }));
  }

  private fail(channelId: string, errorCode: string, retryAfterMs?: number) {
    const { breakerFailures, breakerCooldownMs, breakerMaxCooldownMs } = this.config;
    const now = Date.now();
    let state = this.states.get(channelId);
    if (!state) {
      state = { failures: 0, cooldownMs: breakerCooldownMs, probing: false };
      this.states.set(channelId, state);
    }
    state.failures++;
    // 冷却结束后的失败说明渠道仍未恢复，冷却加倍；冷却期间结束的较早请求只延长熔断。
    const elapsed = state.openUntil !== undefined && state.openUntil <= now;
    if (elapsed) state.cooldownMs = Math.min(state.cooldownMs * 2, breakerMaxCooldownMs);
    if (state.openUntil === undefined && state.failures < breakerFailures) return;
    const cooldownMs = Math.max(state.cooldownMs, Math.min(retryAfterMs ?? 0, breakerMaxCooldownMs));
    const opened = state.openUntil === undefined;
    state.openUntil = Math.max(state.openUntil ?? 0, now + cooldownMs);
    if (opened || elapsed)
      this.logger.warn(formatEvent('渠道熔断', { channelId, failures: state.failures, cooldownMs, errorCode }));
  }
}
