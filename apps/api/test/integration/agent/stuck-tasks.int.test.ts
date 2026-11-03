/**
 * No task stays active with nothing left to move it on. A job whose lease
 * expires on its last attempt is dead-lettered by the reclaimer, which then
 * fails its task exactly as a job failing in the worker would (onJobDead).
 * Anything else that leaves an active task without a queued or running job
 * (the dead-letter handling itself failing, a crash between steps of the
 * worker) is found by the periodic sweeper after a grace period.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskStatus } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../../src/db/pool';
import { sweepStuckTasks } from '../../../src/modules/agent/jobs';
import { reclaimOnce } from '../../../src/worker';
import { connectSmtp, connectWeb, createHarness, detail, drain, newUser, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function setStatus(user: DbContext, taskId: string, status: TaskStatus) {
  await withContext(h.db, user, (trx) =>
    trx.updateTable('tasks').set({ status, started_at: new Date() }).where('id', '=', taskId).execute(),
  );
}

async function jobsOf(taskId: string) {
  return h.db
    .selectFrom('jobs')
    .select(['id', 'kind', 'status', 'attempts'])
    .where('task_id', '=', taskId)
    .orderBy('id')
    .execute();
}

/** A worker leased the task's plan job on its last attempt, moved the task to PLANNING and died. */
async function diedOnLastAttempt(request: string) {
  const user = await newUser(h.db);
  const s = await h.services.tasks.create(user, { request, source: 'text' }, {});
  await setStatus(user, s.id, 'PLANNING');
  await h.db
    .updateTable('jobs')
    .set({
      status: 'running',
      locked_by: 'worker-that-died',
      locked_until: new Date(Date.now() - 1_000),
      attempts: sql<number>`max_attempts`,
    })
    .where('task_id', '=', s.id)
    .execute();
  return { user, taskId: s.id };
}

describe('reclaiming an expired lease on the last attempt', () => {
  it('dead-letters the job and fails its task, which can then be retried', async () => {
    const { user, taskId } = await diedOnLastAttempt('remember that leases can run out');
    expect(await reclaimOnce(h.worker)).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(taskId)).map((j) => j.status)).toEqual(['dead']);
    const d = await detail(h.db, user, taskId);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ code: 'INTERNAL', retryable: true });
    expect(d.canRetry).toBe(true);

    await h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: false });
    await drain(h.worker);
    expect((await detail(h.db, user, taskId)).status).toBe('COMPLETED');
  });

  it('requeues a job that still has attempts left, without touching its task', async () => {
    const user = await newUser(h.db);
    const s = await h.services.tasks.create(
      user,
      { request: 'remember that a reclaimed job runs again', source: 'text' },
      {},
    );
    await setStatus(user, s.id, 'PLANNING');
    await h.db
      .updateTable('jobs')
      .set({ status: 'running', locked_by: 'gone', locked_until: new Date(Date.now() - 1_000), attempts: 1 })
      .where('task_id', '=', s.id)
      .execute();
    await reclaimOnce(h.worker);
    expect((await jobsOf(s.id)).map((j) => j.status)).toEqual(['queued']);
    expect((await detail(h.db, user, s.id)).status).toBe('PLANNING');
    await drain(h.worker);
    expect((await detail(h.db, user, s.id)).status).toBe('COMPLETED');
  });
});

describe('the stuck-task sweeper', () => {
  /** An active task whose only job is already dead (its dead-letter handling never ran). */
  async function orphaned(status: TaskStatus) {
    const user = await newUser(h.db);
    const s = await h.services.tasks.create(
      user,
      { request: 'remember that orphans get cleaned up', source: 'text' },
      {},
    );
    await setStatus(user, s.id, status);
    await h.db
      .updateTable('jobs')
      .set({ status: 'dead', locked_by: null, locked_until: null })
      .where('task_id', '=', s.id)
      .execute();
    return { user, taskId: s.id };
  }

  it('fails active tasks with no queued or running job once the grace period has passed', async () => {
    const stuck = await Promise.all(
      (['QUEUED', 'PLANNING', 'RUNNING', 'VERIFYING'] as const).map((st) => orphaned(st)),
    );
    // Within the grace period nothing is touched.
    await sweepStuckTasks(h.worker, { graceMs: 60_000, lookbackMs: 60_000 });
    for (const { user, taskId } of stuck)
      expect((await detail(h.db, user, taskId)).status).not.toBe('FAILED');

    expect(await sweepStuckTasks(h.worker, { graceMs: 0, lookbackMs: 60_000 })).toBeGreaterThanOrEqual(4);
    for (const { user, taskId } of stuck) {
      const d = await detail(h.db, user, taskId);
      expect(d.status).toBe('FAILED');
      expect(d.error).toEqual({
        code: 'INTERNAL',
        message: 'JARVIS stopped working on this task unexpectedly. You can retry it.',
        retryable: true,
      });
      expect(d.canRetry).toBe(true);
    }
  });

  it('leaves alone tasks that are waiting for an approval, still have work queued, or are finished', async () => {
    // Waiting on the user: no job needed (its expiry job may even be gone).
    const waitingUser = await newUser(h.db);
    await connectWeb(h.db, waitingUser);
    await connectSmtp(h.db, h.secrets, waitingUser, h.smtp.port);
    const waiting = await h.services.tasks.create(
      waitingUser,
      { request: `Summarize ${h.site.url('/article')} and email it to me`, source: 'text' },
      {},
    );
    await drain(h.worker);
    await h.db.updateTable('jobs').set({ status: 'dead' }).where('task_id', '=', waiting.id).execute();

    // Queued work that has not run yet.
    const queuedUser = await newUser(h.db);
    const queued = await h.services.tasks.create(
      queuedUser,
      { request: 'remember that queued work is not stuck', source: 'text' },
      {},
    );
    await h.db
      .updateTable('jobs')
      .set({ run_at: new Date(Date.now() + 3_600_000) })
      .where('task_id', '=', queued.id)
      .execute();

    // Finished.
    const doneUser = await newUser(h.db);
    const done = await h.services.tasks.create(
      doneUser,
      { request: 'remember that finished tasks stay finished', source: 'text' },
      {},
    );
    await drain(h.worker);

    await sweepStuckTasks(h.worker, { graceMs: 0, lookbackMs: 60_000 });
    expect((await detail(h.db, waitingUser, waiting.id)).status).toBe('AWAITING_APPROVAL');
    expect((await detail(h.db, queuedUser, queued.id)).status).toBe('QUEUED');
    expect((await detail(h.db, doneUser, done.id)).status).toBe('COMPLETED');
    await h.db.deleteFrom('jobs').where('task_id', '=', queued.id).execute();
  });
});
