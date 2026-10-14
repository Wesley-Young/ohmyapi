import { serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import { formatMoney, parseMoney } from '../../core/money.js';
import { toPage } from '../../core/pagination.js';
import { recordAudit } from '../auth/audit.js';
import { generatePassword, hashPassword } from '../auth/password.js';
import { type AuthService, type Principal, publicUser } from '../auth/service.js';
import type { Database } from '../database/client.js';
import { containsText, paginate } from '../database/query.js';
import { apiKeys, sessions, systemSettings, userGroupMembers, users, wallets } from '../database/schema/index.js';
import type { GroupService } from '../groups/service.js';
import { postLedgerEntry } from '../wallet/ledger.js';

export class UserService {
  static readonly token = serviceToken<UserService>('ohmyapi/users');
  private readonly db: Database;
  private readonly auth: AuthService;
  private readonly groups: GroupService;
  private readonly initialBalanceMicros: bigint;
  constructor(deps: { db: Database; auth: AuthService; groups: GroupService; initialBalanceMicros: bigint }) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.groups = deps.groups;
    this.initialBalanceMicros = deps.initialBalanceMicros;
  }

  /** 创建用户表单的预填值。 */
  async createDefaults() {
    const [settings] = await this.db.select({ currency: systemSettings.currency }).from(systemSettings);
    return { currency: settings.currency, initialBalance: formatMoney(this.initialBalanceMicros) };
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

  /**
   * 创建普通用户，可同时加入用户组；sync 时授予各组原有成员共有的渠道。
   * 钱包以零余额创建，非零的初始余额再作为一笔余额调整记入流水，与其他余额变动一样可追溯。
   */
  async create(
    principal: Principal,
    {
      username,
      password = generatePassword(),
      groupIds = [],
      sync = true,
      initialBalance,
    }: { username: string; password?: string; groupIds?: string[]; sync?: boolean; initialBalance?: string },
  ) {
    const initialMicros = initialBalance === undefined ? this.initialBalanceMicros : parseMoney(initialBalance);
    if (initialMicros < 0n) throw new AppError('bad_request', '初始余额不能为负数');
    const passwordHash = await hashPassword(password);
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx
        .insert(users)
        .values({ username, passwordHash })
        .onConflictDoNothing({ target: users.username, where: isNull(users.deletedAt) })
        .returning();
      if (!user) throw new AppError('conflict', '用户名已存在');
      const [wallet] = await tx.insert(wallets).values({ userId: user.id }).returning();
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        metadata: { username },
      });
      const groups = await this.groups.addNewUser(tx, actor.id, user.id, groupIds, sync);
      if (initialMicros > 0n) {
        // 新钱包在事务提交前对其他事务不可见，无需再锁定。
        const entry = await postLedgerEntry(tx, wallet, {
          kind: 'adjustment',
          idempotencyKey: `initial:${user.id}`,
          balanceDeltaMicros: initialMicros,
          reservedDeltaMicros: 0n,
          actorId: actor.id,
          reason: '初始余额',
          metadata: { source: 'user.create' },
        });
        await recordAudit(tx, {
          actorId: actor.id,
          action: 'wallet.adjust',
          targetType: 'user',
          targetId: user.id,
          metadata: {
            ledgerId: entry.id,
            amount: formatMoney(initialMicros),
            balanceBefore: formatMoney(wallet.balanceMicros),
            balanceAfter: formatMoney(entry.balanceAfterMicros),
            reason: '初始余额',
          },
        });
      }
      return { user: publicUser(user), password, ...groups, initialBalance: formatMoney(initialMicros) };
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
