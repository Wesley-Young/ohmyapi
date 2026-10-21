/** 按键计数的并发名额，计数只在当前进程内有效。 */
export class ConcurrencyLimiter {
  private readonly counts = new Map<string, number>();

  active(key: string) {
    return this.counts.get(key) ?? 0;
  }

  /** 未达上限时占用一个名额，返回释放函数（重复调用只释放一次）；已达上限时返回 undefined。 */
  tryAcquire(key: string, maximum: number): (() => void) | undefined {
    const active = this.active(key);
    if (active >= maximum) return undefined;
    this.counts.set(key, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.active(key) - 1;
      if (remaining > 0) this.counts.set(key, remaining);
      else this.counts.delete(key);
    };
  }
}
