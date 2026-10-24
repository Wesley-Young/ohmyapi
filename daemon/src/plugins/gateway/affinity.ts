import { createHash } from 'node:crypto';

/** foreignHistory 是会话历史开头产生于其他上游的条数，见 UpstreamContext。 */
type Binding = { channelId: string; foreignHistory: number; expiresAt: number };
export type AffinitySelection = { key: string; previous?: Binding };

export class ChannelAffinity {
  private readonly bindings = new Map<string, Binding>();
  private readonly capacity = 100_000;
  private readonly ttlMs = 3_600_000;

  lookup(channelId: string, model: string, session: { family: string; value: string }): AffinitySelection {
    const key = createHash('sha256')
      .update(JSON.stringify([channelId, model, session.family, session.value]))
      .digest('hex');
    let previous = this.bindings.get(key);
    if (previous) {
      this.bindings.delete(key);
      if (previous.expiresAt > Date.now()) this.bindings.set(key, previous);
      else previous = undefined;
    }
    return { key, previous };
  }

  remember(selection: AffinitySelection, channelId: string, foreignHistory: number) {
    // 较早开始的慢请求不能覆盖其他请求刚更新的绑定。
    if (this.bindings.get(selection.key) !== selection.previous) return;
    this.bindings.delete(selection.key);
    this.bindings.set(selection.key, { channelId, foreignHistory, expiresAt: Date.now() + this.ttlMs });
    if (this.bindings.size > this.capacity) {
      const oldest = this.bindings.keys().next().value;
      if (oldest !== undefined) this.bindings.delete(oldest);
    }
  }
}
