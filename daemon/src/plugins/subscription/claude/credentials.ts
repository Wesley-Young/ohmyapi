import { z } from 'zod';

import { randomBytes } from 'node:crypto';

const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);
export const claudeCredentialsSchema = z.object({
  accessToken: token.refine((value) => value.includes('sk-ant-oat'), '需要 Claude OAuth 访问令牌'),
  refreshToken: token.optional(),
  accountId: z.uuid(),
  userId: z.literal('').default(''),
  organizationId: z.uuid().optional(),
  email: z.email().optional(),
  expiresAt: z.iso.datetime(),
  deviceId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ClaudeCredentials = z.infer<typeof claudeCredentialsSchema>;

export function parseClaudeCredentials(value: unknown, previous?: ClaudeCredentials): ClaudeCredentials {
  const raw = z.record(z.string(), z.unknown()).parse(value);
  const tokens = z.record(z.string(), z.unknown()).parse(raw.claudeAiOauth ?? raw);
  const account = z.record(z.string(), z.unknown()).parse(raw.account ?? {});
  const organization = z.record(z.string(), z.unknown()).parse(raw.organization ?? {});
  const expiration = tokens.expiresAt ?? tokens.expires_at ?? tokens.expired;
  const expires =
    typeof tokens.expires_in === 'number'
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : typeof expiration === 'number'
        ? new Date(expiration < 1e12 ? expiration * 1000 : expiration)
        : typeof expiration === 'string'
          ? new Date(expiration)
          : undefined;
  const devices = raw.claude_device_ids;
  return claudeCredentialsSchema.parse({
    accessToken: tokens.accessToken ?? tokens.access_token,
    refreshToken: tokens.refreshToken || tokens.refresh_token || previous?.refreshToken,
    accountId: raw.accountId ?? raw.account_uuid ?? account.uuid ?? previous?.accountId,
    // 账户 UUID 是订阅并发与去重的身份，组织信息单独保存。
    userId: '',
    organizationId: raw.organizationId ?? raw.organization_uuid ?? organization.uuid ?? previous?.organizationId,
    email: raw.email ?? account.email_address ?? account.email ?? previous?.email,
    expiresAt: expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : undefined,
    deviceId:
      previous?.deviceId ??
      raw.deviceId ??
      (Array.isArray(devices) ? devices[0] : undefined) ??
      randomBytes(32).toString('hex'),
  });
}
