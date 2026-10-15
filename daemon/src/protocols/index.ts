import { chatProtocol } from './chat.ts';
import type { Endpoint } from './endpoints.ts';
import { geminiProtocol } from './gemini.ts';
import { messagesProtocol } from './messages.ts';
import { responses, responsesCompact } from './responses.ts';
import type { ApiProtocol } from './types.ts';

export { type Endpoint, endpoints } from './endpoints.ts';
export { isPathModel as isGeminiPathModel, repairGeminiHistory } from './gemini.ts';
export { openAIErrorBody } from './openai.ts';
export { codexRequestHeaders } from './responses.ts';
export type * from './types.ts';
export { valueAt } from './util.ts';

const registry = {
  '/v1/chat/completions': chatProtocol,
  '/v1/responses': responses,
  '/v1/messages': messagesProtocol,
  '/v1/responses/compact': responsesCompact,
  '/v1beta/generateContent': geminiProtocol,
} as const satisfies Record<Endpoint, ApiProtocol>;

/** 端点对应的协议描述。 */
export const protocolFor = (endpoint: Endpoint): ApiProtocol => registry[endpoint];

/** 全部协议，顺序与端点列表一致。 */
export const protocols: readonly ApiProtocol[] = Object.values(registry);
