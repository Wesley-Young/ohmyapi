import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 管理令牌的权限范围，与后端定义保持一致。 */
export type AdminScope = RouterOutputs['admin']['tokens']['list'][number]['scopes'][number];

/** 全部权限范围及文案，顺序即界面展示顺序。 */
export const adminScopeLabels = {
  'users:read': '查看用户',
  'users:write': '管理用户',
  'wallet:read': '查看余额',
  'wallet:write': '调整余额',
  'channels:read': '查看渠道',
} satisfies Record<AdminScope, string>;

export const adminScopes = Object.keys(adminScopeLabels) as AdminScope[];
