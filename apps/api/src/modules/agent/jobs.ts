/**
 * Job dispatch for the worker: task.plan, task.execute, approval.expire and
 * (Phase B) schedule.run, retention.sweep, webhook.deliver, plus the
 * dead-letter handler, the post-job reconciliation and the sweeper for tasks
 * no job will move on any more.
 */
import { isTerminal, type TaskError, type TaskStatus } from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type DbContext } from '../../db/pool';
import type { JobRow } from '../../db/types';
import { enqueue } from '../jobs/queue';
import { expireApproval } from './approval-flow';
import { handleExecuteJob, taskStatus } from './executor';
import { handleRetentionJob } from './jobs/retention';
import { handleScheduleRunJob, onScheduleRunDead } from './jobs/schedule-run';
import { handleWebhookDeliverJob, onWebhookDeliverDead } from './jobs/webhook-deliver';
import { handlePlanJob, type JobOutcome } from './plan-job';
import type { RuntimeDeps } from './runtime';
import { failTask, tryLockTask } from './task-state';

export type { JobOutcome };

const ctxOf = (job: JobRow): DbContext => ({ tenantId: job.tenant_id, userId: job.user_id });

/** Thrown when an approval.expire job runs early (clock skew); the queue retries it. */
export class NotYetDueError extends Error {
  constructor() {
    super('approval not yet expired');
    this.name = 'NotYetDueError';
  }
}

export async function handleExpireJob(deps: RuntimeDeps, job: JobRow): Promise<JobOutcome> {
  const approvalId = typeof job.payload.approvalId === 'string' ? job.payload.approvalId : null;
  if (!approvalId) return 'done';
  const ctx = ctxOf(job);
  await withContext(deps.db, ctx, async (trx) => {
    const ref = await trx
      .selectFrom('approvals')
      .select(['task_id', 'status'])
      .where('id', '=', approvalId)
      .executeTakeFirst();
    if (!ref || ref.status !== 'PENDING') return;
    // Lock order: the task row, then the approval row (as cancel and decide do).
    if (!(await tryLockTask(trx, ref.task_id))) return;
    const approval = await trx
      .selectFrom('approvals')
      .selectAll()
      .where('id', '=', approvalId)
      .forUpdate()
      .executeTakeFirst();
    if (!approval || approval.status !== 'PENDING') return;
    if (new Date(approval.expires_at).getTime() > Date.now()) throw new NotYetDueError();
    await expireApproval(trx, ctx, approval, 'system');
  });
  return 'done';
}

export async function runJob(deps: RuntimeDeps, job: JobRow): Promise<JobOutcome> {
  switch (job.kind) {
    case 'task.plan':
      return handlePlanJob(deps, job);
    case 'task.execute':
      return handleExecuteJob(deps, job);
    case 'approval.expire':
      return handleExpireJob(deps, job);
    case 'schedule.run':
      return handleScheduleRunJob(deps, job);
    case 'retention.sweep':
      return handleRetentionJob(deps, job);
    case 'webhook.deliver':
      return handleWebhookDeliverJob(deps, job);
  }
}

/**
 * A job exhausted its attempts. The task must not stay in an active state
 * forever: fail it with INTERNAL (a retry is safe — once_per_step tools
 * report OUTCOME_UNKNOWN rather than repeating an interrupted side effect).
 */
export async function onJobDead(deps: RuntimeDeps, job: JobRow): Promise<void> {
  if (job.kind === 'schedule.run') return onScheduleRunDead(deps, job);
  if (job.kind === 'webhook.deliver') return onWebhookDeliverDead(deps, job);
  if (!job.task_id || job.kind === 'approval.expire' || job.kind === 'retention.sweep') return;
  const ctx = ctxOf(job);
  const taskId = job.task_id;
  await withContext(deps.db, ctx, async (trx) => {
    const task = await tryLockTask(trx, taskId);
    if (!task || isTerminal(task.status) || task.status === 'AWAITING_APPROVAL') return;
    await failTask(trx, ctx, task, {
      code: 'INTERNAL',
      message: 'JARVIS could not finish this task because of an internal error. You can retry it.',
      retryable: true,
    });
  });
}

/** Active statuses in which only a job moves the task on (AWAITING_APPROVAL waits for the user). */
const NEEDS_A_JOB: readonly TaskStatus[] = ['QUEUED', 'PLANNING', 'RUNNING', 'VERIFYING'];

const ORPHANED: TaskError = {
  code: 'INTERNAL',
  message: 'JARVIS stopped working on this task unexpectedly. You can retry it.',
  retryable: true,
};

/**
 * Fails tasks that are active but that nothing will move on any more: no
 * queued or running job, and neither the task nor any of its jobs changed
 * within `graceMs` (which covers the moment between one job finishing and
 * the next being enqueued). This catches what dead-letter handling cannot —
 * onJobDead failing, or a worker dying before it ran or between completing
 * a job and enqueuing the next. A retry is safe, as for onJobDead.
 *
 * RLS hides tasks from a connection without a user context, so the users to
 * check come from the job queue (no RLS): everyone with task jobs that
 * changed within `lookbackMs` (null: any time). Each user is checked in their
 * own context; a failure is logged and does not stop the sweep. Returns how
 * many tasks were failed.
 */
export async function sweepStuckTasks(
  deps: RuntimeDeps,
  opts: { graceMs: number; lookbackMs: number | null },
): Promise<number> {
  let users = deps.db
    .selectFrom('jobs')
    .select(['tenant_id', 'user_id'])
    .distinct()
    .where('task_id', 'is not', null);
  if (opts.lookbackMs !== null)
    users = users.where(
      'updated_at',
      '>',
      sql<Date>`now() - ${opts.lookbackMs} * interval '1 millisecond'`,
    );
  const cutoff = sql<Date>`now() - ${opts.graceMs} * interval '1 millisecond'`;
  let failed = 0;
  for (const u of await users.execute()) {
    const ctx: DbContext = { tenantId: u.tenant_id, userId: u.user_id };
    try {
      failed += await withContext(deps.db, ctx, async (trx) => {
        const candidates = await trx
          .selectFrom('tasks')
          .select('id')
          .where('status', 'in', NEEDS_A_JOB)
          .where('updated_at', '<', cutoff)
          .execute();
        const busy = async (taskId: string) =>
          !!(await trx
            .selectFrom('jobs')
            .select('id')
            .where('task_id', '=', taskId)
            .where((eb) =>
              eb.or([eb('status', 'in', ['queued', 'running']), eb('updated_at', '>', cutoff)]),
            )
            .limit(1)
            .executeTakeFirst());
        let n = 0;
        for (const { id } of candidates) {
          if (await busy(id)) continue; // the common case (a long step): no lock taken
          // Lock, re-checking status and age on the current row, then the jobs again:
          // every enqueue except the post-job reconciliation holds this lock.
          const task = await trx
            .selectFrom('tasks')
            .selectAll()
            .where('id', '=', id)
            .where('status', 'in', NEEDS_A_JOB)
            .where('updated_at', '<', cutoff)
            .forUpdate()
            .executeTakeFirst();
          if (!task || (await busy(id))) continue;
          deps.log.warn('failing a task that no job will move on', {
            taskId: id,
            status: task.status,
          });
          await failTask(trx, ctx, task, ORPHANED);
          n++;
        }
        return n;
      });
    } catch (err) {
      deps.log.error('stuck-task sweep failed for a user', {
        userId: u.user_id,
        error: String(err),
      });
    }
  }
  return failed;
}

/**
 * Closes two races caused by the one-live-execute-job-per-task dedupe key:
 *  - an approval decided while the execute job that requested it was still
 *    finishing (its enqueue was dropped because this job was still 'running');
 *  - a retry whose plan job finished before this execute job was marked complete.
 * In both cases the task is RUNNING again once this job is complete, so enqueue
 * an execute job (deduplicated, so a job that already exists wins).
 */
export async function reconcileAfterJob(deps: RuntimeDeps, job: JobRow): Promise<void> {
  if (job.kind !== 'task.execute' || !job.task_id) return;
  const ctx = ctxOf(job);
  const status = await taskStatus(deps, ctx, job.task_id);
  if (status !== 'RUNNING') return;
  await withContext(deps.db, ctx, (trx) =>
    enqueue(trx, {
      kind: 'task.execute',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      taskId: job.task_id,
      dedupeKey: `exec:${job.task_id}`,
    }),
  );
}
