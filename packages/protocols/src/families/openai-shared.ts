import type { Data, ErrorDetails, NormalizedUsage, UsageReader } from '../types.ts';
import { count, hasUnpricedMedia, object, reportedFields } from '../util.ts';

/** OpenAI 格式的错误响应体。 */
export const openAIErrorBody = ({ type, code, message }: ErrorDetails) => ({
  error: { type, code, message, param: null },
});

export function bearerHeaders(credential: string): Headers {
  return new Headers({ authorization: `Bearer ${credential}` });
}

/** OpenAI 格式的输入总量包含缓存读写，缓存明细位于输入 details。 */
export function openAIUsage(raw: Data, inputKey: string, outputKey: string, detailsKey: string): NormalizedUsage {
  const input = count(raw[inputKey]);
  const output = count(raw[outputKey]);
  const details = object(raw[detailsKey]);
  const unknownCosts = hasUnpricedMedia(raw, details);
  // 上游省略或以 null 表示没有报告的字段，缓存和图像明细按 0 计。
  const read = details?.cached_tokens == null ? 0n : count(details.cached_tokens);
  const write = details?.cache_write_tokens == null ? 0n : count(details.cache_write_tokens);
  const image = details?.image_tokens == null ? 0n : count(details.image_tokens);
  if (
    (raw[inputKey] != null && input === undefined) ||
    (raw[outputKey] != null && output === undefined) ||
    read === undefined ||
    write === undefined ||
    image === undefined
  )
    return { valid: false, unknownCosts };
  return { valid: true, unknownCosts, input, output, read, write, image, inputIncludesCache: true };
}

/** 流式事件只报告部分 details 或以 null 省略字段时保留此前的明细。 */
export const mergeDetails =
  (detailsKey: string): UsageReader['merge'] =>
  (previous, next) => ({
    ...previous,
    ...reportedFields(next),
    [detailsKey]: { ...object(previous[detailsKey]), ...reportedFields(next[detailsKey]) },
  });
