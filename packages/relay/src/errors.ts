import { type Endpoint, modelListPath, openAIErrorBody, protocolFor } from '@ohmyapi/protocols';

/** 按端点协议格式化错误；模型列表使用 OpenAI 格式。 */
export function errorResponse(
  endpoint: Endpoint | typeof modelListPath,
  status: number,
  code: string,
  message: string,
  id: string,
): Response {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error';
  const details = { status, type, code, message, id };
  return Response.json(
    endpoint === modelListPath ? openAIErrorBody(details) : protocolFor(endpoint).errorBody(details),
    {
      status,
      headers: {
        'x-request-id': id,
        'cache-control': 'no-store',
        ...(status === 429 ? { 'retry-after': '60' } : {}),
      },
    },
  );
}
