import type { Transaction } from '../database/client.ts';
import { adminAuditLogs } from '../database/schema/index.ts';

/** 需要留痕的管理操作。审计记录只追加、不可修改。 */
export type AuditAction =
  | 'system.bootstrap'
  | `user.${'create' | 'set_role' | 'enable' | 'disable' | 'revoke_sessions' | 'reset_password' | 'delete' | 'channels' | 'channel_blocks' | 'groups'}`
  | `group.${'create' | 'rename' | 'delete' | 'members' | 'channels' | 'channel_blocks'}`
  | 'wallet.adjust'
  | 'key.delete'
  | `admin_token.${'create' | 'revoke'}`
  | 'price.save'
  | `billing.${'resolve' | 'correct'}`
  | `channel.${'save' | 'delete' | 'users'}`
  | `model.${'save' | 'delete' | 'import' | 'placeholder'}`
  | 'subscription.cycle_reset';

export type AuditTargetType =
  | 'user'
  | 'api_key'
  | 'admin_token'
  | 'model'
  | 'catalog'
  | 'request'
  | 'subscription_account'
  | 'user_group';

/** 事务中操作的来源，记录在该事务所有审计条目的 metadata 中。 */
type AuditAttribution = { adminTokenId: string };
const attributions = new WeakMap<Transaction, AuditAttribution>();

export function attributeAudit(tx: Transaction, attribution: AuditAttribution) {
  attributions.set(tx, attribution);
}

export async function recordAudit(
  tx: Transaction,
  entry: {
    actorId: string;
    action: AuditAction;
    targetType: AuditTargetType;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
) {
  const attribution = attributions.get(tx);
  await tx
    .insert(adminAuditLogs)
    .values(attribution ? { ...entry, metadata: { ...entry.metadata, ...attribution } } : entry);
}
