import { sql } from 'kysely';
import type { StreamEvent, TaskEventType } from '@jarvis/contracts';
import type { Db, DbContext, Trx } from '../../db/pool';

/** Postgres channel carrying {u: userId, id?: eventId, e?: ephemeralEvent}. */
export const EVENTS_CHANNEL = 'jarvis_events';

export type StreamEventType = StreamEvent['type'];

/**
 * Event data shapes (the timeline UI and SSE consumers rely on these):
 *   task.created          { status }
 *   task.status_changed   { from, to }
 *   plan.ready            { stepCount, planner: { mode, provider, model } }
 *   step.started          { stepId, toolId, title, titleMessage?, attempt }
 *   step.succeeded        { stepId, toolId, title, titleMessage? }
 *   step.failed           { stepId, toolId, title, titleMessage?, code, message, reason?, params? }
 *   step.blocked          { stepId, toolId, title, titleMessage?, reasons }
 *   approval.requested    { approvalId, stepId, summary, summaryMessage? }
 *   approval.decided      { approvalId, decision: 'approved'|'rejected'|'expired' }
 *   verification.passed   { checks: VerificationCheck[] }
 *   verification.failed   { checks: VerificationCheck[], message, stepIds }
 * `titleMessage` / `summaryMessage` are contracts ServerMessage values (render
 * in the viewer's locale); `message` and check `text` are English fallbacks.
 * Events stored before this change carry `checks` as plain strings.
 *   task.cancel_requested {}
 *   task.retried          { attempt }
 *   notification.created  { notificationId, kind }
 *   connection.changed    { connectionId, provider, status }
 *   task.answer.delta     { text }            (ephemeral — not persisted)
 */
export async function appendEvent(
  trx: Trx,
  ctx: DbContext,
  e: {
    taskId: string | null;
    type: Exclude<StreamEventType, 'heartbeat' | 'task.answer.delta'>;
    data?: Record<string, unknown>;
  },
): Promise<number> {
  const row = await trx
    .insertInto('task_events')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      task_id: e.taskId,
      type: e.type,
      data: JSON.stringify(e.data ?? {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // NOTIFY is transactional: delivered only if this transaction commits.
  await sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ u: ctx.userId, id: row.id })})`.execute(
    trx,
  );
  return row.id;
}

/** Fire-and-forget event that is not stored (e.g. streaming answer tokens). Payload must stay < 7 KB. */
export async function publishEphemeral(
  db: Db,
  ctx: DbContext,
  e: {
    taskId: string;
    type: Extract<TaskEventType, 'task.answer.delta'>;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const event = {
    id: `eph-${Date.now()}`,
    type: e.type,
    taskId: e.taskId,
    at: new Date().toISOString(),
    data: e.data,
  };
  await sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ u: ctx.userId, e: event })})`.execute(
    db,
  );
}
