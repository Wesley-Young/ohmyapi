import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 网关支持的端点，与后端定义保持一致。 */
export type Endpoint = RouterOutputs['admin']['catalog']['list']['channels'][number]['endpoints'][number];

/** 全部端点，顺序即界面展示顺序。 */
export const endpoints = Object.keys({
  '/v1/chat/completions': true,
  '/v1/responses': true,
  '/v1/messages': true,
  '/v1/responses/compact': true,
} satisfies Record<Endpoint, true>) as Endpoint[];
export const responsesEndpoints: Endpoint[] = ['/v1/responses', '/v1/responses/compact'];
