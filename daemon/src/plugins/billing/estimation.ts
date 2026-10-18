import { protocolFor } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { requestContentBlocks } from './content.ts';
import { estimateImageTokens } from './image-estimation.ts';

/**
 * 按字符类别粗略估算 Token，以四分之一 Token 为单位：ASCII 记 1，CJK、假名、谚文和全角字符记 4，
 * 其他字符记 2（代理对的两个码元合计 4）。不对应任何模型的分词器，只用于预占和断连估算。
 */
function textUnits(text: string) {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    units +=
      c < 0x80
        ? 1
        : (c >= 0x2e80 && c <= 0x9fff) ||
            (c >= 0xac00 && c <= 0xd7af) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xff00 && c <= 0xffef)
          ? 4
          : 2;
  }
  return units;
}

const unitsToTokens = (units: number) => Math.ceil(units / 4);

/** 估算方法的标识，随断连估算一起保存。 */
export const tokenEstimateMethod = 'char_class_v1';

/** 累计流式输出的字符单位；按字符计数与 SSE 分片边界无关。 */
export class OutputTokenEstimate {
  private units = 0;

  append(value: unknown) {
    if (typeof value === 'string' && value) this.units += textUnits(value);
  }

  /** 已观察内容的估算 Token 数。 */
  count() {
    return BigInt(unitsToTokens(this.units));
  }

  reset() {
    this.units = 0;
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
  // 计入消息结构、工具定义和指令。
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
  const inputContentTokens = unitsToTokens(textUnits(text));
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
