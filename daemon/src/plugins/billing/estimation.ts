import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

import type { Endpoint } from '../catalog/service.js';
import { imageInputTypes, requestContentBlocks } from './content.js';
import { estimateImageTokens } from './image-estimation.js';

// A local approximation for arbitrary upstream models, not a billing tokenizer.
const tokenizer = new Tiktoken(o200kBase);
export type UsageEstimate = {
  method: 'o200k_base_v1';
  reason: 'client_disconnected';
  inputSource: 'upstream' | 'request_estimate';
  outputSource: 'upstream' | 'observed_estimate' | 'upstream_with_observed_tail';
  reportedOutputTokens: string | null;
  observedTailTokens: string;
  inputImageCount: number;
  inputImageTokens: number;
  imageMethod: 'model_default_1024_v1';
  searchSource: 'upstream' | 'observed' | 'request' | 'none';
};

/** 按固定字符块计数，避免 SSE 分片边界影响估算；内存中只保留最后一个块。 */
export class OutputTokenEstimate {
  private tokens = 0n;
  private tail = '';

  append(value: unknown) {
    if (typeof value !== 'string' || !value) return;
    this.tail += value;
    let offset = 0;
    while (this.tail.length - offset > 4096) {
      const end = offset + 4096;
      // 保留 UTF-16 代理对，避免把同一个字符拆成两次计数。
      const size = /[\uD800-\uDBFF]/.test(this.tail[end - 1]) ? 4095 : 4096;
      this.tokens += BigInt(tokenizer.encode(this.tail.slice(offset, offset + size), [], []).length);
      offset += size;
    }
    this.tail = this.tail.slice(offset);
  }

  count() {
    return this.tokens + BigInt(tokenizer.encode(this.tail, [], []).length);
  }

  reset() {
    this.tokens = 0n;
    this.tail = '';
  }
}
export type ReservationEstimate = {
  inputTokens: number;
  outputTokens: number;
  inputContentTokens: number;
  inputImageCount: number;
  inputImageTokens: number;
  settlementImageTokens: number;
  outputHistorySamples: number;
  outputBaselineTokens: string;
  outputSource: 'recent_usage' | 'fallback';
};
const margin = (tokens: bigint) => (tokens * 5n + 3n) / 4n + 256n;
const capped = (tokens: bigint, limit: number) => Number(tokens > BigInt(limit) ? BigInt(limit) : tokens);
// 统一用于预占的项目估算值；最终图像用量采用上游输入 Token 总量。
const imageReservationTokens = 4096;

export function estimateReservation(
  body: Record<string, unknown>,
  endpoint: Endpoint,
  outputLimit: number,
  recentOutputTokens: bigint[],
): ReservationEstimate {
  // Include message wrappers, tool schemas and instructions. Treat special-token-looking text literally.
  const images = new WeakSet<object>();
  let inputImageCount = 0;
  let settlementImageTokens = 0;
  for (const block of requestContentBlocks(body, endpoint)) {
    if (block.type !== imageInputTypes[endpoint]) continue;
    images.add(block);
    inputImageCount++;
    const image = block.image_url;
    const detail = image && typeof image === 'object' ? (image as Record<string, unknown>).detail : block.detail;
    settlementImageTokens += estimateImageTokens(String(body.model), detail);
  }
  // 预占跳过图像 URL、文件引用和 Base64 载荷，转发请求保持原样。
  const text = JSON.stringify(body, (_key, value: unknown) =>
    value && typeof value === 'object' && images.has(value) ? { type: imageInputTypes[endpoint] } : value,
  );
  const inputImageTokens = inputImageCount * imageReservationTokens;
  let inputContentTokens = 0;
  // Bound each BPE operation even for long strings without whitespace.
  for (let offset = 0; offset < text.length; offset += 4096)
    inputContentTokens += tokenizer.encode(text.slice(offset, offset + 4096), [], []).length;
  const samples = recentOutputTokens.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const useHistory = samples.length >= 5;
  const baseline = useHistory ? samples[Math.ceil(samples.length * 0.95) - 1] : 4096n;
  const paddedOutput = useHistory ? margin(baseline) : baseline;
  const outputTokens = paddedOutput < 512n ? 512n : paddedOutput;
  return {
    // 模型上下文容量独立于计费预估，预占覆盖完整输入和估算余量。
    inputTokens: Number(margin(BigInt(inputContentTokens) + BigInt(inputImageTokens))),
    outputTokens: capped(outputTokens, outputLimit),
    inputContentTokens,
    inputImageCount,
    inputImageTokens,
    settlementImageTokens,
    outputHistorySamples: samples.length,
    outputBaselineTokens: baseline.toString(),
    outputSource: useHistory ? 'recent_usage' : 'fallback',
  };
}
