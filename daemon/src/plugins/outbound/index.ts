import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { Agent, type Dispatcher, ProxyAgent } from 'undici';
import { z } from 'zod';

import { definePlugin } from '../../kernel.js';

export const proxyUrlInput = z
  .string()
  .trim()
  .min(1, '请填写代理地址')
  .max(4096, '代理地址最多 4096 个字符')
  .refine((value) => {
    try {
      const url = new URL(value);
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        Boolean(url.hostname) &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        (!url.password || Boolean(url.username))
      );
    } catch {
      return false;
    }
  }, '代理需为 HTTP(S) 地址，可包含用户名和密码，不含路径、查询参数和片段')
  .nullable()
  .optional();

export type OutboundFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

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
      const options: RequestInit & { dispatcher: Dispatcher } = {
        ...init,
        dispatcher: this.dispatcher(proxyUrl),
      };
      return fetch(url, options);
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
