import { serviceToken } from '@fraqjs/kernel';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import { toPage } from '../../core/pagination.js';
import { recordAudit } from '../auth/audit.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { Database, Transaction } from '../database/client.js';
import { containsText, paginate } from '../database/query.js';
import { channels, userChannelGrants, userGroupMembers, userGroups, users } from '../database/schema/index.js';

const eligibleUser = () => and(eq(users.role, 'user'), isNull(users.deletedAt));
const privateChannel = () => and(eq(channels.isPublic, false), isNull(channels.deletedAt));

/**
 * 用户组是普通用户的标签，不保存渠道授权。
 * 组级授权和撤销在操作时展开写入成员的渠道授权；成员加入或离开组不改变已有授权。
 */
export class GroupService {
  static readonly token = serviceToken<GroupService>('ohmyapi/groups');
  private readonly db: Database;
  private readonly auth: AuthService;
  constructor(deps: { db: Database; auth: AuthService }) {
    this.db = deps.db;
    this.auth = deps.auth;
  }

  async list() {
    const rows = await this.db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        createdAt: userGroups.createdAt,
        memberCount: count(userGroupMembers.userId),
      })
      .from(userGroups)
      .leftJoin(userGroupMembers, eq(userGroupMembers.groupId, userGroups.id))
      .groupBy(userGroups.id)
      .orderBy(asc(userGroups.name), asc(userGroups.id));
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async get(groupId: string) {
    const [group] = await this.db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        createdAt: userGroups.createdAt,
        memberCount: count(userGroupMembers.userId),
      })
      .from(userGroups)
      .leftJoin(userGroupMembers, eq(userGroupMembers.groupId, userGroups.id))
      .where(eq(userGroups.id, groupId))
      .groupBy(userGroups.id);
    if (!group) throw new AppError('not_found', '用户组不存在');
    return { ...group, createdAt: group.createdAt.toISOString() };
  }

  async create(principal: Principal, name: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [group] = await tx.insert(userGroups).values({ name }).onConflictDoNothing().returning();
      if (!group) throw new AppError('conflict', '用户组名称已存在');
      await this.audit(tx, actor.id, 'group.create', group.id, { name });
      return { id: group.id, name: group.name };
    });
  }

  async rename(principal: Principal, groupId: string, name: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const group = await this.lockGroup(tx, groupId);
      if (group.name === name) return { id: groupId, name };
      const [duplicate] = await tx.select({ id: userGroups.id }).from(userGroups).where(eq(userGroups.name, name));
      if (duplicate) throw new AppError('conflict', '用户组名称已存在');
      await tx.update(userGroups).set({ name }).where(eq(userGroups.id, groupId));
      await this.audit(tx, actor.id, 'group.rename', groupId, { previousName: group.name, name });
      return { id: groupId, name };
    });
  }

  /** 删除组只移除标签，成员已有的渠道授权保持不变。 */
  async delete(principal: Principal, groupId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const group = await this.lockGroup(tx, groupId);
      const members = await tx
        .delete(userGroupMembers)
        .where(eq(userGroupMembers.groupId, groupId))
        .returning({ userId: userGroupMembers.userId });
      await tx.delete(userGroups).where(eq(userGroups.id, groupId));
      await this.audit(tx, actor.id, 'group.delete', groupId, {
        name: group.name,
        userIds: members.map((member) => member.userId),
      });
      return { success: true };
    });
  }

  /** 普通用户及其是否属于该组；membersOnly 时只列出成员。 */
  async members(groupId: string, page: number, search: string, membersOnly: boolean) {
    await this.get(groupId);
    const member = sql<boolean>`${userGroupMembers.userId} is not null`;
    const rows = await paginate(
      this.db
        .select({ id: users.id, username: users.username, status: users.status, member })
        .from(users)
        .leftJoin(userGroupMembers, and(eq(userGroupMembers.userId, users.id), eq(userGroupMembers.groupId, groupId)))
        .where(and(eligibleUser(), containsText(users.username, search), membersOnly ? member : undefined))
        .orderBy(asc(users.username), asc(users.id))
        .$dynamic(),
      page,
    );
    return toPage(rows);
  }

  /** 组内所有成员都拥有的非公开渠道授权；没有成员时为空。 */
  async sharedChannels(groupId: string) {
    await this.get(groupId);
    const memberIds = await this.db
      .select({ userId: userGroupMembers.userId })
      .from(userGroupMembers)
      .where(eq(userGroupMembers.groupId, groupId));
    return this.commonChannels(
      this.db,
      memberIds.map((row) => row.userId),
    );
  }

  /** 修改成员；sync 时为新成员授予组内原有成员共有的渠道。 */
  async setMembers(
    principal: Principal,
    groupId: string,
    changes: { userId: string; member: boolean }[],
    sync: boolean,
  ) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      await this.lockGroup(tx, groupId);
      await this.lockUsers(
        tx,
        changes.map((change) => change.userId),
      );
      const existing = new Set(
        (
          await tx
            .select({ userId: userGroupMembers.userId })
            .from(userGroupMembers)
            .where(eq(userGroupMembers.groupId, groupId))
        ).map((row) => row.userId),
      );
      const added = changes.filter((c) => c.member && !existing.has(c.userId)).map((c) => c.userId);
      const removed = changes.filter((c) => !c.member && existing.has(c.userId)).map((c) => c.userId);
      const shared = sync && added.length ? await this.commonChannels(tx, [...existing], true) : [];
      if (removed.length)
        await tx
          .delete(userGroupMembers)
          .where(and(eq(userGroupMembers.groupId, groupId), inArray(userGroupMembers.userId, removed)));
      if (added.length) await tx.insert(userGroupMembers).values(added.map((userId) => ({ groupId, userId })));
      await this.grant(
        tx,
        added,
        shared.map((channel) => channel.id),
      );
      await this.audit(tx, actor.id, 'group.members', groupId, {
        added,
        removed,
        syncedChannelIds: shared.map((channel) => channel.id),
      });
      return { added: added.length, removed: removed.length, syncedChannels: shared.length };
    });
  }

  async userGroups(userId: string) {
    return this.db
      .select({ id: userGroups.id, name: userGroups.name })
      .from(userGroupMembers)
      .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.groupId))
      .where(eq(userGroupMembers.userId, userId))
      .orderBy(asc(userGroups.name), asc(userGroups.id));
  }

  /** 设置用户所属的组；sync 时为新加入的每个组授予该组原有成员共有的渠道。 */
  async setUserGroups(principal: Principal, userId: string, groupIds: string[], sync: boolean) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const ids = [...new Set(groupIds)].sort();
      if (ids.length) {
        const locked = await tx
          .select({ id: userGroups.id })
          .from(userGroups)
          .where(inArray(userGroups.id, ids))
          .orderBy(asc(userGroups.id))
          .for('update');
        if (locked.length !== ids.length) throw new AppError('bad_request', '用户组不存在');
      }
      await this.lockUsers(tx, [userId]);
      const current = (
        await tx
          .select({ groupId: userGroupMembers.groupId })
          .from(userGroupMembers)
          .where(eq(userGroupMembers.userId, userId))
      ).map((row) => row.groupId);
      const joined = ids.filter((id) => !current.includes(id));
      const left = current.filter((id) => !ids.includes(id));
      const synced = new Set<string>();
      if (sync)
        for (const groupId of joined) {
          const memberIds = await tx
            .select({ userId: userGroupMembers.userId })
            .from(userGroupMembers)
            .where(eq(userGroupMembers.groupId, groupId));
          for (const channel of await this.commonChannels(
            tx,
            memberIds.map((row) => row.userId),
            true,
          ))
            synced.add(channel.id);
        }
      if (left.length)
        await tx
          .delete(userGroupMembers)
          .where(and(eq(userGroupMembers.userId, userId), inArray(userGroupMembers.groupId, left)));
      if (joined.length) await tx.insert(userGroupMembers).values(joined.map((groupId) => ({ groupId, userId })));
      await this.grant(tx, [userId], [...synced]);
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'user.groups',
        targetType: 'user',
        targetId: userId,
        metadata: { joined, left, syncedChannelIds: [...synced] },
      });
      return { joined: joined.length, left: left.length, syncedChannels: synced.size };
    });
  }

  /** 该组成员对每个非公开渠道的授权人数。 */
  async channels(groupId: string) {
    const group = await this.get(groupId);
    const rows = await this.db
      .select({
        id: channels.id,
        name: channels.name,
        enabled: channels.enabled,
        granted: sql<number>`count(${userGroupMembers.userId})::int`,
      })
      .from(channels)
      .leftJoin(userChannelGrants, eq(userChannelGrants.channelId, channels.id))
      .leftJoin(
        userGroupMembers,
        and(eq(userGroupMembers.userId, userChannelGrants.userId), eq(userGroupMembers.groupId, groupId)),
      )
      .where(privateChannel())
      .groupBy(channels.id)
      .orderBy(asc(channels.name), asc(channels.id));
    return { memberCount: group.memberCount, items: rows };
  }

  /** 每个组的成员中已获得该渠道授权的人数。 */
  async channelGroups(channelId: string) {
    await this.privateChannel(this.db, channelId);
    return this.db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        memberCount: count(userGroupMembers.userId),
        granted: count(userChannelGrants.userId),
      })
      .from(userGroups)
      .leftJoin(userGroupMembers, eq(userGroupMembers.groupId, userGroups.id))
      .leftJoin(
        userChannelGrants,
        and(eq(userChannelGrants.userId, userGroupMembers.userId), eq(userChannelGrants.channelId, channelId)),
      )
      .groupBy(userGroups.id)
      .orderBy(asc(userGroups.name), asc(userGroups.id));
  }

  /**
   * 为组的当前成员授予或撤销渠道。撤销会删除成员对这些渠道的全部授权，
   * 包括单独授予或经其他组授予的授权。
   */
  async setChannelAccess(principal: Principal, groupId: string, channelIds: string[], granted: boolean) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      await this.lockGroup(tx, groupId);
      const memberIds = (
        await tx
          .select({ userId: userGroupMembers.userId })
          .from(userGroupMembers)
          .where(eq(userGroupMembers.groupId, groupId))
      ).map((row) => row.userId);
      const userIds = await this.lockUsers(tx, memberIds, false);
      const ids = [...new Set(channelIds)].sort();
      const locked = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(inArray(channels.id, ids), privateChannel()))
        .orderBy(asc(channels.id))
        .for('share');
      if (locked.length !== ids.length) throw new AppError('bad_request', '渠道不存在或已公开');
      let affected: string[] = [];
      if (granted) affected = await this.grant(tx, userIds, ids);
      else if (userIds.length)
        affected = (
          await tx
            .delete(userChannelGrants)
            .where(and(inArray(userChannelGrants.userId, userIds), inArray(userChannelGrants.channelId, ids)))
            .returning({ userId: userChannelGrants.userId })
        ).map((row) => row.userId);
      const affectedUsers = [...new Set(affected)];
      await this.audit(tx, actor.id, 'group.channels', groupId, { channelIds: ids, granted, userIds: affectedUsers });
      return { affectedUsers: affectedUsers.length };
    });
  }

  private async lockGroup(tx: Transaction, groupId: string) {
    const [group] = await tx.select().from(userGroups).where(eq(userGroups.id, groupId)).for('update');
    if (!group) throw new AppError('not_found', '用户组不存在');
    return group;
  }

  /** 按标识顺序锁定未删除的普通用户；strict 时要求全部有效，否则返回仍然有效的用户。 */
  private async lockUsers(tx: Transaction, userIds: string[], strict = true) {
    const ids = [...new Set(userIds)].sort();
    if (!ids.length) return [];
    const locked = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, ids), eligibleUser()))
      .orderBy(asc(users.id))
      .for('update');
    if (strict && locked.length !== ids.length) throw new AppError('bad_request', '仅未删除的普通用户可以加入用户组');
    return locked.map((row) => row.id);
  }

  private async privateChannel(db: Database | Transaction, channelId: string) {
    const [channel] = await db
      .select({ isPublic: channels.isPublic })
      .from(channels)
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    if (!channel) throw new AppError('not_found', '渠道不存在或已删除');
    if (channel.isPublic) throw new AppError('bad_request', '公开渠道默认对所有用户开放');
  }

  /** 给定用户都拥有的非公开渠道授权；lock 时以共享锁锁定这些渠道。 */
  private async commonChannels(db: Database | Transaction, userIds: string[], lock = false) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return [];
    const query = db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(
        and(
          privateChannel(),
          sql`(${db
            .select({ total: count() })
            .from(userChannelGrants)
            .where(
              and(eq(userChannelGrants.channelId, channels.id), inArray(userChannelGrants.userId, ids)),
            )}) = ${ids.length}`,
        ),
      )
      .orderBy(asc(channels.name), asc(channels.id));
    return lock ? query.for('share') : query;
  }

  /** 插入缺失的授权，返回新获得授权的用户。 */
  private async grant(tx: Transaction, userIds: string[], channelIds: string[]) {
    if (!userIds.length || !channelIds.length) return [];
    const rows = await tx
      .insert(userChannelGrants)
      .values(userIds.flatMap((userId) => channelIds.map((channelId) => ({ userId, channelId }))))
      .onConflictDoNothing()
      .returning({ userId: userChannelGrants.userId });
    return rows.map((row) => row.userId);
  }

  private audit(
    tx: Transaction,
    actorId: string,
    action: `group.${'create' | 'rename' | 'delete' | 'members' | 'channels'}`,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    return recordAudit(tx, { actorId, action, targetType: 'user_group', targetId, metadata });
  }
}
