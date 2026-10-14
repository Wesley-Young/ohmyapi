import { serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import type { Database } from '../database/client.ts';
import { activeUser } from '../database/query.ts';
import { adminScopes, adminTokens, users } from '../database/schema/index.ts';
import { recordAudit } from './audit.ts';
import type { CreateAdminTokenInput } from './schemas.ts';
import { type AuthService, digestToken, publicUser, type SessionPrincipal, type TokenPrincipal } from './service.ts';

import { randomBytes } from 'node:crypto';

const tokenPrefix = 'oma_admin_';
export const adminTokenPattern = /^oma_admin_[A-Za-z0-9_-]{43}$/;
const maxActiveTokens = 20;

const activeToken = () =>
  and(isNull(adminTokens.revokedAt), or(isNull(adminTokens.expiresAt), gt(adminTokens.expiresAt, new Date())));

/** 公开 API 的管理令牌。令牌以所属管理员的身份调用，只在所属用户仍是有效管理员时可用。 */
export class AdminTokens {
  static readonly token = serviceToken<AdminTokens>('ohmyapi/admin-tokens');
  private readonly db: Database;
  private readonly auth: AuthService;
  constructor({ db, auth }: { db: Database; auth: AuthService }) {
    this.db = db;
    this.auth = auth;
  }

  /** 当前管理员未吊销的令牌，包括已过期的。 */
  async list(principal: SessionPrincipal) {
    const rows = await this.db
      .select({
        id: adminTokens.id,
        name: adminTokens.name,
        hint: adminTokens.hint,
        scopes: adminTokens.scopes,
        expiresAt: adminTokens.expiresAt,
        lastUsedAt: adminTokens.lastUsedAt,
        createdAt: adminTokens.createdAt,
      })
      .from(adminTokens)
      .where(and(eq(adminTokens.userId, principal.user.id), isNull(adminTokens.revokedAt)))
      .orderBy(desc(adminTokens.createdAt), desc(adminTokens.id));
    return rows.map((row) => ({
      ...row,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async create(principal: SessionPrincipal, input: CreateAdminTokenInput) {
    return this.auth.authorized(principal, { admin: true }, async (tx, user) => {
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError('bad_request', '有效期必须晚于当前时间');
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(adminTokens)
        .where(and(eq(adminTokens.userId, user.id), activeToken()));
      if (count >= maxActiveTokens) throw new AppError('bad_request', `最多保留 ${maxActiveTokens} 个有效令牌`);
      const token = `${tokenPrefix}${randomBytes(32).toString('base64url')}`;
      const scopes = adminScopes.filter((scope) => input.scopes.includes(scope));
      const [created] = await tx
        .insert(adminTokens)
        .values({
          userId: user.id,
          name: input.name,
          tokenHash: digestToken(token),
          hint: token.slice(-4),
          scopes,
          expiresAt,
        })
        .returning({ id: adminTokens.id });
      await recordAudit(tx, {
        actorId: user.id,
        action: 'admin_token.create',
        targetType: 'admin_token',
        targetId: created.id,
        metadata: { name: input.name, scopes, expiresAt: expiresAt?.toISOString() ?? null },
      });
      return { id: created.id, token };
    });
  }

  async revoke(principal: SessionPrincipal, tokenId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, user) => {
      const [revoked] = await tx
        .update(adminTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(adminTokens.id, tokenId), eq(adminTokens.userId, user.id), isNull(adminTokens.revokedAt)))
        .returning({ id: adminTokens.id, name: adminTokens.name });
      if (!revoked) throw new AppError('not_found', '令牌不存在或已吊销');
      await recordAudit(tx, {
        actorId: user.id,
        action: 'admin_token.revoke',
        targetType: 'admin_token',
        targetId: revoked.id,
        metadata: { name: revoked.name },
      });
      return { success: true };
    });
  }

  /** 解析有效的令牌并记录使用时间；令牌无效、过期，或所属用户不再是有效管理员时返回 null。 */
  async resolve(token: string): Promise<TokenPrincipal | null> {
    if (!adminTokenPattern.test(token)) return null;
    const [row] = await this.db
      .select({ user: users, tokenId: adminTokens.id, scopes: adminTokens.scopes })
      .from(adminTokens)
      .innerJoin(users, eq(adminTokens.userId, users.id))
      .where(and(eq(adminTokens.tokenHash, digestToken(token)), activeToken(), activeUser(), eq(users.role, 'admin')));
    if (!row) return null;
    // 最近使用时间精确到分钟即可，避免每个请求都写库。
    await this.db
      .update(adminTokens)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(adminTokens.id, row.tokenId),
          or(isNull(adminTokens.lastUsedAt), lt(adminTokens.lastUsedAt, new Date(Date.now() - 60_000))),
        ),
      );
    return { user: publicUser(row.user), tokenId: row.tokenId, scopes: row.scopes };
  }
}
