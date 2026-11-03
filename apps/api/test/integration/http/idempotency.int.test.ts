/**
 * Idempotency-Key claims are atomic and owned: of concurrent duplicates only
 * the request that inserted the claim runs the handler, a failing request
 * releases only its own claim, and a claim stranded by a crash is taken over
 * once its lease has passed.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Approval } from '@jarvis/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { AppError } from '../../../src/lib/errors';
import { TEST_APP_URL, TEST_OWNER_URL } from '../env';
import { createHarness, newClient, seedApproval, seedTask, type Harness } from './support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let h: Harness;
let owner: pg.Client;
/**
 * Watches the API's lock waits: from outside the blocking transaction (activity
 * is snapshotted per transaction) and as the app role (other roles' wait events are hidden).
 */
let watcher: pg.Client;
beforeAll(async () => {
  h = await createHarness();
  owner = new pg.Client({ connectionString: TEST_OWNER_URL });
  watcher = new pg.Client({ connectionString: TEST_APP_URL });
  await owner.connect();
  await watcher.connect();
});
afterAll(async () => {
  await owner.end();
  await watcher.end();
  await h.close();
});

async function keyRow(userId: string, key: string) {
  const r = await owner.query<{ response_status: number | null; response_body: unknown }>(
    'select response_status, response_body from idempotency_keys where user_id = $1 and key = $2',
    [userId, key],
  );
  return r.rows[0] ?? null;
}

/** Waits until `n` backends of this database are blocked on a lock. */
async function waitForLockWaiters(n: number) {
  const until = Date.now() + 5000;
  for (;;) {
    const r = await watcher.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (r.rows[0]!.n >= n) return;
    if (Date.now() > until) throw new Error(`only ${r.rows[0]!.n} of ${n} requests are waiting`);
    await sleep(10);
  }
}

describe('Idempotency-Key claims', () => {
  it('runs concurrent duplicates once and keeps the winner’s response for retries', async () => {
    const c = await newClient(h);
    const task = await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' });
    const a = await seedApproval(h.db, c.user, task);
    const key = `double-tap-${a.id}`;
    const url = `/v1/approvals/${a.id}/decision`;
    const body = { decision: 'approve', actionHash: a.actionHash };
    const headers = { 'idempotency-key': key };

    // Hold the key's primary key with an uncommitted row so both requests
    // reach their claim at the same time, then let them race for it.
    await owner.query('begin');
    await owner.query(
      `insert into idempotency_keys (user_id, tenant_id, route, key, request_hash)
       values ($1, $2, 'decideApproval', $3, 'blocker')`,
      [c.user.userId, c.user.tenantId, key],
    );
    let both: Promise<LightMyRequestResponse[]>;
    try {
      both = Promise.all([
        c.request('POST', url, body, headers),
        c.request('POST', url, body, headers),
      ]);
      await waitForLockWaiters(2);
    } finally {
      await owner.query('rollback');
    }
    const results = await both!;

    const decided = h.fake.calls.decide.filter((d) => d.approvalId === a.id);
    expect(decided).toHaveLength(1);
    const winner = results.find((r) => r.statusCode === 200)!;
    expect(winner).toBeDefined();
    const loser = results.find((r) => r !== winner)!;
    // The duplicate is told to wait (CONFLICT) or gets the winner's response.
    if (loser.statusCode === 200) expect(loser.json()).toEqual(winner.json());
    else {
      expect(loser.statusCode).toBe(409);
      expect(loser.json().error.code).toBe('CONFLICT');
    }
    // The key still holds the winner's response, so a retry replays it.
    expect((await keyRow(c.user.userId, key))?.response_status).toBe(200);
    const retry = await c.request('POST', url, body, headers);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<Approval>()).toEqual(winner.json());
    expect(h.fake.calls.decide.filter((d) => d.approvalId === a.id)).toHaveLength(1);
  });

  it('takes over an abandoned claim, and the stalled request never releases the new owner’s key', async () => {
    const c = await newClient(h);
    const task = await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' });
    const a = await seedApproval(h.db, c.user, task);
    const key = `stalled-${a.id}`;
    const url = `/v1/approvals/${a.id}/decision`;
    const body = { decision: 'approve', actionHash: a.actionHash };
    const headers = { 'idempotency-key': key };

    const decide = h.fake.agent.approvals.decide;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    h.fake.agent.approvals.decide = async (...args) => {
      calls++;
      if (calls === 1) {
        // The first request stalls past its lease, then fails.
        entered = true;
        await gate;
        throw new AppError('INVALID_STATE', 'Already decided');
      }
      return decide(...args);
    };
    try {
      const stalled = c.request('POST', url, body, headers);
      const until = Date.now() + 5000;
      while (!entered && Date.now() < until) await sleep(10);
      expect(entered).toBe(true);
      // Its claim is now older than the lease, as after a hung or crashed request.
      await owner.query(
        `update idempotency_keys set created_at = now() - interval '3 minutes'
          where user_id = $1 and key = $2`,
        [c.user.userId, key],
      );

      const takeover = await c.request('POST', url, body, headers);
      expect(takeover.statusCode).toBe(200);
      expect(takeover.json<Approval>().status).toBe('APPROVED');

      release();
      const late = await stalled;
      expect(late.statusCode).toBe(409);
      // The stalled request's failure did not delete the new owner's stored response.
      expect((await keyRow(c.user.userId, key))?.response_status).toBe(200);
      const retry = await c.request('POST', url, body, headers);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(takeover.json());
      expect(calls).toBe(2);
    } finally {
      release();
      h.fake.agent.approvals.decide = decide;
    }
  });

  it('treats a stranded claim as in progress until its lease passes, then lets a retry run', async () => {
    const c = await newClient(h);
    const key = 'stranded-claim-0001';
    const headers = { 'idempotency-key': key };
    const first = await c.request('POST', '/v1/tasks', { request: 'Stranded' }, headers);
    expect(first.statusCode).toBe(202);
    // The state a crash leaves behind: a claim without a stored response.
    await owner.query(
      `update idempotency_keys set response_status = null, response_body = null, created_at = now()
        where user_id = $1 and key = $2`,
      [c.user.userId, key],
    );

    const busy = await c.request('POST', '/v1/tasks', { request: 'Stranded' }, headers);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('CONFLICT');
    const mismatch = await c.request('POST', '/v1/tasks', { request: 'Other' }, headers);
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_MISMATCH');

    await owner.query(
      `update idempotency_keys set created_at = now() - interval '3 minutes'
        where user_id = $1 and key = $2`,
      [c.user.userId, key],
    );
    const retried = await c.request('POST', '/v1/tasks', { request: 'Stranded' }, headers);
    expect(retried.statusCode).toBe(202);
    expect(retried.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect((await keyRow(c.user.userId, key))?.response_status).toBe(200);
    const replay = await c.request('POST', '/v1/tasks', { request: 'Stranded' }, headers);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(retried.json());
  });
});
