/**
 * Approval lifecycle pieces shared by the executor (request), the
 * approval.expire job and the approval service (expire on decide).
 */
import type { ApprovalDetails, Locale, RiskLevel, ServerMessage, ToolId } from '@jarvis/contracts';
import type { Config } from '../../config';
import type { DbContext, Trx } from '../../db/pool';
import type { ApprovalRow, StepRow, TaskRow } from '../../db/types';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { enqueue } from '../jobs/queue';
import { createNotification } from '../notifications/create';
import { msg, render } from './i18n';
import { cancelOpenSteps, lockTask, taskErrorJson, transitionTask } from './task-state';

export async function requestApproval(
  trx: Trx,
  ctx: DbContext,
  config: Config,
  r: {
    task: TaskRow;
    step: StepRow;
    toolId: ToolId;
    risk: RiskLevel;
    summary: string;
    /** `summary` as a message key + params (null when the tool has no sentence for it). */
    summaryMessage: ServerMessage | null;
    details: ApprovalDetails;
    actionHash: string;
    reasons: string[];
  },
): Promise<string> {
  const expiresAt = new Date(Date.now() + config.APPROVAL_TTL_HOURS * 3_600_000);
  const approval = await trx
    .insertInto('approvals')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      task_id: r.task.id,
      step_id: r.step.id,
      tool_id: r.toolId,
      risk_level: r.risk,
      summary: r.summary,
      summary_message: r.summaryMessage ? JSON.stringify(r.summaryMessage) : null,
      details: JSON.stringify(r.details),
      action_hash: r.actionHash,
      reasons: r.reasons,
      expires_at: expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('task_steps')
    .set({ status: 'AWAITING_APPROVAL' })
    .where('id', '=', r.step.id)
    .execute();
  await transitionTask(trx, ctx, r.task, 'AWAITING_APPROVAL');
  await appendEvent(trx, ctx, {
    taskId: r.task.id,
    type: 'approval.requested',
    data: {
      approvalId: approval.id,
      stepId: r.step.id,
      summary: r.summary,
      ...(r.summaryMessage ? { summaryMessage: r.summaryMessage } : {}),
    },
  });
  await createNotification(trx, ctx, 'approval_requested', r.task.id, {
    taskTitle: r.task.title,
    approvalId: approval.id,
  });
  await enqueue(trx, {
    kind: 'approval.expire',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    taskId: r.task.id,
    payload: { approvalId: approval.id },
    dedupeKey: `expire:${approval.id}`,
    runAt: expiresAt,
    maxAttempts: 10,
  });
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'agent',
    actorId: ctx.userId,
    action: 'approval.requested',
    targetType: 'approval',
    targetId: approval.id,
    metadata: { taskId: r.task.id, toolId: r.toolId, riskLevel: r.risk, reasons: r.reasons },
  });
  return approval.id;
}

/**
 * Marks a PENDING approval EXPIRED and expires its task (if it is still
 * waiting on it). Locks the task before touching the approval: the one lock
 * order for a task and its approvals (callers should already hold it).
 */
export async function expireApproval(
  trx: Trx,
  ctx: DbContext,
  approval: ApprovalRow,
  actor: 'system' | 'user',
): Promise<void> {
  const task = await lockTask(trx, approval.task_id);
  await trx
    .updateTable('approvals')
    .set({ status: 'EXPIRED', decided_at: new Date() })
    .where('id', '=', approval.id)
    .where('status', '=', 'PENDING')
    .execute();
  await appendEvent(trx, ctx, {
    taskId: approval.task_id,
    type: 'approval.decided',
    data: { approvalId: approval.id, decision: 'expired' },
  });
  if (task.status === 'AWAITING_APPROVAL') {
    const language = (task.language ?? 'en') as Locale;
    await cancelOpenSteps(trx, task.id);
    const result = msg('result.expired');
    const expired = await transitionTask(trx, ctx, task, 'EXPIRED', {
      error: taskErrorJson({
        code: 'APPROVAL_EXPIRED',
        message: 'The approval request expired before a decision was made.',
        retryable: true,
      }),
      result_summary: render(language, result),
      result_summary_message: JSON.stringify(result),
    });
    await createNotification(trx, ctx, 'task_failed', task.id, {
      taskTitle: expired.title,
      errorCode: 'APPROVAL_EXPIRED',
    });
  }
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: actor === 'system' ? 'system' : 'user',
    actorId: actor === 'system' ? null : ctx.userId,
    action: 'approval.expired',
    targetType: 'approval',
    targetId: approval.id,
    metadata: { taskId: approval.task_id, toolId: approval.tool_id },
  });
}
