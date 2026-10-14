import { adminProcedure } from '../../trpc/procedures.ts';
import { userIdInput } from '../users/schemas.ts';
import {
  channelGroupsInput,
  createGroupInput,
  groupIdInput,
  groupMembersInput,
  renameGroupInput,
  setGroupChannelAccessInput,
  setGroupMembersInput,
  setUserGroupsInput,
} from './schemas.ts';
import type { GroupService } from './service.ts';

export function groupAdminRoutes(groups: GroupService) {
  return {
    list: adminProcedure.query(() => groups.list()),
    get: adminProcedure.input(groupIdInput).query(({ input }) => groups.get(input.groupId)),
    create: adminProcedure
      .input(createGroupInput)
      .mutation(({ ctx, input }) => groups.create(ctx.principal, input.name)),
    rename: adminProcedure
      .input(renameGroupInput)
      .mutation(({ ctx, input }) => groups.rename(ctx.principal, input.groupId, input.name)),
    delete: adminProcedure
      .input(groupIdInput)
      .mutation(({ ctx, input }) => groups.delete(ctx.principal, input.groupId)),
    members: adminProcedure
      .input(groupMembersInput)
      .query(({ input }) => groups.members(input.groupId, input.page, input.search, input.membersOnly)),
    sharedChannels: adminProcedure.input(groupIdInput).query(({ input }) => groups.sharedChannels(input.groupId)),
    setMembers: adminProcedure
      .input(setGroupMembersInput)
      .mutation(({ ctx, input }) => groups.setMembers(ctx.principal, input.groupId, input.changes, input.sync)),
    userGroups: adminProcedure.input(userIdInput).query(({ input }) => groups.userGroups(input.userId)),
    setUserGroups: adminProcedure
      .input(setUserGroupsInput)
      .mutation(({ ctx, input }) => groups.setUserGroups(ctx.principal, input.userId, input.groupIds, input.sync)),
    channels: adminProcedure.input(groupIdInput).query(({ input }) => groups.channels(input.groupId)),
    channelGroups: adminProcedure.input(channelGroupsInput).query(({ input }) => groups.channelGroups(input.channelId)),
    setChannelAccess: adminProcedure
      .input(setGroupChannelAccessInput)
      .mutation(({ ctx, input }) =>
        groups.setChannelAccess(ctx.principal, input.groupId, input.channelIds, input.granted),
      ),
  };
}
