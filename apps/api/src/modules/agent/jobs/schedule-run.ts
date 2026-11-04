/**
 * Scheduled tasks, exactly once per occurrence (docs/architecture/phase-b.md §3.5).
 *
 * schedulerTick (worker timer, every 15 s): scheduler_due_schedules (SECURITY
 * DEFINER, ids only, active users) → one schedule.run job per due schedule,
 * deduplicated per occurrence (schedule:<id>:<occurrence ISO>).
 *
 * schedule.run job — in the owner's RLS context, one transaction:
 *   1. lockDueSchedule (FOR UPDATE SKIP LOCKED; null → another worker has it,
 *      or it is no longer due/active: done). The occurrence is the locked
 *      row's next_run_at.
 *   2. The AI budget is used up (a model would be used, budget positive) →
 *      run 'skipped' BUDGET_EXHAUSTED, pause 'budget', notify, schedule.failed.
 *   3. INSERT schedule_runs … ON CONFLICT (schedule_id, occurrence_at) DO
 *      NOTHING: a conflict means the occurrence already ran → only advance.
 *   4. createScheduledTask (task + message + plan job + webhooks).
 *   5. The run's task id; advanceSchedule (next occurrence after
 *      max(now, occurrence): missed occurrences collapse into one run).
 * The unique key on schedule_runs makes "at most once" a database guarantee
 * whatever the number of workers, retries or ticks. A job that dies (it
 * could not create the task) records a 'failed' run, advances, counts a
 * failure and notifies (onScheduleRunDead).
 */
import { sql } from 'kysely';
import { withContext, type DbContext, type Trx } from '../../../db/pool';
import type { JobRow, ScheduleRow } from '../../../db/types';
import { withSpan } from '../../../observability/tracing';
import { enqueue } from '../../jobs/queue';
import { createNotification } from '../../notifications/create';
import {
  advanceSchedule,
  lockDueSchedule,
  pauseSchedule,
  recordScheduleRunResult,
} from '../../schedules/service';
import { createScheduledTask } from '../../tasks/service';
import { loadAgentContext } from '../context';
import { nowOf, type RuntimeDeps } from '../runtime';
import { emitScheduleWebhook } from '../webhook-events';

const ctxOf = (job: JobRow): DbContext => ({ tenantId: job.tenant_id, userId: job.user_id });

/** Attempts of a schedule.run job before it counts as a failed run. */
export const SCHEDULE_RUN_MAX_ATTEMPTS = 3;

export function scheduleRunKey(scheduleId: string, occurrenceAt: Date): string {
  return `schedule:${scheduleId}:${occurrenceAt.toISOString()}`;
}

/** Enqueues a schedule.run job for every due schedule. Returns how many were enqueued. */
export function schedulerTick(deps: Pick<RuntimeDeps, 'db'>, limit = 100): Promise<number> {
  return withSpan('scheduler.tick', { 'jarvis.scheduler.limit': limit }, () => tick(deps, limit));
}

async function tick(deps: Pick<RuntimeDeps, 'db'>, limit: number): Promise<number> {
  const due = await sql<{
    schedule_id: string;
    tenant_id: string;
    user_id: string;
    next_run_at: Date;
  }>`SELECT * FROM scheduler_due_schedules(${limit})`.execute(deps.db);
  let enqueued = 0;
  for (const row of due.rows) {
    const occurrenceAt = new Date(row.next_run_at);
    const added = await deps.db.transaction().execute((trx) =>
      enqueue(trx, {
        kind: 'schedule.run',
        tenantId: row.tenant_id,
        userId: row.user_id,
        payload: { scheduleId: row.schedule_id, occurrenceAt: occurrenceAt.toISOString() },
        dedupeKey: scheduleRunKey(row.schedule_id, occurrenceAt),
        maxAttempts: SCHEDULE_RUN_MAX_ATTEMPTS,
      }),
    );
    if (added) enqueued++;
  }
  return enqueued;
}

async function insertRun(
  trx: Trx,
  ctx: DbContext,
  schedule: ScheduleRow,
  occurrenceAt: Date,
  status: 'created' | 'skipped' | 'failed',
  reason: 'BUDGET_EXHAUSTED' | 'CREATE_FAILED' | null,
): Promise<string | null> {
  const row = await trx
    .insertInto('schedule_runs')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      schedule_id: schedule.id,
      occurrence_at: occurrenceAt,
      status,
      reason,
    })
    .onConflict((oc) => oc.columns(['schedule_id', 'occurrence_at']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function handleScheduleRunJob(deps: RuntimeDeps, job: JobRow): Promise<'done'> {
  const scheduleId = typeof job.payload.scheduleId === 'string' ? job.payload.scheduleId : null;
  if (!scheduleId) return 'done';
  const ctx = ctxOf(job);
  const now = nowOf(deps);
  await withContext(deps.db, ctx, async (trx) => {
    const schedule = await lockDueSchedule(trx, scheduleId, now);
    if (!schedule) return;
    const occurrenceAt = new Date(schedule.next_run_at!);

    // A run would use a model the budget no longer pays for: pause rather than run degraded.
    const agent = await loadAgentContext(trx, deps.config, ctx.userId);
    if (agent.route.reason === 'BUDGET_EXHAUSTED' && agent.budget.limitMicro > 0) {
      const run = await insertRun(trx, ctx, schedule, occurrenceAt, 'skipped', 'BUDGET_EXHAUSTED');
      if (!run) {
        await advanceSchedule(trx, ctx, schedule, { occurrenceAt, taskId: null, now });
        return;
      }
      const paused = await pauseSchedule(trx, ctx, schedule.id, 'budget');
      await createNotification(trx, ctx, 'schedule_paused', null, {
        scheduleTitle: schedule.title,
        reason: 'budget',
      });
      await emitScheduleWebhook(trx, ctx, 'schedule.failed', paused, {
        occurrenceAt,
        taskId: null,
        reason: 'BUDGET_EXHAUSTED',
      });
      return;
    }

    const runId = await insertRun(trx, ctx, schedule, occurrenceAt, 'created', null);
    if (!runId) {
      // This occurrence already ran (exactly once): only move the schedule on.
      await advanceSchedule(trx, ctx, schedule, { occurrenceAt, taskId: null, now });
      return;
    }
    const { taskId } = await createScheduledTask(trx, ctx, schedule, occurrenceAt);
    await trx
      .updateTable('schedule_runs')
      .set({ task_id: taskId })
      .where('id', '=', runId)
      .execute();
    await advanceSchedule(trx, ctx, schedule, { occurrenceAt, taskId, now });
  });
  return 'done';
}

/**
 * A schedule.run job used up its attempts (the task could not be created):
 * the occurrence becomes a 'failed' run, the schedule moves on, the failure
 * counts towards pausing it, and the user is told.
 */
export async function onScheduleRunDead(deps: RuntimeDeps, job: JobRow): Promise<void> {
  const scheduleId = typeof job.payload.scheduleId === 'string' ? job.payload.scheduleId : null;
  if (!scheduleId) return;
  const ctx = ctxOf(job);
  const now = nowOf(deps);
  await withContext(deps.db, ctx, async (trx) => {
    const schedule = await lockDueSchedule(trx, scheduleId, now);
    if (!schedule) return;
    const occurrenceAt = new Date(schedule.next_run_at!);
    const runId = await insertRun(trx, ctx, schedule, occurrenceAt, 'failed', 'CREATE_FAILED');
    await advanceSchedule(trx, ctx, schedule, { occurrenceAt, taskId: null, now });
    if (!runId) return;
    await createNotification(trx, ctx, 'schedule_failed', null, { scheduleTitle: schedule.title });
    const result = await recordScheduleRunResult(trx, ctx, scheduleId, 'failed');
    if (result?.paused) {
      await createNotification(trx, ctx, 'schedule_paused', null, {
        scheduleTitle: schedule.title,
        reason: 'failures',
      });
    }
    await emitScheduleWebhook(trx, ctx, 'schedule.failed', result?.schedule ?? schedule, {
      occurrenceAt,
      taskId: null,
      reason: 'CREATE_FAILED',
    });
  });
}
