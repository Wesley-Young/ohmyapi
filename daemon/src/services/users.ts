import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, like } from 'drizzle-orm';

import { generatePassword, hashPassword } from '../auth/password.js';
import { formatMoney } from '../billing/conventions.js';
import { adminAuditLogs, apiKeys, sessions, systemSettings, users, wallets } from '../db/schema/index.js';
import { type AuthService, type Principal, publicUser } from './auth.js';

export const pageSize = 20;

export class UserService {
  static readonly token = serviceToken<UserService>('ohmyapi/users');
  private readonly auth: AuthService;
  constructor(auth: AuthService) {
    this.auth = auth;
  }

  async list(page: number, search: string) {
    const [settings] = await this.auth.db.select({ currency: systemSettings.currency }).from(systemSettings);
    const rows = await this.auth.db
      .select({ user: users, wallet: wallets })
      .from(users)
      .innerJoin(wallets, eq(users.id, wallets.userId))
      .where(search ? like(users.username, `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`) : undefined)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(pageSize + 1)
      .offset(page * pageSize);
    return {
      currency: settings.currency,
      items: rows.slice(0, pageSize).map(({ user, wallet }) => ({
        ...publicUser(user),
        createdAt: user.createdAt.toISOString(),
        balance: formatMoney(wallet.balanceMicros),
      })),
      hasMore: rows.length > pageSize,
    };
  }

  async get(userId: string) {
    const [user] = await this.auth.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: '用户不存在' });
    return { ...publicUser(user), createdAt: user.createdAt.toISOString() };
  }

  async create(principal: Principal, username: string, password: string = generatePassword()) {
    const passwordHash = await hashPassword(password);
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx
        .insert(users)
        .values({ username, passwordHash })
        .onConflictDoNothing({ target: users.username })
        .returning();
      if (!user) throw new TRPCError({ code: 'CONFLICT', message: '用户名已存在' });
      await tx.insert(wallets).values({ userId: user.id });
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        metadata: { username },
      });
      return { user: publicUser(user), password };
    });
  }

  async manage(
    principal: Principal,
    userId: string,
    action: 'enable' | 'disable' | 'revoke_sessions' | 'reset_password',
    password?: string,
  ) {
    const passwordHash = action === 'reset_password' && password ? await hashPassword(password) : undefined;
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [target] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: '用户不存在' });
      if (target.role !== 'user') throw new TRPCError({ code: 'FORBIDDEN', message: '此操作仅适用于普通用户' });
      if (action === 'reset_password' && !passwordHash)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写新密码' });
      if (action === 'enable' || action === 'disable')
        await tx
          .update(users)
          .set({ status: action === 'enable' ? 'active' : 'disabled' })
          .where(eq(users.id, userId));
      if (action === 'reset_password') await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
      if (action !== 'enable')
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      if (action === 'reset_password')
        await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.userId, userId));
      await tx
        .insert(adminAuditLogs)
        .values({ actorId: actor.id, action: `user.${action}`, targetType: 'user', targetId: userId });
      return { success: true };
    });
  }
}
