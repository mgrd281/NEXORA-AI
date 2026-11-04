/**
 * The only code that changes tasks.status. Every transition is checked
 * against the shared state machine (assertTransition), bumps the optimistic
 * version, and writes `task.status_changed` in the same transaction.
 *
 * Phase B: a transition to a terminal status is the one place that emits the
 * task.completed / failed / cancelled / expired webhook and records a
 * scheduled run's result (failures count towards pausing the schedule).
 */
import {
  assertTransition,
  InvalidTransitionError,
  isTerminal,
  type TaskError,
  type TaskStatus,
} from '@jarvis/contracts';
import { sql } from 'kysely';
import type { DbContext, Trx } from '../../db/pool';
import type { TaskRow, TaskUpdate } from '../../db/types';
import { AppError, notFound } from '../../lib/errors';
import { appendEvent } from '../events/events';
import { createNotification } from '../notifications/create';
import { recordScheduleRunResult } from '../schedules/service';
import type { ModelUsage } from './models/adapter';
import { emitScheduleWebhook, emitTaskWebhook, terminalWebhookType } from './webhook-events';

/** Locks the task row for this transaction; null when it is not visible (RLS) or gone. */
export async function tryLockTask(trx: Trx, taskId: string): Promise<TaskRow | null> {
  const task = await trx
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', taskId)
    .forUpdate()
    .executeTakeFirst();
  return task ?? null;
}

export async function lockTask(trx: Trx, taskId: string): Promise<TaskRow> {
  const task = await tryLockTask(trx, taskId);
  if (!task) throw notFound('Task');
  return task;
}

/**
 * Moves a task to `to`. `current` must be the row locked in this transaction
 * (lockTask); its version is used as the optimistic check.
 */
export async function transitionTask(
  trx: Trx,
  ctx: DbContext,
  current: TaskRow,
  to: TaskStatus,
  patch: TaskUpdate = {},
): Promise<TaskRow> {
  try {
    assertTransition(current.status, to);
  } catch (err) {
    if (err instanceof InvalidTransitionError)
      throw new AppError(
        'INVALID_STATE',
        `A ${current.status.toLowerCase()} task cannot become ${to.toLowerCase()}.`,
      );
    throw err;
  }
  const now = new Date();
  const updated = await trx
    .updateTable('tasks')
    .set({
      ...patch,
      status: to,
      version: current.version + 1,
      ...(to === 'PLANNING' && !current.started_at ? { started_at: now } : {}),
      ...(isTerminal(to) ? { completed_at: now } : {}),
    })
    .where('id', '=', current.id)
    .where('version', '=', current.version)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new AppError('CONFLICT', 'The task changed concurrently; try again.');
  await appendEvent(trx, ctx, {
    taskId: current.id,
    type: 'task.status_changed',
    data: { from: current.status, to },
  });
  const webhook = terminalWebhookType(to);
  if (webhook) {
    await emitTaskWebhook(trx, ctx, webhook, updated);
    if (updated.schedule_id) await recordRunResult(trx, ctx, updated);
  }
  return updated;
}

/**
 * A scheduled run's task reached a terminal status: COMPLETED resets the
 * schedule's failure count; FAILED / EXPIRED count as a failed run, and the
 * run that reaches SCHEDULE_LIMITS.failuresBeforePause pauses the schedule
 * (schedule_paused notification, schedule.failed webhook). A cancellation by
 * the user is neither.
 */
async function recordRunResult(trx: Trx, ctx: DbContext, task: TaskRow): Promise<void> {
  if (!task.schedule_id || task.status === 'CANCELLED') return;
  const result = task.status === 'COMPLETED' ? 'succeeded' : 'failed';
  const recorded = await recordScheduleRunResult(trx, ctx, task.schedule_id, result);
  if (!recorded?.paused) return;
  const schedule = recorded.schedule;
  await createNotification(trx, ctx, 'schedule_paused', task.id, {
    scheduleTitle: schedule.title,
    reason: 'failures',
  });
  const run = await trx
    .selectFrom('schedule_runs')
    .select('occurrence_at')
    .where('task_id', '=', task.id)
    .executeTakeFirst();
  await emitScheduleWebhook(trx, ctx, 'schedule.failed', schedule, {
    occurrenceAt: run ? new Date(run.occurrence_at) : (task.created_at as Date),
    taskId: task.id,
    reason: null,
  });
}

/**
 * The failure notification of a task: schedule_failed for a scheduled run
 * (it names the schedule), task_failed otherwise. One notification either way.
 */
export async function notifyTaskFailed(
  trx: Trx,
  ctx: DbContext,
  task: TaskRow,
  errorCode: string,
): Promise<void> {
  if (task.schedule_id) {
    const schedule = await trx
      .selectFrom('scheduled_tasks')
      .select('title')
      .where('id', '=', task.schedule_id)
      .executeTakeFirst();
    if (schedule) {
      await createNotification(trx, ctx, 'schedule_failed', task.id, {
        scheduleTitle: schedule.title,
        taskTitle: task.title,
        errorCode,
      });
      return;
    }
  }
  await createNotification(trx, ctx, 'task_failed', task.id, {
    taskTitle: task.title,
    errorCode,
  });
}

/** Writes non-status task fields (keeps the version bump so readers see the change). */
export async function patchTask(trx: Trx, task: TaskRow, patch: TaskUpdate): Promise<TaskRow> {
  return trx
    .updateTable('tasks')
    .set({ ...patch, version: sql`version + 1` as unknown as number })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export const taskErrorJson = (e: TaskError) => JSON.stringify(e);

/** Steps that never ran become CANCELLED when a task is cancelled, rejected or expires. */
export async function cancelOpenSteps(trx: Trx, taskId: string): Promise<void> {
  await trx
    .updateTable('task_steps')
    .set({ status: 'CANCELLED', completed_at: new Date() })
    .where('task_id', '=', taskId)
    .where('status', 'in', ['PENDING', 'AWAITING_APPROVAL'])
    .execute();
}

/**
 * Steps that never ran become SKIPPED when the task fails: a final task has
 * no "pending" work. A retry puts them back to PENDING (tasks/service.ts).
 */
export async function skipOpenSteps(trx: Trx, taskId: string): Promise<void> {
  await trx
    .updateTable('task_steps')
    .set({ status: 'SKIPPED', completed_at: new Date() })
    .where('task_id', '=', taskId)
    .where('status', 'in', ['PENDING', 'AWAITING_APPROVAL'])
    .execute();
}

/** Pending approvals of a task become CANCELLED (or another final status). */
export async function closePendingApprovals(
  trx: Trx,
  taskId: string,
  status: 'CANCELLED' | 'SUPERSEDED' | 'EXPIRED' = 'CANCELLED',
): Promise<string[]> {
  const rows = await trx
    .updateTable('approvals')
    .set({ status, decided_at: new Date() })
    .where('task_id', '=', taskId)
    .where('status', '=', 'PENDING')
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

/**
 * FAILED with a TaskError + task_failed notification. Steps that never ran
 * are SKIPPED and a pending approval is closed, so nothing reads as still
 * to come on a final task.
 */
export async function failTask(
  trx: Trx,
  ctx: DbContext,
  task: TaskRow,
  error: TaskError,
): Promise<TaskRow> {
  await closePendingApprovals(trx, task.id);
  await skipOpenSteps(trx, task.id);
  const updated = await transitionTask(trx, ctx, task, 'FAILED', {
    error: taskErrorJson(error),
  });
  await notifyTaskFailed(trx, ctx, updated, error.code);
  return updated;
}

/** Meters model calls: usage_events + cost_records + tasks.actual_cost_micro. */
export async function recordUsage(
  trx: Trx,
  ctx: DbContext,
  taskId: string | null,
  usage: readonly ModelUsage[],
): Promise<number> {
  let total = 0;
  for (const u of usage) {
    const ev = await trx
      .insertInto('usage_events')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: taskId,
        kind: 'model_tokens',
        provider: u.provider,
        model: u.model,
        input_tokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
        output_tokens: u.outputTokens,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cost_records')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: taskId,
        usage_event_id: ev.id,
        category: 'model',
        amount_micro: u.costMicro,
      })
      .execute();
    total += u.costMicro;
  }
  if (taskId && total > 0) {
    await trx
      .updateTable('tasks')
      .set({ actual_cost_micro: sql`actual_cost_micro + ${total}` as unknown as number })
      .where('id', '=', taskId)
      .execute();
  }
  return total;
}

/** Non-model tool cost (e.g. paid APIs). */
export async function recordToolCost(
  trx: Trx,
  ctx: DbContext,
  taskId: string,
  amountMicro: number,
): Promise<void> {
  if (amountMicro <= 0) return;
  await trx
    .insertInto('cost_records')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      task_id: taskId,
      category: 'tool',
      amount_micro: amountMicro,
    })
    .execute();
  await trx
    .updateTable('tasks')
    .set({ actual_cost_micro: sql`actual_cost_micro + ${amountMicro}` as unknown as number })
    .where('id', '=', taskId)
    .execute();
}
