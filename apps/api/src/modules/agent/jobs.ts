/**
 * Job dispatch for the worker: task.plan, task.execute, approval.expire, plus
 * the dead-letter handler and the post-job reconciliation.
 */
import { isTerminal } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { JobRow } from '../../db/types';
import { enqueue } from '../jobs/queue';
import { expireApproval } from './approval-flow';
import { handleExecuteJob, taskStatus } from './executor';
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
  }
}

/**
 * A job exhausted its attempts. The task must not stay in an active state
 * forever: fail it with INTERNAL (a retry is safe — once_per_step tools
 * report OUTCOME_UNKNOWN rather than repeating an interrupted side effect).
 */
export async function onJobDead(deps: RuntimeDeps, job: JobRow): Promise<void> {
  if (!job.task_id || job.kind === 'approval.expire') return;
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
