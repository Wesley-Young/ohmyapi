import { z } from 'zod';

const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);
export const credentialsSchema = z.object({
  accessToken: token,
  refreshToken: token.optional(),
  accountId: z.string().min(1).max(256),
  userId: z.string().max(256).default(''),
  expiresAt: z.iso.datetime(),
});
export type OpenAICredentials = z.infer<typeof credentialsSchema>;

function claims(tokenValue: unknown): Record<string, unknown> {
  if (typeof tokenValue !== 'string') return {};
  try {
    const value = JSON.parse(Buffer.from(tokenValue.split('.')[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// JWT 内容仅用于导入元数据，账号鉴权由上游完成。
export function parseCredentials(value: unknown, previous?: OpenAICredentials): OpenAICredentials {
  const raw = z.record(z.string(), z.unknown()).parse(value);
  const tokens = raw.tokens && typeof raw.tokens === 'object' ? (raw.tokens as Record<string, unknown>) : raw;
  const accessToken = tokens.access_token ?? tokens.accessToken;
  const access = claims(accessToken);
  const identity = claims(tokens.id_token);
  const auth = {
    ...(identity['https://api.openai.com/auth'] as object),
    ...(access['https://api.openai.com/auth'] as object),
  } as Record<string, unknown>;
  const expiration = tokens.expires_at ?? tokens.expiresAt ?? raw.expires_at ?? access.exp;
  const expiresAt =
    typeof tokens.expires_in === 'number'
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : typeof expiration === 'number'
        ? new Date(expiration < 1e12 ? expiration * 1000 : expiration)
        : typeof expiration === 'string'
          ? new Date(expiration)
          : undefined;
  return credentialsSchema.parse({
    accessToken,
    refreshToken: tokens.refresh_token || tokens.refreshToken || previous?.refreshToken,
    accountId:
      tokens.account_id ??
      tokens.chatgpt_account_id ??
      raw.account_id ??
      raw.chatgpt_account_id ??
      auth.chatgpt_account_id ??
      previous?.accountId,
    userId: tokens.chatgpt_user_id ?? auth.chatgpt_user_id ?? auth.user_id ?? previous?.userId ?? '',
    expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : undefined,
  });
}
