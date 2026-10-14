import type { Transaction } from '../database/client.js';
import { adminAuditLogs } from '../database/schema/index.js';

/** 需要留痕的管理操作。审计记录只追加、不可修改。 */
export type AuditAction =
  | 'system.bootstrap'
  | `user.${'create' | 'set_role' | 'enable' | 'disable' | 'revoke_sessions' | 'reset_password' | 'delete' | 'channels'}`
  | 'wallet.adjust'
  | 'key.delete'
  | 'price.save'
  | `billing.${'resolve' | 'correct'}`
  | `channel.${'save' | 'delete' | 'users'}`
  | `model.${'save' | 'delete' | 'import' | 'placeholder'}`
  | 'subscription.cycle_reset';

export type AuditTargetType = 'user' | 'api_key' | 'model' | 'catalog' | 'request' | 'subscription_account';

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
  await tx.insert(adminAuditLogs).values(entry);
}
