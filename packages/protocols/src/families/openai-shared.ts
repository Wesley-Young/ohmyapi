import type { Data, ErrorDetails, NormalizedUsage, UsageReader } from '../types.ts';
import { count, hasUnpricedMedia, object } from '../util.ts';

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
  const read = details?.cached_tokens === undefined ? 0n : count(details.cached_tokens);
  const write = details?.cache_write_tokens === undefined ? 0n : count(details.cache_write_tokens);
  const image = details?.image_tokens === undefined ? 0n : count(details.image_tokens);
  if (
    (raw[inputKey] !== undefined && input === undefined) ||
    (raw[outputKey] !== undefined && output === undefined) ||
    read === undefined ||
    write === undefined ||
    image === undefined
  )
    return { valid: false, unknownCosts };
  return { valid: true, unknownCosts, input, output, read, write, image, inputIncludesCache: true };
}

/** 流式事件只报告部分 details 时保留此前的明细。 */
export const mergeDetails =
  (detailsKey: string): UsageReader['merge'] =>
  (previous, next) => ({
    ...previous,
    ...next,
    [detailsKey]: { ...object(previous[detailsKey]), ...object(next[detailsKey]) },
  });
