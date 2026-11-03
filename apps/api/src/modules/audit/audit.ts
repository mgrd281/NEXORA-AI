import type { Trx, Db } from '../../db/pool';
import { redact } from '../../lib/redact';

export interface AuditInput {
  tenantId: string | null;
  actorType: 'user' | 'system' | 'agent' | 'admin';
  actorId: string | null;
  /** dotted verb, e.g. auth.login, task.created, approval.approved, connection.deleted */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Never put message content, email bodies or secrets here. */
  metadata?: Record<string, unknown>;
}

/** Appends to the immutable audit log (the app role has INSERT-only access). */
export async function audit(trx: Trx | Db, e: AuditInput): Promise<void> {
  await trx
    .insertInto('audit_events')
    .values({
      tenant_id: e.tenantId,
      actor_type: e.actorType,
      actor_id: e.actorId,
      action: e.action,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      metadata: JSON.stringify(redact(e.metadata ?? {})),
    })
    .execute();
}
