/** 网关支持的全部端点，顺序即界面展示顺序。 */
export const endpoints = ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/responses/compact'] as const;
export type Endpoint = (typeof endpoints)[number];
export const responsesEndpoints: Endpoint[] = ['/v1/responses', '/v1/responses/compact'];
