import { GatewayError } from './errors.ts';
import type { Data, RequestTarget } from './types.ts';

export const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

/** 按点分隔的路径读取嵌套字段。 */
export function valueAt(body: Data, path: string): unknown {
  let value: unknown = body;
  for (const key of path.split('.')) value = object(value)?.[key];
  return value;
}

/** 非负安全整数转为 bigint，其余返回 undefined。 */
export const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;

/** 拼接上游地址；渠道地址已以 /v1 结尾时不重复版本段。 */
export function versionedUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${base.endsWith('/v1') ? path.slice(3) : path}`;
}

/** 模型和流式选项位于请求体的协议使用的目标解析。 */
export function bodyTarget(body: Data): RequestTarget {
  if (
    typeof body.model !== 'string' ||
    !body.model ||
    body.model.length > 128 ||
    (body.stream !== undefined && typeof body.stream !== 'boolean')
  )
    throw new GatewayError(400, 'invalid_request', 'A model name and a boolean stream option are required');
  return { model: body.model, streaming: body.stream === true };
}

/** 函数和自定义工具在各协议中写法一致。 */
export const isFunctionTool = (tool: Data) => tool.type === 'function' || tool.type === 'custom';

/** 消息数组中的对象，供 Chat Completions 和 Messages 遍历内容。 */
export const messageObjects = (body: Data): Data[] =>
  Array.isArray(body.messages) ? body.messages.filter((message): message is Data => object(message) !== undefined) : [];

/** 用量中出现音频、视频或非输入方向的图像 Token 时，费用无法按文本价格结算。 */
export function hasUnpricedMedia(raw: Data, inputDetails: Data | undefined): boolean {
  const outputDetails = [object(raw.completion_tokens_details), object(raw.output_tokens_details)];
  return (
    [raw, inputDetails, ...outputDetails].some(
      (part) => part && ['audio_tokens', 'video_tokens'].some((key) => typeof part[key] === 'number' && part[key] > 0),
    ) ||
    // 输入图像已包含在输入总量中；图像输出和未标明方向的图像费用仍需核对。
    [raw, ...outputDetails].some((part) => part && typeof part.image_tokens === 'number' && part.image_tokens > 0)
  );
}
