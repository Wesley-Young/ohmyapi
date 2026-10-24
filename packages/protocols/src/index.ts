import type { Endpoint } from './endpoints.ts';
import { chatProtocol } from './families/chat.ts';
import { geminiProtocol } from './families/gemini.ts';
import { messagesProtocol } from './families/messages.ts';
import { responses, responsesCompact } from './families/responses.ts';
import { systemOneProtocol } from './families/systemone.ts';
import type { ApiProtocol } from './types.ts';

export {
  type Endpoint,
  endpoints,
  type FamilyEndpoint,
  familyEndpoints,
  type ProtocolFamily,
} from './endpoints.ts';
export { GatewayError } from './errors.ts';
export { isPathModel as isGeminiPathModel, repairGeminiHistory } from './families/gemini.ts';
export { openAIErrorBody } from './families/openai-shared.ts';
export { codexRequestHeaders } from './families/responses.ts';
export { modelListBody, modelListPath } from './models.ts';
export type * from './types.ts';
export { valueAt } from './util.ts';

const registry = {
  '/v1/chat/completions': chatProtocol,
  '/v1/responses': responses,
  '/v1/messages': messagesProtocol,
  '/v1/responses/compact': responsesCompact,
  '/v1beta/generateContent': geminiProtocol,
  '/v1/systemone': systemOneProtocol,
} as const satisfies Record<Endpoint, ApiProtocol>;

/** 端点对应的协议描述。 */
export const protocolFor = (endpoint: Endpoint): ApiProtocol => registry[endpoint];

/** 全部协议，顺序与端点列表一致。 */
export const protocols: readonly ApiProtocol[] = Object.values(registry);
