import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminOverview, AdminUser, AuditEvent } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { heartbeat } from '../../../src/modules/jobs/queue';
import {
  createHarness,
  MODEL_STATUS,
  newClient,
  seedTask,
  type Client,
  type Harness,
} from './support';

const SECRET_REQUEST = 'TOP-SECRET-REQUEST-TEXT-4711';
const SECRET_TITLE = 'Confidential-title-0815';

let h: Harness;
let admin: Client;
let member: Client;

beforeAll(async () => {
  h = await createHarness();
  h.fake.setStatus(MODEL_STATUS);
  admin = await newClient(h, { admin: true });
  member = await newClient(h);
  const taskId = await seedTask(h.db, member.user, {
    request: SECRET_REQUEST,
    title: SECRET_TITLE,
    status: 'COMPLETED',
  });
  await withContext(h.db, member.user, async (trx) => {
    await trx
      .insertInto('memories')
      .values({
        tenant_id: member.user.tenantId,
        user_id: member.user.userId,
        kind: 'fact',
        content: SECRET_REQUEST,
        source: 'user',
      })
      .execute();
    const step = await trx
      .insertInto('task_steps')
      .values({
        tenant_id: member.user.tenantId,
        user_id: member.user.userId,
        task_id: taskId,
        position: 0,
        step_key: 's0',
        title: SECRET_TITLE,
        tool_id: 'web.fetch',
        input: JSON.stringify({ url: 'https://example.com' }),
        risk_level: 'LOW',
        status: 'SUCCEEDED',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('tool_executions')
      .values({
        tenant_id: member.user.tenantId,
        user_id: member.user.userId,
        task_id: taskId,
        step_id: step.id,
        tool_id: 'web.fetch',
        tool_version: '1',
        idempotency_key: `exec-${step.id}`,
        status: 'succeeded',
        input_hash: 'h',
        output: JSON.stringify({ text: SECRET_REQUEST }),
        duration_ms: 120,
      })
      .execute();
    await trx
      .insertInto('cost_records')
      .values({
        tenant_id: member.user.tenantId,
        user_id: member.user.userId,
        task_id: taskId,
        category: 'model',
        amount_micro: 1000,
      })
      .execute();
  });
  await heartbeat(h.db, 'admin-test-worker', 'test-host', 'test');
});
afterAll(() => h.close());

describe('admin authorisation', () => {
  it('is forbidden for non-admins and requires authentication', async () => {
    for (const url of ['/v1/admin/overview', '/v1/admin/users', '/v1/admin/audit']) {
      const res = await member.request('GET', url);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });
});

describe('GET /v1/admin/overview', () => {
  it('returns health and aggregates only', async () => {
    const res = await admin.request('GET', '/v1/admin/overview');
    expect(res.statusCode).toBe(200);
    const o = res.json<AdminOverview>();
    expect(o.health.database).toBe(true);
    expect(o.health.worker.healthy).toBe(true);
    expect(o.health.planner).toEqual(MODEL_STATUS.planner);
    expect(o.users.total).toBeGreaterThanOrEqual(2);
    expect(o.tenants.total).toBeGreaterThanOrEqual(2);
    expect(o.tasksByStatus.COMPLETED).toBeGreaterThanOrEqual(1);
    expect(o.cost30dMicroUsd).toBeGreaterThanOrEqual(1000);
    expect(o.toolReliability).toContainEqual(
      expect.objectContaining({ toolId: 'web.fetch', executions: expect.any(Number) }),
    );
    expect(res.body).not.toContain(SECRET_REQUEST);
    expect(res.body).not.toContain(SECRET_TITLE);
  });
});

describe('GET /v1/admin/users', () => {
  it('pages through users newest first without content', async () => {
    const seen: AdminUser[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/admin/users?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await admin.request('GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SECRET_REQUEST);
      expect(res.body).not.toContain(SECRET_TITLE);
      const page: { items: AdminUser[]; nextCursor: string | null } = res.json();
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 3);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen.map((u) => u.id)).size).toBe(seen.length);
    const created = seen.map((u) => u.createdAt);
    expect([...created].sort().reverse()).toEqual(created);

    // The two users of this file are the newest ones.
    const first = (await admin.request('GET', '/v1/admin/users?limit=2')).json<{
      items: AdminUser[];
    }>();
    expect(first.items.map((u) => u.id)).toEqual([member.user.userId, admin.user.userId]);
    expect(first.items[0]).toMatchObject({
      email: member.user.email,
      roles: ['owner'],
      status: 'active',
      taskCount: 1,
    });
    expect(first.items[1]!.roles).toEqual(['owner', 'platform_admin']);
  });

  it('rejects malformed cursors', async () => {
    const res = await admin.request('GET', '/v1/admin/users?cursor=yesterday');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/admin/audit', () => {
  it('pages through the audit log by id without metadata', async () => {
    const first = await admin.request('GET', '/v1/admin/audit?limit=3');
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: AuditEvent[]; nextCursor: string | null }>();
    expect(page.items).toHaveLength(3);
    const ids = page.items.map((a) => Number(a.id));
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(page.nextCursor).toBe(String(ids[2]));
    expect(Object.keys(page.items[0]!).sort()).toEqual(
      ['action', 'actorId', 'actorType', 'at', 'id', 'targetId', 'targetType', 'tenantId'].sort(),
    );
    const second = await admin.request('GET', `/v1/admin/audit?limit=3&cursor=${page.nextCursor}`);
    const next = second.json<{ items: AuditEvent[] }>().items.map((a) => Number(a.id));
    expect(Math.max(...next)).toBeLessThan(ids[2]!);
    expect(second.body).not.toContain(SECRET_REQUEST);
  });

  it('records admin access in the audit log', async () => {
    await admin.request('GET', '/v1/admin/users?limit=1');
    const res = await admin.request('GET', '/v1/admin/audit?limit=5');
    expect(res.json<{ items: AuditEvent[] }>().items).toContainEqual(
      expect.objectContaining({
        action: 'admin.users_viewed',
        actorType: 'admin',
        actorId: admin.user.userId,
      }),
    );
  });

  it('rejects malformed cursors', async () => {
    expect((await admin.request('GET', '/v1/admin/audit?cursor=-1')).statusCode).toBe(400);
    expect((await admin.request('GET', '/v1/admin/audit?cursor=abc')).statusCode).toBe(400);
  });
});
