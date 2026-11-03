import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Approval } from '@jarvis/contracts';
import {
  createHarness,
  newClient,
  seedApproval,
  seedTask,
  timeline,
  type Harness,
} from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('GET /v1/approvals', () => {
  it('lists only PENDING approvals, newest first, with the task title', async () => {
    const c = await newClient(h);
    const [t1, t2, t3] = timeline(3);
    const taskA = await seedTask(h.db, c.user, {
      title: 'Send report',
      status: 'AWAITING_APPROVAL',
    });
    const taskB = await seedTask(h.db, c.user, {
      title: 'Send digest',
      status: 'AWAITING_APPROVAL',
    });
    const older = await seedApproval(h.db, c.user, taskA, { createdAt: t3 });
    const newer = await seedApproval(h.db, c.user, taskB, { createdAt: t1 });
    await seedApproval(h.db, c.user, taskA, { status: 'APPROVED', createdAt: t2, position: 1 });

    const res = await c.request('GET', '/v1/approvals');
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Approval[] }>().items;
    expect(items.map((a) => a.id)).toEqual([newer.id, older.id]);
    expect(items[0]).toMatchObject({
      taskId: taskB,
      taskTitle: 'Send digest',
      status: 'PENDING',
      toolId: 'email.send',
      actionHash: newer.actionHash,
      details: { kind: 'email', to: ['me@example.com'] },
    });
  });

  it('never shows another tenant’s approvals', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const task = await seedTask(h.db, alice.user, { status: 'AWAITING_APPROVAL' });
    await seedApproval(h.db, alice.user, task);
    const res = await bob.request('GET', '/v1/approvals');
    expect(res.json<{ items: Approval[] }>().items).toEqual([]);
  });
});

describe('POST /v1/approvals/:id/decision', () => {
  it('passes the decision and the session platform to the approval service', async () => {
    const c = await newClient(h);
    const task = await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' });
    const a = await seedApproval(h.db, c.user, task);
    const res = await c.request('POST', `/v1/approvals/${a.id}/decision`, {
      decision: 'approve',
      actionHash: a.actionHash,
      note: 'looks right',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Approval>()).toMatchObject({
      id: a.id,
      status: 'APPROVED',
      decisionNote: 'looks right',
    });
    expect(h.fake.calls.decide.at(-1)).toEqual({
      approvalId: a.id,
      decision: 'approve',
      channel: 'ios',
    });
    const pending = await c.request('GET', '/v1/approvals');
    expect(pending.json<{ items: Approval[] }>().items).toEqual([]);
  });

  it('validates the body and surfaces service errors', async () => {
    const c = await newClient(h);
    const task = await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' });
    const a = await seedApproval(h.db, c.user, task);
    const bad = await c.request('POST', `/v1/approvals/${a.id}/decision`, {
      decision: 'maybe',
      actionHash: a.actionHash,
    });
    expect(bad.statusCode).toBe(400);
    const mismatch = await c.request('POST', `/v1/approvals/${a.id}/decision`, {
      decision: 'approve',
      actionHash: 'x'.repeat(32),
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('APPROVAL_MISMATCH');
  });

  it('replays an idempotent decision', async () => {
    const c = await newClient(h);
    const task = await seedTask(h.db, c.user, { status: 'AWAITING_APPROVAL' });
    const a = await seedApproval(h.db, c.user, task);
    const body = { decision: 'reject', actionHash: a.actionHash };
    const headers = { 'idempotency-key': `decide-${a.id}` };
    const first = await c.request('POST', `/v1/approvals/${a.id}/decision`, body, headers);
    const second = await c.request('POST', `/v1/approvals/${a.id}/decision`, body, headers);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('is NOT_FOUND for another tenant’s approval', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const task = await seedTask(h.db, alice.user, { status: 'AWAITING_APPROVAL' });
    const a = await seedApproval(h.db, alice.user, task);
    const res = await bob.request('POST', `/v1/approvals/${a.id}/decision`, {
      decision: 'approve',
      actionHash: a.actionHash,
    });
    expect(res.statusCode).toBe(404);
    const still = await alice.request('GET', '/v1/approvals');
    expect(still.json<{ items: Approval[] }>().items.map((x) => x.status)).toEqual(['PENDING']);
  });
});
