import { serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import { formatMoney } from '../../core/money.js';
import { toPage } from '../../core/pagination.js';
import { recordAudit } from '../auth/audit.js';
import { generatePassword, hashPassword } from '../auth/password.js';
import { type AuthService, type Principal, publicUser } from '../auth/service.js';
import type { Database } from '../database/client.js';
import { containsText, paginate } from '../database/query.js';
import { apiKeys, sessions, systemSettings, userGroupMembers, users, wallets } from '../database/schema/index.js';

export class UserService {
  static readonly token = serviceToken<UserService>('ohmyapi/users');
  private readonly db: Database;
  private readonly auth: AuthService;
  constructor({ db, auth }: { db: Database; auth: AuthService }) {
    this.db = db;
    this.auth = auth;
  }

  async list(page: number, search: string) {
    const [settings] = await this.db.select({ currency: systemSettings.currency }).from(systemSettings);
    const rows = await paginate(
      this.db
        .select({ user: users, wallet: wallets })
        .from(users)
        .innerJoin(wallets, eq(users.id, wallets.userId))
        .where(and(isNull(users.deletedAt), containsText(users.username, search)))
        .orderBy(desc(users.createdAt), desc(users.id))
        .$dynamic(),
      page,
    );
    const { items, hasMore } = toPage(rows);
    return {
      currency: settings.currency,
      items: items.map(({ user, wallet }) => ({
        ...publicUser(user),
        createdAt: user.createdAt.toISOString(),
        balance: formatMoney(wallet.balanceMicros),
      })),
      hasMore,
    };
  }

  async get(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new AppError('not_found', '用户不存在');
    return { ...publicUser(user), createdAt: user.createdAt.toISOString(), deleted: user.deletedAt !== null };
  }

  async create(principal: Principal, username: string, password: string = generatePassword()) {
    const passwordHash = await hashPassword(password);
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx
        .insert(users)
        .values({ username, passwordHash })
        .onConflictDoNothing({ target: users.username, where: isNull(users.deletedAt) })
        .returning();
      if (!user) throw new AppError('conflict', '用户名已存在');
      await tx.insert(wallets).values({ userId: user.id });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        metadata: { username },
      });
      return { user: publicUser(user), password };
    });
  }

  async setRole(principal: Principal, userId: string, role: 'admin' | 'user') {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [target] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');
      if (!target) throw new AppError('not_found', '用户不存在');
      if (target.role === role) return publicUser(target);
      if (actor.id === userId) throw new AppError('forbidden', '请由其他管理员将你降级为普通用户');
      if (role === 'admin' && target.status !== 'active')
        throw new AppError('bad_request', '请先启用该用户，再提升为管理员');
      const [updated] = await tx.update(users).set({ role }).where(eq(users.id, userId)).returning();
      // 管理员不属于任何用户组。
      const leftGroups =
        role === 'admin'
          ? await tx
              .delete(userGroupMembers)
              .where(eq(userGroupMembers.userId, userId))
              .returning({ groupId: userGroupMembers.groupId })
          : [];
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'user.set_role',
        targetType: 'user',
        targetId: userId,
        metadata: {
          username: target.username,
          previousRole: target.role,
          role,
          ...(leftGroups.length ? { leftGroupIds: leftGroups.map((group) => group.groupId) } : {}),
        },
      });
      return publicUser(updated);
    });
  }

  async manage(
    principal: Principal,
    userId: string,
    action: 'enable' | 'disable' | 'revoke_sessions' | 'reset_password' | 'delete',
    password?: string,
  ) {
    const passwordHash = action === 'reset_password' && password ? await hashPassword(password) : undefined;
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [target] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');
      if (!target) throw new AppError('not_found', '用户不存在');
      if (target.role !== 'user') throw new AppError('forbidden', '此操作仅适用于普通用户');
      if (action === 'reset_password' && !passwordHash) throw new AppError('bad_request', '请填写新密码');
      if (action === 'enable' || action === 'disable')
        await tx
          .update(users)
          .set({ status: action === 'enable' ? 'active' : 'disabled' })
          .where(eq(users.id, userId));
      if (action === 'reset_password') await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
      if (action === 'delete') {
        const now = new Date();
        await tx.update(users).set({ deletedAt: now, status: 'disabled' }).where(eq(users.id, userId));
        await tx
          .update(apiKeys)
          .set({ deletedAt: now, revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${now})` })
          .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.deletedAt)));
        await tx.delete(userGroupMembers).where(eq(userGroupMembers.userId, userId));
      }
      if (action !== 'enable')
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      if (action === 'reset_password')
        await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.userId, userId));
      await recordAudit(tx, {
        actorId: actor.id,
        action: `user.${action}`,
        targetType: 'user',
        targetId: userId,
        metadata: { username: target.username },
      });
      return { success: true };
    });
  }
}
