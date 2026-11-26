import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 网关支持的端点，与后端定义保持一致。 */
export type Endpoint = RouterOutputs['admin']['catalog']['list']['channels'][number]['endpoints'][number];

/** 端点对应的协议名称，用于在界面上选择协议。 */
export const endpointProtocolNames = {
  '/v1/chat/completions': 'OpenAI Chat Completions',
  '/v1/responses': 'OpenAI Responses',
  '/v1/messages': 'Anthropic Messages',
  '/v1beta/generateContent': 'Google Generative AI',
  '/v1/systemone': 'Typesafe System One',
  '/v1/decisions': 'OpenAI Decisions',
} satisfies Record<Endpoint, string>;

export const endpoints = Object.keys(endpointProtocolNames) as Endpoint[];
