import { GatewayError } from '../../../core/errors.ts';

import { createHash, randomUUID } from 'node:crypto';

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

/**
 * 将 Gemini generateContent 请求包装为 v1internal 请求。请求体已统一为 lowerCamelCase 写法。
 * 会话 ID 取首条用户内容的摘要，与官方客户端一样在同一对话内保持稳定。
 */
export function antigravityRequest(model: string, body: Data, projectId: string) {
  const request = structuredClone(body);
  delete request.model;
  // v1internal 不接受 Gemini 的 safetySettings；明确拒绝，避免静默丢弃客户端的安全设置。
  if (request.safetySettings !== undefined)
    throw new GatewayError(400, 'invalid_request', 'safetySettings are not supported by Antigravity channels');
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const firstUser = contents.find((content) => object(content)?.role !== 'model');
  const digest = createHash('sha256')
    .update(JSON.stringify(firstUser ?? {}))
    .digest();
  request.sessionId = `-${digest.readBigUInt64BE() & 0x7fffffffffffffffn}`;
  const generation = object(request.generationConfig);
  if (generation && generation.responseJsonSchema !== undefined && generation.responseSchema === undefined) {
    generation.responseSchema = generation.responseJsonSchema;
    delete generation.responseJsonSchema;
  }
  // 上游按 parametersJsonSchema 接受完整的 JSON Schema。
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    const declarations = object(tool)?.functionDeclarations;
    if (!Array.isArray(declarations)) continue;
    for (const item of declarations) {
      const declaration = object(item);
      if (declaration && declaration.parameters !== undefined && declaration.parametersJsonSchema === undefined) {
        declaration.parametersJsonSchema = declaration.parameters;
        delete declaration.parameters;
      }
    }
  }
  return {
    project: projectId,
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${randomUUID()}`,
    request,
  };
}

/** countTokens 只发送模型和内容；客户端可以直接给出 contents，或放在 generateContentRequest 中。 */
export function antigravityCountTokensRequest(model: string, body: Data) {
  const contents = body.contents ?? object(body.generateContentRequest)?.contents;
  if (!Array.isArray(contents)) throw new GatewayError(400, 'invalid_request', 'contents must be an array');
  return { request: { model: `models/${model}`, contents } };
}
