import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantStatus, HomeSnapshot, UsageSummary } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import {
  createHarness,
  MODEL_STATUS,
  newClient,
  OFFLINE_STATUS,
  seedApproval,
  seedConnection,
  seedNotification,
  seedTask,
  timeline,
  type Harness,
} from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('GET /v1/home', () => {
  it('assembles approvals, active and recent work, unread count and suggestions', async () => {
    h.fake.setStatus(OFFLINE_STATUS);
    const c = await newClient(h);
    const times = timeline(8);
    const active: string[] = [];
    for (let i = 0; i < 6; i++)
      active.push(
        await seedTask(h.db, c.user, { status: i % 2 ? 'RUNNING' : 'QUEUED', updatedAt: times[i] }),
      );
    const done = await seedTask(h.db, c.user, { status: 'COMPLETED', updatedAt: times[6] });
    const failed = await seedTask(h.db, c.user, { status: 'FAILED', updatedAt: times[7] });
    const waiting = await seedTask(h.db, c.user, {
      status: 'AWAITING_APPROVAL',
      updatedAt: new Date(Date.now() - 3_600_000),
    });
    const approval = await seedApproval(h.db, c.user, waiting);
    await seedNotification(h.db, c.user);
    await seedNotification(h.db, c.user);
    await seedNotification(h.db, c.user, { read: true });

    const res = await c.request('GET', '/v1/home');
    expect(res.statusCode).toBe(200);
    const home = res.json<HomeSnapshot>();
    expect(home.assistant).toEqual(OFFLINE_STATUS);
    expect(home.pendingApprovals.map((a) => a.id)).toEqual([approval.id]);
    // Five most recently updated active tasks (the AWAITING_APPROVAL one is oldest).
    expect(home.activeTasks.map((t) => t.id)).toEqual(active.slice(0, 5));
    expect(home.recentTasks.map((t) => t.id)).toEqual([done, failed]);
    expect(home.unreadNotifications).toBe(2);
    expect(home.suggestions.map((s) => s.messageKey)).toEqual([
      'suggest.enableWeb',
      'suggest.connectEmail',
      'suggest.configureModel',
    ]);
    expect(home.suggestions[0]).toEqual({
      id: 'connect-web',
      kind: 'connect',
      messageKey: 'suggest.enableWeb',
      command: null,
      href: '/connections',
    });
  });

  it('suggests commands once web and email work and the planner is online', async () => {
    h.fake.setStatus(MODEL_STATUS);
    const c = await newClient(h);
    await seedConnection(h.db, c.user, 'web');
    await seedConnection(h.db, c.user, 'smtp');
    const res = await c.request('GET', '/v1/home');
    expect(res.json<HomeSnapshot>().suggestions.map((s) => s.messageKey)).toEqual([
      'suggest.summarizeAndEmail',
      'suggest.remember',
    ]);
    // A stored memory removes the "remember" suggestion.
    await c.request('POST', '/v1/memories', { content: 'I prefer short summaries' });
    const after = await c.request('GET', '/v1/home');
    expect(after.json<HomeSnapshot>().suggestions.map((s) => s.messageKey)).toEqual([
      'suggest.summarizeAndEmail',
    ]);
  });

  it('treats a failing mailbox as not connected and respects the memory switch', async () => {
    h.fake.setStatus(MODEL_STATUS);
    const c = await newClient(h, { preferences: { memory: { enabled: false } } });
    await seedConnection(h.db, c.user, 'web');
    await seedConnection(h.db, c.user, 'smtp', 'error');
    const res = await c.request('GET', '/v1/home');
    expect(res.json<HomeSnapshot>().suggestions.map((s) => s.messageKey)).toEqual([
      'suggest.connectEmail',
    ]);
  });

  it('never includes another tenant’s data', async () => {
    h.fake.setStatus(OFFLINE_STATUS);
    const alice = await newClient(h);
    const bob = await newClient(h);
    const t = await seedTask(h.db, alice.user, { status: 'AWAITING_APPROVAL' });
    await seedApproval(h.db, alice.user, t);
    await seedTask(h.db, alice.user, { status: 'COMPLETED' });
    await seedNotification(h.db, alice.user);
    const home = (await bob.request('GET', '/v1/home')).json<HomeSnapshot>();
    expect(home.pendingApprovals).toEqual([]);
    expect(home.activeTasks).toEqual([]);
    expect(home.recentTasks).toEqual([]);
    expect(home.unreadNotifications).toBe(0);
  });
});

describe('GET /v1/assistant/status', () => {
  it('returns the agent’s real status', async () => {
    const status: AssistantStatus = { ...MODEL_STATUS, version: '9.9.9' };
    h.fake.setStatus(status);
    const c = await newClient(h);
    const res = await c.request('GET', '/v1/assistant/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(status);
  });
});

describe('GET /v1/usage', () => {
  async function seedCost(
    ctx: { tenantId: string; userId: string },
    category: 'model' | 'tool' | 'telephony',
    amount: number,
    at: Date,
  ) {
    await withContext(h.db, ctx, (trx) =>
      trx
        .insertInto('cost_records')
        .values({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          category,
          amount_micro: amount,
          created_at: at,
        })
        .execute(),
    );
  }

  it('sums this calendar month in the user’s time zone and reports the budget', async () => {
    const c = await newClient(h, {
      preferences: {
        spending: { monthlyAiBudgetUsd: 12.5 },
      },
    });
    const tz = 'Pacific/Kiritimati'; // UTC+14: month boundaries differ from UTC
    await withContext(h.db, c.user, (trx) =>
      trx.updateTable('users').set({ time_zone: tz }).where('id', '=', c.user.userId).execute(),
    );
    const first = await c.request('GET', '/v1/usage');
    expect(first.statusCode).toBe(200);
    const period = first.json<UsageSummary>();
    const start = new Date(period.periodStart);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(start);
    const part = (t: string) => Number(local.find((p) => p.type === t)!.value);
    expect([part('day'), part('hour'), part('minute')]).toEqual([1, 0, 0]);
    expect(new Date(period.periodEnd).getTime()).toBeGreaterThan(Date.now());
    expect(start.getTime()).toBeLessThanOrEqual(Date.now());
    expect(period).toMatchObject({
      aiMicroUsd: 0,
      toolMicroUsd: 0,
      totalMicroUsd: 0,
      budgetMicroUsd: 12_500_000,
    });

    await seedCost(c.user, 'model', 1_500, new Date(start.getTime() + 60_000));
    await seedCost(c.user, 'model', 2_500, new Date());
    await seedCost(c.user, 'tool', 700, new Date());
    await seedCost(c.user, 'telephony', 300, new Date());
    await seedCost(c.user, 'model', 99_999, new Date(start.getTime() - 60_000)); // last month
    await seedTask(h.db, c.user, { status: 'COMPLETED' });
    await seedTask(h.db, c.user, { status: 'COMPLETED' });
    await seedTask(h.db, c.user, { status: 'FAILED' });
    await seedTask(h.db, c.user, { status: 'RUNNING' });
    await seedTask(h.db, c.user, { status: 'COMPLETED', createdAt: new Date(start.getTime() - 1) });

    const usage = (await c.request('GET', '/v1/usage')).json<UsageSummary>();
    expect(usage).toMatchObject({
      aiMicroUsd: 4_000,
      toolMicroUsd: 700,
      totalMicroUsd: 5_000,
      budgetMicroUsd: 12_500_000,
      tasks: { completed: 2, failed: 1, total: 4 },
    });
  });

  it('only counts the caller’s own costs', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    await seedCost(alice.user, 'model', 123_456, new Date());
    const usage = (await bob.request('GET', '/v1/usage')).json<UsageSummary>();
    expect(usage.totalMicroUsd).toBe(0);
    expect(usage.budgetMicroUsd).toBe(20_000_000);
  });
});
