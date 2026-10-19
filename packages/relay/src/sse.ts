import type { ResponseObserver } from './types.ts';

/**
 * 有界的增量 SSE 解析：按事件把 data 交给观察者，`[DONE]` 表示完成，其余按 JSON 解析。
 * 单个事件超过 maxEventBytes 时跳过该事件并报告 truncated。只读取字节，不改动转发给客户端的内容。
 */
export class SseObserver {
  private decoder = new TextDecoder();
  private line = '';
  private lineLength = 0;
  private data: string[] = [];
  private size = 0;
  private skip = false;
  private previousCR = false;
  private readonly observer: ResponseObserver;
  private readonly maxEventBytes: number;
  private readonly onEvent?: (value: unknown) => void;
  constructor(observer: ResponseObserver, maxEventBytes: number, onEvent?: (value: unknown) => void) {
    this.onEvent = onEvent;
    this.observer = observer;
    this.maxEventBytes = maxEventBytes;
  }

  push(chunk: Uint8Array) {
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  finish(interrupted = false) {
    // 断连时末尾可能只有半个事件，只用此前已完整解析的事件。
    if (interrupted) {
      this.line = '';
      this.data = [];
      return;
    }
    this.consume(this.decoder.decode());
    if (this.line) this.endLine();
    this.event();
  }

  private consume(text: string) {
    let offset = 0;
    const breaks = /[\r\n]/g;
    while (offset < text.length) {
      if (this.previousCR) {
        this.previousCR = false;
        if (text[offset] === '\n') {
          offset++;
          continue;
        }
      }
      breaks.lastIndex = offset;
      const end = breaks.exec(text)?.index ?? text.length;
      const fragment = text.slice(offset, end);
      this.lineLength += fragment.length;
      if (!this.skip) {
        this.size += Buffer.byteLength(fragment, 'utf8');
        if (this.size > this.maxEventBytes) {
          this.skip = true;
          this.line = '';
          this.data = [];
          this.observer.truncated();
        } else this.line += fragment;
      }
      if (end === text.length) break;
      this.previousCR = text[end] === '\r';
      this.endLine();
      offset = end + 1;
    }
  }

  private endLine() {
    if (!this.lineLength) this.event();
    else if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
    this.line = '';
    this.lineLength = 0;
  }

  private event() {
    if (!this.skip && this.data.length) {
      const raw = this.data.join('\n');
      if (raw === '[DONE]') this.observer.done();
      else {
        try {
          const value: unknown = JSON.parse(raw);
          this.observer.event(value);
          this.onEvent?.(value);
        } catch (error) {
          this.observer.malformed(error);
        }
      }
    }
    this.data = [];
    this.size = 0;
    this.skip = false;
  }
}
