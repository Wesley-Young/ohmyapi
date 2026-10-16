import { serviceToken } from '@fraqjs/kernel';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import { toPage } from '../../core/pagination.ts';
import { recordAudit } from '../auth/audit.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Database, Transaction } from '../database/client.ts';
import { containsText, paginate } from '../database/query.ts';
import {
  channels,
  userChannelBlocks,
  userChannelGrants,
  userGroupMembers,
  userGroups,
  users,
} from '../database/schema/index.ts';

const eligibleUser = () => and(eq(users.role, 'user'), isNull(users.deletedAt));

/** 非公开渠道的授权（grant）和公开渠道的屏蔽（block）。 */
type AccessKind = 'grant' | 'block';
const accessTable = { grant: userChannelGrants, block: userChannelBlocks } as const;
const accessChannel = (kind: AccessKind) => and(eq(channels.isPublic, kind === 'block'), isNull(channels.deletedAt));
const privateChannel = () => accessChannel('grant');

/**
 * 用户组是普通用户的标签，不保存渠道授权或屏蔽。
 * 组级的授权、屏蔽及撤销在操作时展开写入成员的记录；成员加入或离开组不改变已有记录。
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

  /** 组内所有成员共有的非公开渠道授权和公开渠道屏蔽；没有成员时为空。 */
  async sharedChannels(groupId: string) {
    await this.get(groupId);
    const memberIds = (
      await this.db
        .select({ userId: userGroupMembers.userId })
        .from(userGroupMembers)
        .where(eq(userGroupMembers.groupId, groupId))
    ).map((row) => row.userId);
    const [granted, blocked] = await Promise.all([
      this.commonChannels(this.db, memberIds, 'grant'),
      this.commonChannels(this.db, memberIds, 'block'),
    ]);
    return [
      ...granted.map((channel) => ({ ...channel, blocked: false })),
      ...blocked.map((channel) => ({ ...channel, blocked: true })),
    ];
  }

  /** 修改成员；sync 时为新成员同步组内原有成员共有的渠道授权和屏蔽。 */
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
      const shared = { grant: [] as string[], block: [] as string[] };
      if (sync && added.length)
        for (const kind of ['grant', 'block'] as const)
          shared[kind] = (await this.commonChannels(tx, [...existing], kind, true)).map((channel) => channel.id);
      if (removed.length)
        await tx
          .delete(userGroupMembers)
          .where(and(eq(userGroupMembers.groupId, groupId), inArray(userGroupMembers.userId, removed)));
      if (added.length) await tx.insert(userGroupMembers).values(added.map((userId) => ({ groupId, userId })));
      await this.insertAccess(tx, 'grant', added, shared.grant);
      await this.insertAccess(tx, 'block', added, shared.block);
      await this.audit(tx, actor.id, 'group.members', groupId, {
        added,
        removed,
        syncedChannelIds: shared.grant,
        syncedBlockedChannelIds: shared.block,
      });
      return {
        added: added.length,
        removed: removed.length,
        syncedChannels: shared.grant.length + shared.block.length,
      };
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

  /** 设置用户所属的组；sync 时同步新加入的每个组中原有成员共有的渠道授权和屏蔽。 */
  async setUserGroups(principal: Principal, userId: string, groupIds: string[], sync: boolean) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const ids = await this.lockGroups(tx, groupIds);
      await this.lockUsers(tx, [userId]);
      const current = (
        await tx
          .select({ groupId: userGroupMembers.groupId })
          .from(userGroupMembers)
          .where(eq(userGroupMembers.userId, userId))
      ).map((row) => row.groupId);
      const joined = ids.filter((id) => !current.includes(id));
      const left = current.filter((id) => !ids.includes(id));
      if (left.length)
        await tx
          .delete(userGroupMembers)
          .where(and(eq(userGroupMembers.userId, userId), inArray(userGroupMembers.groupId, left)));
      const synced = await this.join(tx, userId, joined, sync);
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'user.groups',
        targetType: 'user',
        targetId: userId,
        metadata: { joined, left, syncedChannelIds: synced.grant, syncedBlockedChannelIds: synced.block },
      });
      return { joined: joined.length, left: left.length, syncedChannels: synced.grant.length + synced.block.length };
    });
  }

  /**
   * 在创建用户的事务中把新用户加入用户组；sync 时同步各组原有成员共有的渠道授权和屏蔽。
   * 新用户在事务提交前对其他事务不可见，无需再锁定。
   */
  async addNewUser(tx: Transaction, actorId: string, userId: string, groupIds: string[], sync: boolean) {
    const ids = await this.lockGroups(tx, groupIds);
    if (!ids.length) return { joined: 0, syncedChannels: 0 };
    const synced = await this.join(tx, userId, ids, sync);
    await recordAudit(tx, {
      actorId,
      action: 'user.groups',
      targetType: 'user',
      targetId: userId,
      metadata: { joined: ids, left: [], syncedChannelIds: synced.grant, syncedBlockedChannelIds: synced.block },
    });
    return { joined: ids.length, syncedChannels: synced.grant.length + synced.block.length };
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

  /** 该组成员对每个公开渠道的屏蔽人数。 */
  async channelBlocks(groupId: string) {
    const group = await this.get(groupId);
    const rows = await this.db
      .select({
        id: channels.id,
        name: channels.name,
        enabled: channels.enabled,
        blocked: sql<number>`count(${userGroupMembers.userId})::int`,
      })
      .from(channels)
      .leftJoin(userChannelBlocks, eq(userChannelBlocks.channelId, channels.id))
      .leftJoin(
        userGroupMembers,
        and(eq(userGroupMembers.userId, userChannelBlocks.userId), eq(userGroupMembers.groupId, groupId)),
      )
      .where(accessChannel('block'))
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
  setChannelAccess(principal: Principal, groupId: string, channelIds: string[], granted: boolean) {
    return this.applyAccess(principal, 'grant', groupId, channelIds, granted);
  }

  /** 为组的当前成员屏蔽或解除屏蔽公开渠道。解除会删除成员对这些渠道的全部屏蔽。 */
  setChannelBlocks(principal: Principal, groupId: string, channelIds: string[], blocked: boolean) {
    return this.applyAccess(principal, 'block', groupId, channelIds, blocked);
  }

  private async applyAccess(
    principal: Principal,
    kind: AccessKind,
    groupId: string,
    channelIds: string[],
    enabled: boolean,
  ) {
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
        .where(and(inArray(channels.id, ids), accessChannel(kind)))
        .orderBy(asc(channels.id))
        .for('share');
      if (locked.length !== ids.length)
        throw new AppError('bad_request', kind === 'grant' ? '渠道不存在或已公开' : '渠道不存在或未公开');
      const table = accessTable[kind];
      let affected: string[] = [];
      if (enabled) affected = await this.insertAccess(tx, kind, userIds, ids);
      else if (userIds.length)
        affected = (
          await tx
            .delete(table)
            .where(and(inArray(table.userId, userIds), inArray(table.channelId, ids)))
            .returning({ userId: table.userId })
        ).map((row) => row.userId);
      const affectedUsers = [...new Set(affected)];
      await this.audit(tx, actor.id, kind === 'grant' ? 'group.channels' : 'group.channel_blocks', groupId, {
        channelIds: ids,
        [kind === 'grant' ? 'granted' : 'blocked']: enabled,
        userIds: affectedUsers,
      });
      return { affectedUsers: affectedUsers.length };
    });
  }

  /** 按标识顺序锁定用户组，要求全部存在；返回去重排序后的标识。 */
  private async lockGroups(tx: Transaction, groupIds: string[]) {
    const ids = [...new Set(groupIds)].sort();
    if (!ids.length) return ids;
    const locked = await tx
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(inArray(userGroups.id, ids))
      .orderBy(asc(userGroups.id))
      .for('update');
    if (locked.length !== ids.length) throw new AppError('bad_request', '用户组不存在');
    return ids;
  }

  /**
   * 把用户加入尚未加入的组（调用方已锁定组和用户）。sync 时按加入前的成员，
   * 同步每个组原有成员共有的渠道授权和屏蔽，返回同步的渠道。
   */
  private async join(tx: Transaction, userId: string, groupIds: string[], sync: boolean) {
    const synced = { grant: new Set<string>(), block: new Set<string>() };
    if (sync)
      for (const groupId of groupIds) {
        const memberIds = (
          await tx
            .select({ userId: userGroupMembers.userId })
            .from(userGroupMembers)
            .where(eq(userGroupMembers.groupId, groupId))
        ).map((row) => row.userId);
        for (const kind of ['grant', 'block'] as const)
          for (const channel of await this.commonChannels(tx, memberIds, kind, true)) synced[kind].add(channel.id);
      }
    if (groupIds.length) await tx.insert(userGroupMembers).values(groupIds.map((groupId) => ({ groupId, userId })));
    const result = { grant: [...synced.grant], block: [...synced.block] };
    await this.insertAccess(tx, 'grant', [userId], result.grant);
    await this.insertAccess(tx, 'block', [userId], result.block);
    return result;
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

  /** 给定用户共有的非公开渠道授权或公开渠道屏蔽；lock 时以共享锁锁定这些渠道。 */
  private async commonChannels(db: Database | Transaction, userIds: string[], kind: AccessKind, lock = false) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return [];
    const table = accessTable[kind];
    const query = db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(
        and(
          accessChannel(kind),
          sql`(${db
            .select({ total: count() })
            .from(table)
            .where(and(eq(table.channelId, channels.id), inArray(table.userId, ids)))}) = ${ids.length}`,
        ),
      )
      .orderBy(asc(channels.name), asc(channels.id));
    return lock ? query.for('share') : query;
  }

  /** 插入缺失的授权或屏蔽，返回新增记录的用户。 */
  private async insertAccess(tx: Transaction, kind: AccessKind, userIds: string[], channelIds: string[]) {
    if (!userIds.length || !channelIds.length) return [];
    const table = accessTable[kind];
    const rows = await tx
      .insert(table)
      .values(userIds.flatMap((userId) => channelIds.map((channelId) => ({ userId, channelId }))))
      .onConflictDoNothing()
      .returning({ userId: table.userId });
    return rows.map((row) => row.userId);
  }

  private audit(
    tx: Transaction,
    actorId: string,
    action: `group.${'create' | 'rename' | 'delete' | 'members' | 'channels' | 'channel_blocks'}`,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    return recordAudit(tx, { actorId, action, targetType: 'user_group', targetId, metadata });
  }
}
