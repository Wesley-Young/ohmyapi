import { randomUUID } from 'node:crypto';

export class RequestLifecycle {
  readonly id = randomUUID();
  readonly receivedAt = new Date();
  readonly abort = new AbortController();
  readonly done: Promise<void>;
  releaseCapacity?: () => void;
  private completeRequest: () => void = () => {};
  private timer?: ReturnType<typeof setTimeout>;
  private finalization?: Promise<void>;
  private stopResponse?: () => Promise<void>;
  private readonly req: Request;
  private readonly onComplete: () => void;
  private readonly disconnect = () => this.abort.abort('client_disconnected');
  private readonly onAbort = () => {
    void this.stopResponse?.();
  };

  constructor(req: Request, onComplete: () => void) {
    this.req = req;
    this.onComplete = onComplete;
    this.done = new Promise<void>((resolve) => {
      this.completeRequest = resolve;
    });
    req.signal.addEventListener('abort', this.disconnect, { once: true });
  }

  syncClientAbort() {
    if (this.req.signal.aborted) this.disconnect();
  }

  async withBodyTimeout<T>(timeoutMs: number, read: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => this.abort.abort('body_timeout'), timeoutMs);
    try {
      return await read();
    } finally {
      clearTimeout(timer);
    }
  }

  setTimeout(reason: 'upstream_timeout' | 'upstream_idle_timeout', timeoutMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.abort.abort(reason), timeoutMs);
  }

  watchResponse(stop: () => Promise<void>) {
    this.stopResponse = stop;
    this.abort.signal.addEventListener('abort', this.onAbort, { once: true });
    if (this.abort.signal.aborted) this.onAbort();
  }

  // 返回 Response 后仍保留资源，直到响应读取和计费收尾完成。
  finish(settle: () => Promise<void>, log: () => void): Promise<void> {
    if (this.finalization) return this.finalization;
    if (this.timer) clearTimeout(this.timer);
    this.req.signal.removeEventListener('abort', this.disconnect);
    this.abort.signal.removeEventListener('abort', this.onAbort);
    this.finalization = (async () => {
      try {
        await settle();
      } finally {
        this.releaseCapacity?.();
        this.onComplete();
        this.completeRequest();
        log();
      }
    })();
    return this.finalization;
  }
}
