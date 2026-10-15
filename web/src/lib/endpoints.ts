import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 网关支持的端点，与后端定义保持一致。 */
export type Endpoint = RouterOutputs['admin']['catalog']['list']['channels'][number]['endpoints'][number];

/** 全部端点，顺序即界面展示顺序。 */
export const endpoints = Object.keys({
  '/v1/chat/completions': true,
  '/v1/responses': true,
  '/v1/messages': true,
  '/v1/responses/compact': true,
  '/v1beta/generateContent': true,
} satisfies Record<Endpoint, true>) as Endpoint[];
/** 端点对应的协议名称，用于在界面上选择协议。 */
export const endpointProtocolNames = {
  '/v1/chat/completions': 'Chat Completions',
  '/v1/responses': 'Responses',
  '/v1/messages': 'Messages',
  '/v1/responses/compact': 'Responses Compact',
  '/v1beta/generateContent': 'Gemini',
} satisfies Record<Endpoint, string>;

export const responsesEndpoints: Endpoint[] = ['/v1/responses', '/v1/responses/compact'];
