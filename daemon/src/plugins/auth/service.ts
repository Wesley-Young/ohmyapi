import { serviceToken } from '@fraqjs/kernel';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import { createLogSampler, type EventLogger, formatEvent } from '../../core/logging.ts';
import type { Database, Transaction } from '../database/client.ts';
import { activeUser } from '../database/query.ts';
import { type AdminScope, adminTokens, sessions, users } from '../database/schema/index.ts';
import { attributeAudit } from './audit.ts';
import { hashPassword, verifyPassword } from './password.ts';

import { createHash, randomBytes } from 'node:crypto';

export type User = typeof users.$inferSelect;
export const publicUser = (user: User) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  status: user.status,
});
export type PublicUser = ReturnType<typeof publicUser>;
/** 控制台登录会话的身份。 */
export type SessionPrincipal = { user: PublicUser; sessionId: string };
/** 公开 API 管理令牌的身份，以所属管理员的身份操作。 */
export type TokenPrincipal = { user: PublicUser; tokenId: string; scopes: AdminScope[] };
export type Principal = SessionPrincipal | TokenPrincipal;
export const digestToken = (token: string) => createHash('sha256').update(token).digest('hex');
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export class AuthService {
  static readonly token = serviceToken<AuthService>('ohmyapi/auth');
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  private readonly attempts = new Map<string, { count: number; expires: number }>();

  private readonly db: Database;
  private readonly logger: EventLogger;
  private readonly sampleLog = createLogSampler();
  constructor({ db, logger }: { db: Database; logger: EventLogger }) {
    this.db = db;
    this.logger = logger;
  }

  private limitLogin(username: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key);
    for (const [key, maximum, window] of [
      ['*', 120, 60_000],
      [username, 10, 15 * 60_000],
    ] as const) {
      const attempt = this.attempts.get(key) ?? { count: 0, expires: now + window };
      if (attempt.count >= maximum || this.attempts.size >= 10_000) {
        const scope = this.attempts.size >= 10_000 ? 'capacity' : key === '*' ? 'global' : 'account';
        if (this.sampleLog(scope))
          this.logger.warn(
            formatEvent('登录触发限流', {
              scope,
              attempts: scope === 'capacity' ? undefined : attempt.count,
              trackedAccounts: scope === 'capacity' ? this.attempts.size : undefined,
              limit: scope === 'capacity' ? 10_000 : maximum,
              windowMs: scope === 'capacity' ? undefined : window,
            }),
          );
        throw new AppError('too_many_requests', '登录尝试过于频繁，请稍后再试');
      }
      attempt.count++;
      this.attempts.set(key, attempt);
    }
  }

  async resolve(token: string | undefined): Promise<SessionPrincipal | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [row] = await this.db
      .select({ user: users, sessionId: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, digestToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          activeUser(),
        ),
      );
    return row ? { user: publicUser(row.user), sessionId: row.sessionId } : null;
  }

  /**
   * Recheck identity while holding its user lock, serializing mutations with disable/reset.
   * 管理令牌须仍有效且所属用户仍是管理员；事务内的审计记录会标注令牌。
   */
  async authorized<T>(
    principal: Principal,
    options: { admin?: boolean },
    work: (tx: Transaction, user: User) => Promise<T>,
  ) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, principal.user.id)).for('update');
      const active = user?.status === 'active' && !user.deletedAt;
      if ('tokenId' in principal) {
        const [token] = await tx
          .select({ id: adminTokens.id })
          .from(adminTokens)
          .where(
            and(
              eq(adminTokens.id, principal.tokenId),
              eq(adminTokens.userId, principal.user.id),
              isNull(adminTokens.revokedAt),
              or(isNull(adminTokens.expiresAt), gt(adminTokens.expiresAt, new Date())),
            ),
          );
        if (!active || user.role !== 'admin' || !token) throw new AppError('unauthorized', '管理令牌无效或已过期');
        attributeAudit(tx, { adminTokenId: token.id });
      } else {
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, principal.sessionId),
              eq(sessions.userId, principal.user.id),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, new Date()),
            ),
          );
        if (!active || !session) throw new AppError('unauthorized', '登录已失效，请重新登录');
      }
      if (options.admin && user.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
      return work(tx, user);
    });
  }

  private async createSession(tx: Transaction, userId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    await tx.insert(sessions).values({ userId, tokenHash: digestToken(token), expiresAt });
    return { token, expiresAt };
  }

  async login(username: string, password: string) {
    this.limitLogin(username);
    const [candidate] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.username, username), isNull(users.deletedAt)));
    const valid = await verifyPassword(password, candidate?.passwordHash ?? (await this.dummyHash));
    if (!candidate || !valid || candidate.status !== 'active') throw new AppError('unauthorized', '用户名或密码错误');
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, candidate.id)).for('update');
      if (user.status !== 'active' || user.deletedAt || user.passwordHash !== candidate.passwordHash)
        throw new AppError('unauthorized', '用户名或密码错误');
      const session = await this.createSession(tx, user.id);
      this.attempts.delete(username);
      return { ...session, user: publicUser(user) };
    });
  }

  async logout(token: string | undefined) {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.tokenHash, digestToken(token)));
  }

  async changePassword(principal: SessionPrincipal, currentPassword: string, newPassword: string) {
    const [candidate] = await this.db.select().from(users).where(eq(users.id, principal.user.id));
    if (!candidate || !(await verifyPassword(currentPassword, candidate.passwordHash)))
      throw new AppError('bad_request', '当前密码错误');
    if (currentPassword === newPassword) throw new AppError('bad_request', '新密码不能与当前密码相同');
    const passwordHash = await hashPassword(newPassword);
    return this.authorized(principal, {}, async (tx, user) => {
      if (user.passwordHash !== candidate.passwordHash) throw new AppError('conflict', '密码已变更，请重新登录');
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, user.id));
      return this.createSession(tx, user.id);
    });
  }

  async cleanupSessions() {
    await this.db
      .delete(sessions)
      .where(
        or(lt(sessions.expiresAt, new Date()), lt(sessions.revokedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))),
      );
  }
}
