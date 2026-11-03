import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskDetail, TaskSummary } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { appendEvent } from '../../../src/modules/events/events';
import { createTestUser } from '../helpers';
import {
  createHarness,
  loginWeb,
  newClient,
  seedApproval,
  seedTask,
  timeline,
  WEB_ORIGIN,
  type Client,
  type Harness,
} from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Page = { items: TaskSummary[]; nextCursor: string | null };

async function allPages(c: Client, url: string): Promise<TaskSummary[][]> {
  const pages: TaskSummary[][] = [];
  let next: string | null = null;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const res = await c.request(
      'GET',
      next ? `${url}${sep}cursor=${encodeURIComponent(next)}` : url,
    );
    expect(res.statusCode).toBe(200);
    const page = res.json<Page>();
    pages.push(page.items);
    next = page.nextCursor;
  } while (next && pages.length < 20);
  return pages;
}

describe('GET /v1/tasks', () => {
  it('requires authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/tasks' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('paginates newest first with an opaque cursor, without gaps or repeats', async () => {
    const c = await newClient(h);
    const times = timeline(7);
    const ids: string[] = [];
    for (const [i, t] of times.entries())
      ids.push(await seedTask(h.db, c.user, { title: `Task ${i}`, createdAt: t }));
    // Two tasks in the same millisecond still paginate deterministically.
    const same = new Date(times[6]!.getTime() - 60_000);
    ids.push(await seedTask(h.db, c.user, { title: 'Twin A', createdAt: same }));
    ids.push(await seedTask(h.db, c.user, { title: 'Twin B', createdAt: same }));

    const pages = await allPages(c, '/v1/tasks?limit=3');
    expect(pages.map((p) => p.length)).toEqual([3, 3, 3]);
    const seen = pages.flat().map((t) => t.id);
    expect(new Set(seen).size).toBe(9);
    expect(seen.slice(0, 7)).toEqual(ids.slice(0, 7));
    expect(new Set(seen.slice(7))).toEqual(new Set(ids.slice(7)));
    const created = pages.flat().map((t) => t.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it('filters by status group', async () => {
    const c = await newClient(h);
    const byStatus = {
      QUEUED: await seedTask(h.db, c.user, { status: 'QUEUED' }),
      RUNNING: await seedTask(h.db, c.user, { status: 'RUNNING' }),
      AWAITING_APPROVAL: await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' }),
      COMPLETED: await seedTask(h.db, c.user, { status: 'COMPLETED' }),
      FAILED: await seedTask(h.db, c.user, { status: 'FAILED' }),
      CANCELLED: await seedTask(h.db, c.user, { status: 'CANCELLED' }),
      EXPIRED: await seedTask(h.db, c.user, { status: 'EXPIRED' }),
    };
    const ids = async (status: string) =>
      new Set(
        (await c.request('GET', `/v1/tasks?status=${status}`)).json<Page>().items.map((t) => t.id),
      );
    expect(await ids('active')).toEqual(
      new Set([byStatus.QUEUED, byStatus.RUNNING, byStatus.AWAITING_APPROVAL]),
    );
    expect(await ids('needs_approval')).toEqual(new Set([byStatus.AWAITING_APPROVAL]));
    expect(await ids('completed')).toEqual(new Set([byStatus.COMPLETED]));
    expect(await ids('failed')).toEqual(
      new Set([byStatus.FAILED, byStatus.CANCELLED, byStatus.EXPIRED]),
    );
    expect((await ids('all')).size).toBe(7);
  });

  it('rejects invalid filters, limits and tampered cursors', async () => {
    const c = await newClient(h);
    expect((await c.request('GET', '/v1/tasks?status=bogus')).statusCode).toBe(400);
    expect((await c.request('GET', '/v1/tasks?limit=0')).statusCode).toBe(400);
    expect((await c.request('GET', '/v1/tasks?limit=101')).statusCode).toBe(400);
    const bad = await c.request('GET', '/v1/tasks?cursor=not-a-cursor');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Invalid cursor',
    });
  });

  it('never lists another tenant’s tasks', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    await seedTask(h.db, alice.user, { title: 'Alice private' });
    const res = await bob.request('GET', '/v1/tasks');
    expect(res.json<Page>().items).toEqual([]);
  });
});

describe('GET /v1/tasks/:id', () => {
  it('returns the full detail with steps, approvals and events', async () => {
    const c = await newClient(h);
    const taskId = await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' });
    const approval = await seedApproval(h.db, c.user, taskId);
    await withContext(h.db, c.user, (trx) =>
      appendEvent(trx, c.user, {
        taskId,
        type: 'approval.requested',
        data: { approvalId: approval.id },
      }),
    );
    const res = await c.request('GET', `/v1/tasks/${taskId}`);
    expect(res.statusCode).toBe(200);
    const d = res.json<TaskDetail>();
    expect(d.id).toBe(taskId);
    expect(d.pendingApprovalId).toBe(approval.id);
    expect(d.steps).toHaveLength(1);
    expect(d.approvals.map((a) => a.id)).toEqual([approval.id]);
    expect(d.events.map((e) => e.type)).toEqual(['approval.requested']);
    expect(d.canCancel).toBe(true);
    expect(d.canRetry).toBe(false);
  });

  it('is NOT_FOUND for another tenant’s task and for malformed ids', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const taskId = await seedTask(h.db, alice.user, { title: 'Alice private' });
    const res = await bob.request('GET', `/v1/tasks/${taskId}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('Alice private');
    expect((await bob.request('GET', '/v1/tasks/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('POST /v1/tasks', () => {
  it('creates via the agent service and returns 202', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/tasks', { request: 'Summarize example.com' });
    expect(res.statusCode).toBe(202);
    const t = res.json<TaskSummary>();
    expect(t).toMatchObject({ request: 'Summarize example.com', status: 'QUEUED', source: 'text' });
    const call = h.fake.calls.create.at(-1)!;
    expect(call.ctx).toMatchObject({ tenantId: c.user.tenantId, userId: c.user.userId });
    expect(call.opts.idempotencyKey).toBeUndefined();
  });

  it('validates the body', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/tasks', { request: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect((await c.request('POST', '/v1/tasks', { request: 'x'.repeat(4001) })).statusCode).toBe(
      400,
    );
  });

  it('replays the same response for a repeated Idempotency-Key', async () => {
    const c = await newClient(h);
    const key = 'create-key-0001';
    const first = await c.request(
      'POST',
      '/v1/tasks',
      { request: 'Email me the news' },
      { 'idempotency-key': key },
    );
    expect(first.statusCode).toBe(202);
    const before = h.fake.calls.create.length;
    const second = await c.request(
      'POST',
      '/v1/tasks',
      { request: 'Email me the news' },
      { 'idempotency-key': key },
    );
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    // The replay never reached the agent.
    expect(h.fake.calls.create.length).toBe(before);
    const list = await c.request('GET', '/v1/tasks');
    expect(list.json<Page>().items).toHaveLength(1);
    expect(h.fake.calls.create.at(-1)!.opts.idempotencyKey).toBe(key);
  });

  it('rejects reuse of an Idempotency-Key with a different body', async () => {
    const c = await newClient(h);
    const key = 'create-key-0002';
    await c.request('POST', '/v1/tasks', { request: 'First' }, { 'idempotency-key': key });
    const res = await c.request(
      'POST',
      '/v1/tasks',
      { request: 'Second' },
      { 'idempotency-key': key },
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('keeps Idempotency-Keys per user', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const key = 'shared-key-0003';
    const a = await alice.request(
      'POST',
      '/v1/tasks',
      { request: 'A' },
      { 'idempotency-key': key },
    );
    const b = await bob.request('POST', '/v1/tasks', { request: 'B' }, { 'idempotency-key': key });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json<TaskSummary>().request).toBe('B');
  });

  it('rejects an out-of-range Idempotency-Key', async () => {
    const c = await newClient(h);
    const res = await c.request(
      'POST',
      '/v1/tasks',
      { request: 'x' },
      { 'idempotency-key': 'short' },
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('cookie sessions (web)', () => {
  it('blocks cross-site mutations and allows them from the web origin', async () => {
    const user = await createTestUser(h.db);
    const cookie = await loginWeb(h.app, user);
    const noOrigin = await h.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      cookies: { jarvis_session: cookie },
      payload: { request: 'csrf attempt' },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error.code).toBe('FORBIDDEN');
    const evil = await h.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      cookies: { jarvis_session: cookie },
      headers: { origin: 'https://evil.example' },
      payload: { request: 'csrf attempt' },
    });
    expect(evil.statusCode).toBe(403);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      cookies: { jarvis_session: cookie },
      headers: { origin: WEB_ORIGIN },
      payload: { request: 'legit' },
    });
    expect(ok.statusCode).toBe(202);
    // Reads need no Origin.
    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/tasks',
      cookies: { jarvis_session: cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<Page>().items.map((t) => t.request)).toEqual(['legit']);
  });
});

describe('cancel / retry', () => {
  it('cancels through the agent service', async () => {
    const c = await newClient(h);
    const id = await seedTask(h.db, c.user, { status: 'RUNNING' });
    const res = await c.request('POST', `/v1/tasks/${id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json<TaskSummary>().status).toBe('CANCELLED');
    const again = await c.request('POST', `/v1/tasks/${id}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVALID_STATE');
  });

  it('retries with the acknowledgement flag (default false) and returns 202', async () => {
    const c = await newClient(h);
    const id = await seedTask(h.db, c.user, { status: 'FAILED' });
    const res = await c.request('POST', `/v1/tasks/${id}/retry`, {});
    expect(res.statusCode).toBe(202);
    expect(res.json<TaskSummary>().status).toBe('QUEUED');
    expect(h.fake.calls.retry.at(-1)).toEqual({ taskId: id, acknowledgeUnknownOutcome: false });
    const id2 = await seedTask(h.db, c.user, { status: 'EXPIRED' });
    await c.request('POST', `/v1/tasks/${id2}/retry`, { acknowledgeUnknownOutcome: true });
    expect(h.fake.calls.retry.at(-1)).toEqual({ taskId: id2, acknowledgeUnknownOutcome: true });
  });

  it('cannot cancel or retry another tenant’s task', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const running = await seedTask(h.db, alice.user, { status: 'RUNNING' });
    const failed = await seedTask(h.db, alice.user, { status: 'FAILED' });
    expect((await bob.request('POST', `/v1/tasks/${running}/cancel`)).statusCode).toBe(404);
    expect((await bob.request('POST', `/v1/tasks/${failed}/retry`, {})).statusCode).toBe(404);
  });
});
