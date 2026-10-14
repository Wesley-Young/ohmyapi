import { serviceToken } from '@fraqjs/kernel';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import { toPage } from '../../core/pagination.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { Database } from '../database/client.js';
import { containsText, paginate } from '../database/query.js';
import { channels, userChannelGrants, users } from '../database/schema/index.js';
import { auditCatalog } from './audit.js';

/** 非公开渠道的用户授权：可按用户或按渠道维护。 */
export class ChannelGrants {
  static readonly token = serviceToken<ChannelGrants>('ohmyapi/channel-grants');
  private readonly db: Database;
  private readonly auth: AuthService;
  constructor(deps: { db: Database; auth: AuthService }) {
    this.db = deps.db;
    this.auth = deps.auth;
  }

  async grants(userId: string) {
    return this.db
      .select({ channelId: userChannelGrants.channelId })
      .from(userChannelGrants)
      .innerJoin(channels, eq(channels.id, userChannelGrants.channelId))
      .where(and(eq(userChannelGrants.userId, userId), isNull(channels.deletedAt), eq(channels.isPublic, false)));
  }

  async channelGrants(channelId: string, page: number, search: string) {
    const [channel] = await this.db
      .select({ isPublic: channels.isPublic })
      .from(channels)
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    if (!channel) throw new AppError('not_found', '渠道不存在或已删除');
    if (channel.isPublic) throw new AppError('bad_request', '公开渠道默认对所有用户开放');
    const rows = await paginate(
      this.db
        .select({
          id: users.id,
          username: users.username,
          status: users.status,
          granted: sql<boolean>`${userChannelGrants.userId} is not null`,
        })
        .from(users)
        .leftJoin(
          userChannelGrants,
          and(eq(userChannelGrants.userId, users.id), eq(userChannelGrants.channelId, channelId)),
        )
        .where(and(eq(users.role, 'user'), isNull(users.deletedAt), containsText(users.username, search)))
        .orderBy(asc(users.username), asc(users.id))
        .$dynamic(),
      page,
    );
    return toPage(rows);
  }

  async setChannelGrants(principal: Principal, channelId: string, grants: { userId: string; granted: boolean }[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const userIds = grants.map((grant) => grant.userId).sort();
      const validUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, userIds), eq(users.role, 'user'), isNull(users.deletedAt)))
        .orderBy(asc(users.id))
        .for('update');
      if (validUsers.length !== userIds.length) throw new AppError('bad_request', '仅为未删除的普通用户设置渠道授权');
      const [channel] = await tx
        .select({ isPublic: channels.isPublic })
        .from(channels)
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .for('share');
      if (!channel) throw new AppError('not_found', '渠道不存在或已删除');
      if (channel.isPublic) throw new AppError('bad_request', '公开渠道默认对所有用户开放');
      const revokedIds = grants.filter((grant) => !grant.granted).map((grant) => grant.userId);
      if (revokedIds.length)
        await tx
          .delete(userChannelGrants)
          .where(and(eq(userChannelGrants.channelId, channelId), inArray(userChannelGrants.userId, revokedIds)));
      const grantedUsers = grants.filter((grant) => grant.granted);
      if (grantedUsers.length)
        await tx
          .insert(userChannelGrants)
          .values(grantedUsers.map(({ userId }) => ({ userId, channelId })))
          .onConflictDoNothing();
      await auditCatalog(tx, actor.id, 'channel.users', channelId, { grants });
      return { success: true };
    });
  }

  async setGrants(principal: Principal, userId: string, channelIds: string[]) {
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user?.role !== 'user' || user.deletedAt)
        throw new AppError('bad_request', '仅为未删除的普通用户设置渠道授权');
      const ids = [...new Set(channelIds)];
      if (
        ids.length &&
        (
          await tx
            .select({ id: channels.id })
            .from(channels)
            .where(and(inArray(channels.id, ids), isNull(channels.deletedAt), eq(channels.isPublic, false)))
            .for('share')
        ).length !== ids.length
      )
        throw new AppError('bad_request', '渠道不存在或已公开');
      await tx.delete(userChannelGrants).where(eq(userChannelGrants.userId, userId));
      if (ids.length) await tx.insert(userChannelGrants).values(ids.map((channelId) => ({ userId, channelId })));
      await auditCatalog(tx, actor.id, 'user.channels', userId, { channelIds: ids });
      return { success: true };
    });
  }
}
