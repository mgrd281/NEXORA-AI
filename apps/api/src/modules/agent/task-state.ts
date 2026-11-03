/**
 * The only code that changes tasks.status. Every transition is checked
 * against the shared state machine (assertTransition), bumps the optimistic
 * version, and writes `task.status_changed` in the same transaction.
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
import type { ModelUsage } from './models/adapter';

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
  return updated;
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

/** FAILED with a TaskError + task_failed notification. */
export async function failTask(
  trx: Trx,
  ctx: DbContext,
  task: TaskRow,
  error: TaskError,
): Promise<TaskRow> {
  const updated = await transitionTask(trx, ctx, task, 'FAILED', {
    error: taskErrorJson(error),
  });
  await createNotification(trx, ctx, 'task_failed', task.id, {
    taskTitle: updated.title,
    errorCode: error.code,
  });
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
