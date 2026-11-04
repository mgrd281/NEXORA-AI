/**
 * The runtime's webhook emission points (docs/architecture/phase-b.md §3.8):
 * builds the metadata-only payload data (ids, enums, timestamps — never
 * titles, requests, answers, email content, memory or file names) and calls
 * emitWebhookEvent inside the transaction of the state change, so a delivery
 * exists exactly when the change committed. The occurrence key makes a
 * repeated emission (a retried job) a no-op per endpoint.
 *
 *   task.created                         intake, follow-up, scheduled run
 *   task.completed/failed/cancelled/expired   transitionTask (terminal)
 *   approval.requested                   requestApproval
 *   approval.decided                     decide (approve/reject), expiry
 *   schedule.triggered / schedule.failed schedule.run job, run results
 */
import {
  ErrorCode,
  ToolId,
  type ScheduleRunReason,
  type WebhookEventType,
} from '@jarvis/contracts';
import type { DbContext, Trx } from '../../db/pool';
import type { ApprovalRow, ScheduleRow, TaskRow } from '../../db/types';
import { emitWebhookEvent } from '../webhooks/emit';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

type TaskEvent = Extract<
  WebhookEventType,
  'task.created' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.expired'
>;

/** task.* event for the task's current row (its attempt keys the occurrence). */
export async function emitTaskWebhook(
  trx: Trx,
  ctx: DbContext,
  type: TaskEvent,
  task: TaskRow,
): Promise<number> {
  const steps = await trx
    .selectFrom('task_steps')
    .select('tool_id')
    .where('task_id', '=', task.id)
    .orderBy('position')
    .execute();
  const toolIds = [...new Set(steps.map((s) => s.tool_id))].filter(
    (id): id is ToolId => ToolId.safeParse(id).success,
  );
  const e = task.error as { code?: unknown; reason?: unknown; retryable?: unknown } | null;
  const code = ErrorCode.safeParse(e?.code);
  return emitWebhookEvent(trx, ctx, {
    type,
    occurrenceKey: `${task.id}:${task.attempt}`,
    data: {
      taskId: task.id,
      conversationId: task.conversation_id,
      scheduleId: task.schedule_id,
      status: task.status,
      outcome: task.outcome,
      riskLevel: task.risk_level,
      source: task.source,
      toolIds,
      error:
        e && code.success
          ? {
              code: code.data,
              reason: typeof e.reason === 'string' ? e.reason : null,
              retryable: !!e.retryable,
            }
          : null,
      createdAt: task.created_at.toISOString(),
      completedAt: iso(task.completed_at),
    },
  });
}

const TERMINAL_EVENT: Partial<Record<TaskRow['status'], TaskEvent>> = {
  COMPLETED: 'task.completed',
  FAILED: 'task.failed',
  CANCELLED: 'task.cancelled',
  EXPIRED: 'task.expired',
};

export function terminalWebhookType(status: TaskRow['status']): TaskEvent | null {
  return TERMINAL_EVENT[status] ?? null;
}

/** approval.requested / approval.decided for the approval's current row. */
export async function emitApprovalWebhook(
  trx: Trx,
  ctx: DbContext,
  type: 'approval.requested' | 'approval.decided',
  approval: Pick<
    ApprovalRow,
    'id' | 'task_id' | 'step_id' | 'tool_id' | 'risk_level' | 'status' | 'expires_at' | 'decided_at'
  >,
): Promise<number> {
  const toolId = ToolId.safeParse(approval.tool_id);
  if (!toolId.success) return 0;
  return emitWebhookEvent(trx, ctx, {
    type,
    occurrenceKey: approval.id,
    data: {
      approvalId: approval.id,
      taskId: approval.task_id,
      stepId: approval.step_id,
      toolId: toolId.data,
      riskLevel: approval.risk_level,
      status: approval.status,
      expiresAt: new Date(approval.expires_at).toISOString(),
      decidedAt: iso(approval.decided_at),
    },
  });
}

/** schedule.triggered / schedule.failed for one occurrence. */
export async function emitScheduleWebhook(
  trx: Trx,
  ctx: DbContext,
  type: 'schedule.triggered' | 'schedule.failed',
  schedule: Pick<ScheduleRow, 'id' | 'status' | 'consecutive_failures'>,
  run: { occurrenceAt: Date; taskId: string | null; reason: ScheduleRunReason | null },
): Promise<number> {
  return emitWebhookEvent(trx, ctx, {
    type,
    occurrenceKey: `${schedule.id}:${run.occurrenceAt.toISOString()}`,
    data: {
      scheduleId: schedule.id,
      occurrenceAt: run.occurrenceAt.toISOString(),
      taskId: run.taskId,
      status: schedule.status,
      consecutiveFailures: schedule.consecutive_failures,
      reason: run.reason,
    },
  });
}
