import { createServer, type RequestListener, type Server, type ServerOptions, type ServerResponse } from 'node:http';

/**
 * 可平滑关闭的 Node HTTP 服务器，通过 `createServer` 交给 `@hono/node-server` 使用。
 * 关闭时停止监听，拒绝已有连接上的新请求，等待进行中的响应结束；连接在响应结束后关闭，不再复用。
 */
export class GracefulHttpServer {
  private server?: Server;
  private readonly active = new Set<ServerResponse>();
  private closing?: Promise<void>;

  readonly createServer = ((options: ServerOptions, listener: RequestListener) => {
    const server = createServer(options, (req, res) => {
      if (this.closing) {
        res.writeHead(503, { 'content-type': 'application/json', connection: 'close', 'retry-after': '5' });
        res.end(JSON.stringify({ error: 'Service unavailable' }));
        return;
      }
      this.active.add(res);
      res.once('close', () => {
        this.active.delete(res);
        // keep-alive 连接在响应结束后才变为空闲，关闭期间及时释放。
        if (this.closing) setImmediate(() => server.closeIdleConnections());
      });
      listener(req, res);
    });
    this.server = server;
    return server;
  }) as typeof createServer;

  get activeRequests() {
    return this.active.size;
  }

  /** 停止接受新请求，并在所有连接结束后完成。 */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const server = this.server;
    if (!server?.listening) return Promise.resolve();
    this.closing = new Promise<void>((resolve) => {
      for (const res of this.active) if (!res.headersSent) res.setHeader('connection', 'close');
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    return this.closing;
  }

  /** 立即断开所有连接，用于放弃等待。 */
  terminate() {
    this.server?.closeAllConnections();
  }
}
