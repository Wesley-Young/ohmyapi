import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

import { protocolFor } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { requestContentBlocks } from './content.ts';
import { estimateImageTokens } from './image-estimation.ts';

// A local approximation for arbitrary upstream models, not a billing tokenizer.
const tokenizer = new Tiktoken(o200kBase);

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
/** 已结算请求的最终用量，用于估算输出长度和缓存命中比例。 */
export type UsageSample = {
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  contextTokens: bigint;
};

/**
 * 预占按本次请求的预期用量估算，不加余量；实际费用可以超过预占。
 * 输入（contextTokens）按请求内容计数，并按历史缓存比例拆分为未缓存输入、缓存读取和缓存写入。
 */
export type ReservationEstimate = {
  contextTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  inputContentTokens: number;
  inputImageCount: number;
  settlementImageTokens: number;
  /** 采用的历史范围：同一用户、同一模型的所有用户，或没有足够的历史。 */
  historySource: 'user' | 'model' | 'none';
  historySamples: number;
};

/** 历史样本少于此数时不采用。 */
export const minimumHistorySamples = 5;
/** 没有历史时的输出估算。 */
const fallbackOutputTokens = 1024n;

const median = (values: bigint[]) => values.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))[values.length >> 1];
const ratio = (part: bigint, total: bigint) => (total > 0n ? Number(part) / Number(total) : 0);

export function estimateReservation(
  body: Record<string, unknown>,
  endpoint: Endpoint,
  outputLimit: number,
  /** 依次为同一用户和同一模型所有用户的近期用量，采用第一个样本足够的范围。 */
  history: { user: UsageSample[]; model: UsageSample[] },
  /** 请求路径中的模型名，请求体没有 model 字段时用于估算图像 Token。 */
  model: string,
): ReservationEstimate {
  // Include message wrappers, tool schemas and instructions. Treat special-token-looking text literally.
  const images = new WeakSet<object>();
  let inputImageCount = 0;
  let settlementImageTokens = 0;
  const { request } = protocolFor(endpoint);
  const imageType = request.imageType;
  const modelName = typeof body.model === 'string' ? body.model : model;
  for (const block of requestContentBlocks(body, endpoint)) {
    if ((request.blockType ? request.blockType(block) : block.type) !== imageType) continue;
    images.add(block);
    inputImageCount++;
    const image = block.image_url;
    const detail = request.imageDetail
      ? request.imageDetail(block, body)
      : image && typeof image === 'object'
        ? (image as Record<string, unknown>).detail
        : block.detail;
    settlementImageTokens += estimateImageTokens(modelName, detail);
  }
  // 预占跳过图像 URL、文件引用和 Base64 载荷，转发请求保持原样。
  const text = JSON.stringify(body, (_key, value: unknown) =>
    value && typeof value === 'object' && images.has(value) ? { type: imageType } : value,
  );
  let inputContentTokens = 0;
  // Bound each BPE operation even for long strings without whitespace.
  for (let offset = 0; offset < text.length; offset += 4096)
    inputContentTokens += tokenizer.encode(text.slice(offset, offset + 4096), [], []).length;
  const contextTokens = inputContentTokens + settlementImageTokens;

  const [historySource, samples] =
    history.user.length >= minimumHistorySamples
      ? (['user', history.user] as const)
      : history.model.length >= minimumHistorySamples
        ? (['model', history.model] as const)
        : (['none', []] as const);
  // 输出取近期中位数，偏长的输出由结算补足。
  const output = samples.length ? median(samples.map((s) => s.outputTokens)) : fallbackOutputTokens;
  // 近期缓存读写占上下文的比例；没有历史时按未命中缓存估算。
  const totalContext = samples.reduce((sum, s) => sum + s.contextTokens, 0n);
  const readRatio = ratio(
    samples.reduce((sum, s) => sum + s.cacheReadTokens, 0n),
    totalContext,
  );
  const writeRatio = ratio(
    samples.reduce((sum, s) => sum + s.cacheWriteTokens, 0n),
    totalContext,
  );
  const cacheReadTokens = Math.min(contextTokens, Math.round(contextTokens * readRatio));
  const cacheWriteTokens = Math.min(contextTokens - cacheReadTokens, Math.round(contextTokens * writeRatio));
  return {
    contextTokens,
    inputTokens: contextTokens - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: Number(output > BigInt(outputLimit) ? BigInt(outputLimit) : output),
    inputContentTokens,
    inputImageCount,
    settlementImageTokens,
    historySource,
    historySamples: samples.length,
  };
}
