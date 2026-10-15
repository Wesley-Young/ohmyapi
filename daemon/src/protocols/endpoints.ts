/** 网关支持的端点。顺序即数据库枚举和界面展示的顺序，新增端点追加在末尾。 */
export const endpoints = [
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/responses/compact',
  // Gemini generateContent 与 streamGenerateContent，模型和方法位于路径中。
  '/v1beta/generateContent',
] as const;
export type Endpoint = (typeof endpoints)[number];
