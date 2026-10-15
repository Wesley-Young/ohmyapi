import { z } from 'zod';

import type { OutboundFetch } from '../../outbound/index.ts';
import { fetchAntigravityUser, loadAntigravityAccount, refreshAntigravityToken } from './client.ts';

const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);
export const antigravityCredentialsSchema = z.object({
  accessToken: token,
  refreshToken: token,
  /** Google 账号 ID，作为订阅账号的身份。 */
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  userId: z.literal('').default(''),
  email: z.email().optional(),
  /** Antigravity 项目；缺失时在首次使用前查询。 */
  projectId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,256}$/)
    .optional(),
  expiresAt: z.iso.datetime(),
});
export type AntigravityCredentials = z.infer<typeof antigravityCredentialsSchema>;

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** OAuth 兑换结果补充账号信息；项目查询失败时先保存凭据，首次使用前再查询。 */
export async function completeAntigravityCredentials(
  tokens: { access_token: string; refresh_token: string; expires_in: number },
  request: OutboundFetch,
  signal: AbortSignal,
): Promise<AntigravityCredentials> {
  const user = await fetchAntigravityUser(tokens.access_token, request, signal);
  const account = await loadAntigravityAccount(tokens.access_token, request, signal).catch(() => undefined);
  return antigravityCredentialsSchema.parse({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: user.id,
    email: user.email,
    projectId: account?.projectId,
    expiresAt: expiry(tokens.expires_in),
  });
}

/**
 * 导入 CLIProxyAPI 的 antigravity 凭据或 apsis 的凭据文件。
 * refresh token 必需；访问令牌缺失或即将过期时先刷新，再查询账号和项目。
 */
export async function importAntigravityCredentials(value: unknown, request: OutboundFetch, signal: AbortSignal) {
  const source = z.record(z.string(), z.unknown()).parse(value);
  const raw = {
    ...source,
    ...z
      .record(z.string(), z.unknown())
      .catch({})
      .parse(source.metadata ?? {}),
  };
  const refreshToken = token.parse(raw.refresh_token ?? raw.refreshToken);
  const rawExpiry = raw.expired ?? raw.expiry ?? raw.expiresAt ?? raw.expires_at;
  const expiresAt =
    typeof rawExpiry === 'number'
      ? rawExpiry < 1e12
        ? rawExpiry * 1000
        : rawExpiry
      : typeof rawExpiry === 'string'
        ? Date.parse(rawExpiry)
        : Number.NaN;
  let accessToken = token.safeParse(raw.access_token ?? raw.accessToken).data;
  let expiresIso = Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : undefined;
  if (!accessToken || !expiresIso || Date.parse(expiresIso) < Date.now() + 5 * 60_000) {
    const refreshed = await refreshAntigravityToken(refreshToken, request, signal);
    accessToken = refreshed.access_token;
    expiresIso = expiry(refreshed.expires_in);
  }
  const user = await fetchAntigravityUser(accessToken, request, signal);
  const projectId =
    z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,256}$/)
      .safeParse(raw.project_id ?? raw.projectId).data ??
    (await loadAntigravityAccount(accessToken, request, signal).catch(() => undefined))?.projectId;
  return antigravityCredentialsSchema.parse({
    accessToken,
    refreshToken,
    accountId: user.id,
    email: user.email ?? z.email().safeParse(raw.email).data,
    projectId,
    expiresAt: expiresIso,
  });
}
