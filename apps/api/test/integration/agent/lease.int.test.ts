/**
 * A job's lease is held for as long as the job runs — every step, the waits
 * between them and the result summary, not only single long tool calls — so
 * the reclaimer never hands a running job to a second worker. A worker that
 * loses the lease anyway (stalled past it) stops at once: in-flight tool and
 * model calls are aborted and it writes nothing more, leaving the job to the
 * worker that owns it now.
 *
 * The lease is shortened to LEASE ms; model calls take STEP ms, so each job
 * below runs for several leases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../../src/db/pool';
import type { JobRow } from '../../../src/db/types';
import type { TextRequest } from '../../../src/modules/agent/models/adapter';
import { lease } from '../../../src/modules/jobs/queue';
import { processJob, reclaimOnce, runOnce, type WorkerDeps } from '../../../src/worker';
import { ScriptedModel } from '../../fixtures/scripted-model';
import {
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  executions,
  newUser,
  type Harness,
} from './harness';

const LEASE = 600;
const STEP = 350;

const model = new ScriptedModel();
let h: Harness;
let A: WorkerDeps;
let B: WorkerDeps;

beforeAll(async () => {
  h = await createHarness({ adapter: model, env: { ANTHROPIC_API_KEY: 'sk-test-scripted' } });
  A = { ...h.worker, workerId: 'worker-A', leaseMs: LEASE };
  B = { ...h.worker, workerId: 'worker-B', leaseMs: LEASE };
});
afterAll(() => h.close());

/** Waits `ms`, or until `signal` aborts (then rejects with its reason). */
function slow(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function connectedUser() {
  const user = await newUser(h.db, {
    autonomy: { ...DEFAULT_PREFERENCES.autonomy, autoApproveEmailToSelf: true },
  });
  await connectWeb(h.db, user);
  await connectSmtp(h.db, h.secrets, user, h.smtp.port);
  return user;
}

/** web.fetch, `summaries` × text.summarize, then (optionally) email to self — planned, not yet run. */
async function plannedTask(
  user: DbContext & { email: string },
  summaries: number,
  withEmail: boolean,
) {
  const url = h.site.url('/article');
  const keys = Array.from({ length: summaries }, (_, i) => `s${i + 2}`);
  model.script = {
    object: () => ({
      title: 'Summaries',
      objective: 'Summarize and email.',
      steps: [
        { key: 's1', toolId: 'web.fetch', title: 'Read', input: { url } },
        ...keys.map((key) => ({
          key,
          toolId: 'text.summarize',
          title: `Summarize ${key}`,
          input: { text: '{{s1.text}}', title: '{{s1.title}}', language: 'en' },
        })),
        ...(withEmail
          ? [
              {
                key: `s${summaries + 2}`,
                toolId: 'email.send',
                title: 'Email me',
                input: { to: [user.email], subject: 'Summary', body: `{{${keys.at(-1)}.summary}}` },
              },
            ]
          : []),
      ],
    }),
  };
  const s = await h.services.tasks.create(
    user,
    { request: `Summarize ${url} and email it to me`, source: 'text' },
    {},
  );
  await runOnce(A, { limit: 1 }); // the plan job: RUNNING with its execute job queued
  expect((await detail(h.db, user, s.id)).status).toBe('RUNNING');
  return s.id;
}

/** Worker A leases the task's execute job (and only that). */
async function leaseExecuteJob(taskId: string): Promise<JobRow> {
  const leased = await lease(h.db, 'worker-A', LEASE, 10);
  const others = leased.filter((j) => j.task_id !== taskId).map((j) => j.id);
  if (others.length)
    await h.db
      .updateTable('jobs')
      .set({ status: 'queued', locked_by: null, locked_until: null })
      .where('id', 'in', others)
      .execute();
  const job = leased.find((j) => j.task_id === taskId && j.kind === 'task.execute');
  expect(job).toBeDefined();
  return job!;
}

const jobRow = (id: number) =>
  h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('job lease', () => {
  it('is held for the whole job: no reclaim, no second lease, every step once', async () => {
    const user = await connectedUser();
    const taskId = await plannedTask(user, 3, true);
    const calls: string[] = [];
    model.script.text = async (req: TextRequest) => {
      calls.push(req.purpose);
      await slow(STEP, req.signal);
      return req.purpose === 'summarize' ? 'A short summary.' : 'Summarized and emailed.';
    };
    const job = await leaseExecuteJob(taskId);
    const leasedUntil = new Date(job.locked_until!).getTime();

    let running = true;
    const violations: string[] = [];
    let latestLockedUntil = leasedUntil;
    // The reclaimer of every worker, much more often than in production.
    const watch = (async () => {
      while (running) {
        await reclaimOnce(B);
        const row = await jobRow(job.id);
        if (running && (row.status !== 'running' || row.locked_by !== 'worker-A'))
          violations.push(`${row.status} by ${row.locked_by}`);
        if (row.locked_until)
          latestLockedUntil = Math.max(latestLockedUntil, new Date(row.locked_until).getTime());
        await slow(50);
      }
    })();
    const started = Date.now();
    await processJob(A, job);
    running = false;
    await watch;

    expect(Date.now() - started).toBeGreaterThan(2 * LEASE); // it really outlived the first lease
    expect(violations).toEqual([]);
    expect(latestLockedUntil).toBeGreaterThan(leasedUntil + LEASE); // extended repeatedly
    expect(await jobRow(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    const d = await detail(h.db, user, taskId);
    expect(d.status).toBe('COMPLETED');
    expect(d.steps.map((s) => s.attempts)).toEqual([1, 1, 1, 1, 1]);
    expect(calls).toEqual(['summarize', 'summarize', 'summarize', 'result_summary']);
    expect(h.smtp.to(user.email)).toHaveLength(1);
  });

  it('once lost, the worker aborts its model call and writes nothing more; the new owner finishes', async () => {
    const user = await connectedUser();
    const taskId = await plannedTask(user, 3, true);
    const job = await leaseExecuteJob(taskId);
    const calls: { purpose: string; worker: string }[] = [];
    let aborted = false;
    model.script.text = async (req: TextRequest) => {
      const first = calls.length === 0;
      calls.push({ purpose: req.purpose, worker: first ? 'A' : 'B' });
      if (first) {
        // Worker A stalled past its lease: the job was reclaimed and worker B leased it.
        await h.db
          .updateTable('jobs')
          .set({ locked_by: 'worker-B', attempts: 2 })
          .where('id', '=', job.id)
          .execute();
        try {
          await slow(5_000, req.signal);
        } catch (err) {
          aborted = true;
          throw err;
        }
      }
      return req.purpose === 'summarize' ? 'A short summary.' : 'Summarized and emailed.';
    };

    const started = Date.now();
    await processJob(A, job);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    // A recorded nothing after losing the lease: no outcome, no failure, no later step, no email.
    expect(await jobRow(job.id)).toMatchObject({ status: 'running', locked_by: 'worker-B' });
    const mid = await detail(h.db, user, taskId);
    expect(mid.status).toBe('RUNNING');
    expect(mid.steps.map((s) => s.status)).toEqual([
      'SUCCEEDED',
      'RUNNING',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
    expect(calls).toHaveLength(1);
    expect(h.smtp.to(user.email)).toHaveLength(0);

    // Worker B, which owns the job now, runs it to the end.
    await processJob(B, await jobRow(job.id));
    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    expect(h.smtp.to(user.email)).toHaveLength(1);
    // A's interrupted attempt is on record as such; B's attempt succeeded.
    const s2 = (await executions(h.db, user, taskId)).filter((e) => e.step_id === mid.steps[1]!.id);
    expect(s2.map((e) => e.status)).toEqual(['failed', 'succeeded']);
  });

  it('lost during the result summary, the summary call is aborted and the task is not completed by that worker', async () => {
    const user = await connectedUser();
    const taskId = await plannedTask(user, 1, false);
    const job = await leaseExecuteJob(taskId);
    let summarySignal: AbortSignal | undefined;
    let stolen = false;
    model.script.text = async (req: TextRequest) => {
      if (req.purpose === 'result_summary' && !stolen) {
        stolen = true;
        summarySignal = req.signal;
        await h.db
          .updateTable('jobs')
          .set({ locked_by: 'worker-B' })
          .where('id', '=', job.id)
          .execute();
        await slow(5_000, req.signal);
      }
      return req.purpose === 'summarize' ? 'A short summary.' : 'Read and summarized the article.';
    };

    const started = Date.now();
    await processJob(A, job);
    expect(summarySignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    const mid = await detail(h.db, user, taskId);
    expect(mid.status).toBe('VERIFYING');
    expect(mid.resultSummary).toBeNull();

    await processJob(B, await jobRow(job.id));
    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultSummary).toBe('Read and summarized the article.');
    const purposes = await withContext(h.db, user, (trx) =>
      trx.selectFrom('usage_events').select('model').where('task_id', '=', taskId).execute(),
    );
    // planning + summarize + B's result summary: A's aborted call was never billed.
    expect(purposes).toHaveLength(3);
  });
});
