/**
 * One lock order for a task and its approval — the task row first, then the
 * approval row — in cancel, approval decisions and the approval.expire job.
 * With opposite orders, concurrent transactions deadlock and Postgres aborts
 * one of them (40P01: a 500 instead of a clean INVALID_STATE, or a burned
 * job attempt). Each test forces the dangerous interleaving: a third session
 * holds the task row while cancel queues for it first and the other operation
 * second; once released, cancel runs while the other waits.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobRow } from '../../../src/db/types';
import { handleExpireJob } from '../../../src/modules/agent/jobs';
import { TEST_OWNER_URL } from '../env';
import {
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  drain,
  newUser,
  type Harness,
} from './harness';

let h: Harness;
let owner: pg.Client;
let ownerPid: number;

beforeAll(async () => {
  h = await createHarness();
  owner = new pg.Client({ connectionString: TEST_OWNER_URL });
  await owner.connect();
  ownerPid = (await owner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
});
afterAll(async () => {
  await owner.end();
  await h.close();
});
beforeEach(async () => {
  await owner.query('ROLLBACK'); // in case a failed test left the lock behind
});

type Settled<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string; message: string }) => ({ ok: false as const, error }),
  );

/** Waits until `n` sessions wait (directly or transitively) on the owner session's locks. */
async function waitForBlocked(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // pg_locks, not pg_stat_activity: the wait details of other roles' sessions are hidden there.
    const { rows } = await owner.query<{ pid: number; by: number[] }>(
      `SELECT DISTINCT pid, pg_blocking_pids(pid) AS by FROM pg_locks WHERE NOT granted`,
    );
    const blocked = new Set<number>([ownerPid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows)
        if (!blocked.has(r.pid) && r.by.some((b) => blocked.has(b))) {
          blocked.add(r.pid);
          grew = true;
        }
    }
    if (blocked.size - 1 >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} blocked sessions`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function awaitingApproval() {
  const user = await newUser(h.db);
  await connectWeb(h.db, user);
  await connectSmtp(h.db, h.secrets, user, h.smtp.port);
  const s = await h.services.tasks.create(
    user,
    { request: `Summarize ${h.site.url('/article')} and email it to me`, source: 'text' },
    {},
  );
  await drain(h.worker);
  const d = await detail(h.db, user, s.id);
  expect(d.status).toBe('AWAITING_APPROVAL');
  return { user, task: d, approval: d.approvals[0]! };
}

async function holdTask(taskId: string): Promise<void> {
  await owner.query('BEGIN');
  await owner.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
}

describe('task/approval lock order', () => {
  it('approve racing cancel: cancel wins, the decision is refused cleanly (no deadlock)', async () => {
    const { user, task, approval } = await awaitingApproval();
    await holdTask(task.id);
    const cancel = settle(h.services.tasks.cancel(user, task.id));
    await waitForBlocked(1);
    const decide = settle(
      h.services.approvals.decide(
        user,
        approval.id,
        { decision: 'approve', actionHash: approval.actionHash },
        'web',
      ),
    );
    await waitForBlocked(2);
    await owner.query('COMMIT');

    const [c, d] = await Promise.all([cancel, decide]);
    expect(c).toMatchObject({ ok: true, value: { status: 'CANCELLED' } });
    expect(d).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'This request was already cancelled.' },
    });
    const after = await detail(h.db, user, task.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.approvals[0]!.status).toBe('CANCELLED');
  });

  it('the approval.expire job racing cancel: cancel wins, the job is a no-op (no deadlock)', async () => {
    const { user, task, approval } = await awaitingApproval();
    // The approval is due: its expiry job runs now.
    await owner.query(
      `UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [approval.id],
    );
    const { rows } = await owner.query<JobRow>(
      `SELECT * FROM jobs WHERE kind = 'approval.expire' AND task_id = $1`,
      [task.id],
    );
    const job = rows[0]!;

    await holdTask(task.id);
    const cancel = settle(h.services.tasks.cancel(user, task.id));
    await waitForBlocked(1);
    const expire = settle(handleExpireJob(h.worker, job));
    await waitForBlocked(2);
    await owner.query('COMMIT');

    const [c, e] = await Promise.all([cancel, expire]);
    expect(c).toMatchObject({ ok: true, value: { status: 'CANCELLED' } });
    expect(e).toEqual({ ok: true, value: 'done' });
    const after = await detail(h.db, user, task.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.approvals[0]!.status).toBe('CANCELLED');
  });
});
