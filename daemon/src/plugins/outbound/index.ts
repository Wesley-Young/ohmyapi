import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { Agent, type Dispatcher, fetch as outboundFetch, ProxyAgent } from 'undici';

import { definePlugin } from '../../kernel.ts';

export type OutboundFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** 出站连接无法建立（已关闭或代理配置无效），请求没有发出。 */
export class OutboundSetupError extends Error {
  override readonly name = 'OutboundSetupError';
  readonly code = 'ERR_OUTBOUND_SETUP';
}

export class OutboundHttp implements Disposable {
  static readonly token = serviceToken<OutboundHttp>('ohmyapi/outbound');
  private readonly direct = new Agent();
  private readonly agents = new Map<string, { agent: ProxyAgent; usedAt: number }>();
  private readonly retiring = new Set<ProxyAgent>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor() {
    this.timer = setInterval(() => {
      for (const [key, entry] of this.agents) {
        if (entry.usedAt < Date.now() - 300_000) this.retire(key, entry.agent);
      }
    }, 60_000);
    this.timer.unref();
  }

  private retire(key: string, agent: ProxyAgent) {
    this.agents.delete(key);
    this.retiring.add(agent);
    // 等待正在传输的响应结束，避免清理连接池时中断流式请求。
    void agent
      .close()
      .catch(() => {})
      .finally(() => this.retiring.delete(agent));
  }

  private dispatcher(proxyUrl?: string | null): Dispatcher {
    if (this.stopped) throw new Error('出站连接已关闭');
    if (!proxyUrl) return this.direct;
    const existing = this.agents.get(proxyUrl);
    if (existing) {
      existing.usedAt = Date.now();
      return existing.agent;
    }
    const url = new URL(proxyUrl);
    const token = url.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
      : undefined;
    url.username = '';
    url.password = '';
    const agent = new ProxyAgent({ uri: url.toString(), token, proxyTunnel: false });
    if (this.agents.size >= 128) {
      const oldest = [...this.agents].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      this.retire(oldest[0], oldest[1].agent);
    }
    this.agents.set(proxyUrl, { agent, usedAt: Date.now() });
    return agent;
  }

  forProxy(proxyUrl?: string | null): OutboundFetch {
    return (url, init) => {
      let dispatcher: Dispatcher;
      try {
        dispatcher = this.dispatcher(proxyUrl);
      } catch (error) {
        return Promise.reject(new OutboundSetupError('Unable to prepare the outbound connection', { cause: error }));
      }
      const options: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher };
      // 使用锁定的 undici 版本，保证 CC 协商的 zstd 解压不依赖 Node 内置 fetch 版本。
      return outboundFetch(url, options as Parameters<typeof outboundFetch>[1]) as unknown as Promise<Response>;
    };
  }

  async dispose() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([
      this.direct.destroy(),
      ...[...this.agents.values()].map(({ agent }) => agent.destroy()),
      ...[...this.retiring].map((agent) => agent.destroy()),
    ]);
    this.agents.clear();
    this.retiring.clear();
  }
}

export const OutboundPlugin = definePlugin({
  name: 'ohmyapi-outbound',
  provides: [OutboundHttp],
  apply(ctx) {
    ctx.provide(OutboundHttp, new OutboundHttp());
  },
});
