import { type Data, object } from './tools.ts';

import { createHash, randomUUID } from 'node:crypto';

type Entry = {
  expires: number;
  date: string;
  messageId?: string;
  requestId?: string;
  promptId?: string;
  sequence: number;
  committed: number;
};
export class ClaudeSessions {
  private readonly entries = new Map<string, Entry>();
  begin(account: string, caller: string, channel: string, request: Request, body: Data) {
    const metadata = object(body.metadata);
    const source = [
      request.headers.get('session_id'),
      request.headers.get('x-session-id'),
      metadata?.session_id,
      metadata?.user_id,
    ].find((v) => typeof v === 'string' && v.trim() && v.length <= 4096);
    const digest = createHash('sha256')
      .update(JSON.stringify([account, caller, channel, source ?? randomUUID()]))
      .digest();
    digest[6] = (digest[6] & 15) | 64;
    digest[8] = (digest[8] & 63) | 128;
    const hex = digest.subarray(0, 16).toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const now = Date.now();
    let entry = this.entries.get(id);
    if (!entry || entry.expires <= now)
      entry = { expires: now, date: new Date(now).toLocaleDateString('en-CA'), sequence: 0, committed: 0 };
    entry.expires = now + 3_600_000;
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (this.entries.size > 4096) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
    }
    const sequence = ++entry.sequence;
    const last = (body.messages as Data[]).at(-1);
    const toolResult = Array.isArray(last?.content) && last.content.some((b) => object(b)?.type === 'tool_result');
    const promptId = toolResult && entry.promptId ? entry.promptId : randomUUID();
    entry.promptId = promptId;
    return {
      id,
      date: entry.date,
      previousMessageId: entry.messageId,
      previousRequestId: entry.requestId,
      promptId,
      human: !toolResult,
      commit: (messageId: string, requestId: string | null) => {
        if (sequence < entry.committed || this.entries.get(id) !== entry) return;
        entry.committed = sequence;
        entry.messageId = messageId;
        entry.requestId = requestId && /^req_[A-Za-z0-9_-]{1,36}$/.test(requestId) ? requestId : undefined;
      },
    };
  }
}
export type ClaudeSession = ReturnType<ClaudeSessions['begin']>;
