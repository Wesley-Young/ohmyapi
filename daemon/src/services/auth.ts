import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';

import { hashPassword, verifyPassword } from '../auth/password.js';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema/index.js';

import { createHash, randomBytes } from 'node:crypto';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type User = typeof users.$inferSelect;
export const publicUser = (user: User) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  status: user.status,
});
export type Principal = { user: ReturnType<typeof publicUser>; sessionId: string };
export const digestToken = (token: string) => createHash('sha256').update(token).digest('hex');
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export class AuthService {
  static readonly token = serviceToken<AuthService>('ohmyapi/auth');
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  private readonly attempts = new Map<string, { count: number; expires: number }>();

  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  private limitLogin(username: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key);
    for (const [key, maximum, window] of [
      ['*', 120, 60_000],
      [username, 10, 15 * 60_000],
    ] as const) {
      const attempt = this.attempts.get(key) ?? { count: 0, expires: now + window };
      if (attempt.count >= maximum || this.attempts.size >= 10_000)
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '登录尝试过于频繁，请稍后再试' });
      attempt.count++;
      this.attempts.set(key, attempt);
    }
  }

  async resolve(token: string | undefined): Promise<Principal | null> {
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
          eq(users.status, 'active'),
        ),
      );
    return row ? { user: publicUser(row.user), sessionId: row.sessionId } : null;
  }

  /** Recheck identity while holding its user lock, serializing mutations with disable/reset. */
  async authorized<T>(
    principal: Principal,
    options: { admin?: boolean },
    work: (tx: Transaction, user: User) => Promise<T>,
  ) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, principal.user.id)).for('update');
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
      if (user?.status !== 'active' || !session)
        throw new TRPCError({ code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
      if (options.admin && user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: '需要管理员权限' });
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
    const [candidate] = await this.db.select().from(users).where(eq(users.username, username));
    const valid = await verifyPassword(password, candidate?.passwordHash ?? (await this.dummyHash));
    if (!candidate || !valid || candidate.status !== 'active')
      throw new TRPCError({ code: 'UNAUTHORIZED', message: '用户名或密码错误' });
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, candidate.id)).for('update');
      if (user.status !== 'active' || user.passwordHash !== candidate.passwordHash)
        throw new TRPCError({ code: 'UNAUTHORIZED', message: '用户名或密码错误' });
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

  async changePassword(principal: Principal, currentPassword: string, newPassword: string) {
    const [candidate] = await this.db.select().from(users).where(eq(users.id, principal.user.id));
    if (!candidate || !(await verifyPassword(currentPassword, candidate.passwordHash)))
      throw new TRPCError({ code: 'BAD_REQUEST', message: '当前密码错误' });
    if (currentPassword === newPassword)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '新密码不能与当前密码相同' });
    const passwordHash = await hashPassword(newPassword);
    return this.authorized(principal, {}, async (tx, user) => {
      if (user.passwordHash !== candidate.passwordHash)
        throw new TRPCError({ code: 'CONFLICT', message: '密码已变更，请重新登录' });
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
