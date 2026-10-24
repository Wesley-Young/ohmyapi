/** 网关支持的端点。顺序即数据库枚举和界面展示的顺序，新增端点追加在末尾。 */
export const endpoints = [
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/responses/compact',
  // Gemini generateContent 与 streamGenerateContent，模型和方法位于路径中。
  '/v1beta/generateContent',
  // TypeSafe System One 决策接口，返回类型化的判断而不是生成文本。
  '/v1/systemone',
] as const;
export type Endpoint = (typeof endpoints)[number];

/** 同一协议族共享请求和响应结构，例如 Responses 与 compact。 */
export type ProtocolFamily = 'chat' | 'responses' | 'messages' | 'gemini' | 'systemone';

/**
 * 每个协议族的主端点。上游服务按协议族提供 API：提供主端点的服务同时提供同族的其他端点，例如 Responses 与 compact。
 */
export const familyEndpoints = {
  chat: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  gemini: '/v1beta/generateContent',
  systemone: '/v1/systemone',
} as const satisfies Record<ProtocolFamily, Endpoint>;
export type FamilyEndpoint = (typeof familyEndpoints)[ProtocolFamily];
