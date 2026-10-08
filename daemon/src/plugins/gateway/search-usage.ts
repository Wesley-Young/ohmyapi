import type { UsageEstimate } from '../billing/estimation.js';
import { maxSearchCalls, type SearchKind, type SearchRequest } from '../billing/search.js';
import type { Endpoint } from '../catalog/service.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

/** 只保留计数和调用标识，搜索内容与查询文本均不持久化。 */
export class SearchUsageCollector {
  webSearchCalls = 0n;
  webSearchPreviewCalls = 0n;
  invalid = false;
  unknownCosts = false;
  incomplete = false;
  private request: SearchRequest = { implicit: false, estimatedCalls: 0 };
  private reported = false;
  private serverSearch = false;
  private serverSearchReported = false;
  private readonly seen = new Set<string>();
  private readonly searchResults = new Set<string>();

  configure(request: SearchRequest) {
    this.request = request;
  }

  private setCount(kind: SearchKind, value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maxSearchCalls) {
      this.invalid = true;
      return;
    }
    if (kind === 'webSearch') this.webSearchCalls = BigInt(value);
    else this.webSearchPreviewCalls = BigInt(value);
  }

  private observeItem(value: unknown, index?: unknown, completed = true) {
    if (this.invalid) return;
    const item = object(value);
    if (!item) return;
    if (
      ['file_search_call', 'image_generation_call', 'computer_call', 'code_interpreter_call'].includes(
        String(item.type),
      )
    ) {
      this.unknownCosts = true;
      return;
    }
    if (!completed || item.type !== 'web_search_call' || this.reported) return;
    if (item.status != null && item.status !== 'completed') return;
    const action = object(item.action);
    // OpenAI 仅对 search 收取调用费，open_page 和 find 仍计入模型 Token。
    if (action?.type === 'open_page' || action?.type === 'find') return;
    if (action?.type != null && action.type !== 'search') {
      this.invalid = true;
      return;
    }
    const kind = this.request.kind;
    if (!kind) {
      this.unknownCosts = true;
      return;
    }
    const aliases: string[] = [];
    if (typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256) aliases.push(`id:${item.id}`);
    if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index <= maxSearchCalls)
      aliases.push(`index:${index}`);
    const newAliases = aliases.filter((alias) => !this.seen.has(alias));
    if (!aliases.length || this.seen.size + newAliases.length > maxSearchCalls * 2) {
      this.invalid = true;
      return;
    }
    if (aliases.some((alias) => this.seen.has(alias))) {
      for (const alias of aliases) this.seen.add(alias);
      return;
    }
    for (const alias of aliases) this.seen.add(alias);
    const previous = kind === 'webSearch' ? this.webSearchCalls : this.webSearchPreviewCalls;
    this.setCount(kind, Number(previous) + 1);
  }

  observe(endpoint: Endpoint, data: Data, envelope: Data, usage: Data | undefined, terminal: boolean) {
    if (endpoint === '/v1/responses') {
      if (data.type === 'response.output_item.added') this.observeItem(data.item, data.output_index, false);
      if (data.type === 'response.output_item.done') this.observeItem(data.item, data.output_index);
      if (terminal && Array.isArray(envelope.output))
        envelope.output.forEach((item, index) => {
          this.observeItem(item, index);
        });
    }
    const blocks = Array.isArray(envelope.content) ? envelope.content : [data.content_block];
    for (const value of blocks) {
      const block = object(value);
      if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        const id = block.tool_use_id;
        if (
          typeof id !== 'string' ||
          !id ||
          id.length > 256 ||
          (!this.searchResults.has(id) && this.searchResults.size >= maxSearchCalls)
        ) {
          this.invalid = true;
        } else if (!block.content.some((item) => object(item)?.type === 'web_search_tool_result_error')) {
          this.searchResults.add(id);
        }
      }
      if (block?.type !== 'server_tool_use') continue;
      if (block.name === 'web_search') {
        this.serverSearch = true;
        this.serverSearchReported = false;
      } else this.unknownCosts = true;
    }
    const server = object(usage?.server_tool_use);
    if (server) {
      for (const [key, value] of Object.entries(server)) {
        if (key === 'web_search_requests') continue;
        if (value !== 0 && value != null) this.unknownCosts = true;
      }
    }
    const vendor = object(object(envelope.tool_usage)?.web_search);
    const reportedCount =
      server && Object.hasOwn(server, 'web_search_requests') ? server.web_search_requests : vendor?.num_requests;
    if (reportedCount !== undefined) {
      this.reported = true;
      if (server && Object.hasOwn(server, 'web_search_requests')) this.serverSearchReported = true;
      this.setCount(this.request.kind ?? 'webSearch', reportedCount);
    } else if (usage && this.request.implicit && !this.reported) {
      this.setCount(this.request.kind as SearchKind, 1);
    }
    if (endpoint === '/v1/messages' && terminal && this.serverSearch && !this.serverSearchReported)
      this.incomplete = true;
  }

  estimate(endpoint: Endpoint): UsageEstimate['searchSource'] {
    if (this.reported) return 'upstream';
    if (this.request.implicit) {
      this.setCount(this.request.kind as SearchKind, 1);
      return 'request';
    }
    if (endpoint === '/v1/messages') this.setCount('webSearch', this.searchResults.size);
    return this.request.kind || this.serverSearch || this.searchResults.size ? 'observed' : 'none';
  }
}
