import { z } from 'zod';

import { pageInput, searchInput } from '../../core/pagination.ts';
import { userIdInput } from '../users/schemas.ts';

export const groupIdInput = z.object({ groupId: z.uuid('用户组标识无效') });
export const groupNameInput = z.string().trim().min(1, '请填写名称').max(64, '名称最多 64 个字符');
export const createGroupInput = z.object({ name: groupNameInput });
export const renameGroupInput = groupIdInput.extend({ name: groupNameInput });
export const groupMembersInput = groupIdInput.extend({
  page: pageInput,
  search: searchInput,
  membersOnly: z.boolean().default(false),
});
export const setGroupMembersInput = groupIdInput.extend({
  changes: z
    .array(z.object({ userId: z.uuid(), member: z.boolean() }))
    .min(1, '请选择要修改的用户')
    .max(1000, '每次最多修改 1000 个用户')
    .refine((changes) => new Set(changes.map((change) => change.userId)).size === changes.length, '用户不能重复'),
  sync: z.boolean().default(false),
});
export const setUserGroupsInput = userIdInput.extend({
  groupIds: z.array(z.uuid()).max(100),
  sync: z.boolean().default(false),
});
export const channelGroupsInput = z.object({ channelId: z.uuid() });
export const setGroupChannelAccessInput = groupIdInput.extend({
  channelIds: z.array(z.uuid()).min(1, '请选择渠道').max(100),
  granted: z.boolean(),
});
export const setGroupChannelBlocksInput = groupIdInput.extend({
  channelIds: z.array(z.uuid()).min(1, '请选择渠道').max(100),
  blocked: z.boolean(),
});
