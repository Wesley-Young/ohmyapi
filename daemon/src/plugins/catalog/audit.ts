import { type AuditAction, recordAudit } from '../auth/audit.ts';
import type { Transaction } from '../database/client.ts';

export function auditCatalog(
  tx: Transaction,
  actorId: string,
  action: AuditAction,
  targetId: string,
  metadata: Record<string, unknown>,
) {
  return recordAudit(tx, { actorId, action, targetType: 'catalog', targetId, metadata });
}
