/**
 * Shared harness for HTTP integration tests: a real Fastify app (real auth,
 * RLS, idempotency and contract validation) over the test database, with a
 * small in-test AgentServices so these tests do not depend on the agent
 * runtime. Read endpoints are exercised against rows seeded through RLS.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { canCancel, canRetry, type AssistantStatus, type TaskStatus } from '@jarvis/contracts';
import type { Config } from '../../../src/config';
import { withContext, type Db, type DbContext } from '../../../src/db/pool';
import { buildApp } from '../../../src/http/app';
import { AppError, notFound } from '../../../src/lib/errors';
import { appendEvent } from '../../../src/modules/events/events';
import {
  approvalQuery,
  taskSummaryQuery,
  toApproval,
  toTaskSummary,
  type TaskAggregate,
} from '../../../src/modules/tasks/mappers';
import { registerRoutes } from '../../../src/routes';
import type { AgentServices, AppDeps } from '../../../src/services';
import { createTestUser, testConfig, testDb, testSecrets, type TestUser } from '../helpers';

export const WEB_ORIGIN = 'http://localhost:3000';

export const OFFLINE_STATUS: AssistantStatus = {
  planner: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
  worker: { healthy: false, lastHeartbeatAt: null },
  capabilities: { webFetch: false, email: false, memory: true, generalQuestions: false },
  version: 'test',
};

export const MODEL_STATUS: AssistantStatus = {
  planner: { mode: 'model', provider: 'anthropic', reason: null },
  worker: { healthy: true, lastHeartbeatAt: new Date().toISOString() },
  capabilities: { webFetch: true, email: true, memory: true, generalQuestions: true },
  version: 'test',
};

async function loadSummary(db: Db, ctx: DbContext, taskId: string) {
  return withContext(db, ctx, async (trx) => {
    const row = await taskSummaryQuery(trx).where('t.id', '=', taskId).executeTakeFirst();
    if (!row) throw notFound('Task');
    return toTaskSummary(row as TaskAggregate);
  });
}

/** Minimal stand-in for the agent runtime with the same observable contract. */
export function createFakeAgent(db: Db) {
  const calls = {
    create: [] as { ctx: DbContext; input: unknown; opts: { idempotencyKey?: string } }[],
    cancel: [] as string[],
    retry: [] as { taskId: string; acknowledgeUnknownOutcome: boolean }[],
    decide: [] as { approvalId: string; decision: string; channel: string }[],
  };
  const state = { status: OFFLINE_STATUS as AssistantStatus };

  const agent: AgentServices = {
    tasks: {
      async create(ctx, input, opts) {
        calls.create.push({ ctx, input, opts });
        const id = await withContext(db, ctx, async (trx) => {
          if (opts.idempotencyKey) {
            const existing = await trx
              .selectFrom('tasks')
              .select('id')
              .where('idempotency_key', '=', opts.idempotencyKey)
              .executeTakeFirst();
            if (existing) return existing.id;
          }
          const conv = await trx
            .insertInto('conversations')
            .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, title: input.request })
            .returning('id')
            .executeTakeFirstOrThrow();
          const task = await trx
            .insertInto('tasks')
            .values({
              tenant_id: ctx.tenantId,
              user_id: ctx.userId,
              conversation_id: conv.id,
              title: input.request.slice(0, 80),
              request: input.request,
              source: input.source,
              language: input.language ?? null,
              idempotency_key: opts.idempotencyKey ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('messages')
            .values({
              tenant_id: ctx.tenantId,
              user_id: ctx.userId,
              conversation_id: conv.id,
              task_id: task.id,
              role: 'user',
              content: input.request,
            })
            .execute();
          await appendEvent(trx, ctx, {
            taskId: task.id,
            type: 'task.created',
            data: { status: 'QUEUED' },
          });
          return task.id;
        });
        return loadSummary(db, ctx, id);
      },
      async cancel(ctx, taskId) {
        calls.cancel.push(taskId);
        await withContext(db, ctx, async (trx) => {
          const t = await trx
            .selectFrom('tasks')
            .select('status')
            .where('id', '=', taskId)
            .executeTakeFirst();
          if (!t) throw notFound('Task');
          if (!canCancel(t.status)) throw new AppError('INVALID_STATE', 'Task cannot be cancelled');
          await trx
            .updateTable('tasks')
            .set({ status: 'CANCELLED', completed_at: new Date() })
            .where('id', '=', taskId)
            .execute();
        });
        return loadSummary(db, ctx, taskId);
      },
      async retry(ctx, taskId, opts) {
        calls.retry.push({ taskId, ...opts });
        await withContext(db, ctx, async (trx) => {
          const t = await trx
            .selectFrom('tasks')
            .select('status')
            .where('id', '=', taskId)
            .executeTakeFirst();
          if (!t) throw notFound('Task');
          if (!canRetry(t.status)) throw new AppError('INVALID_STATE', 'Task cannot be retried');
          await trx
            .updateTable('tasks')
            .set({ status: 'QUEUED', error: null, completed_at: null })
            .where('id', '=', taskId)
            .execute();
        });
        return loadSummary(db, ctx, taskId);
      },
    },
    approvals: {
      async decide(ctx, approvalId, input, channel) {
        calls.decide.push({ approvalId, decision: input.decision, channel });
        return withContext(db, ctx, async (trx) => {
          const a = await approvalQuery(trx).where('a.id', '=', approvalId).executeTakeFirst();
          if (!a) throw notFound('Approval');
          if (a.status !== 'PENDING') throw new AppError('INVALID_STATE', 'Already decided');
          if (a.action_hash !== input.actionHash)
            throw new AppError('APPROVAL_MISMATCH', 'The action changed');
          await trx
            .updateTable('approvals')
            .set({
              status: input.decision === 'approve' ? 'APPROVED' : 'REJECTED',
              decided_at: new Date(),
              decision_note: input.note ?? null,
              decision_channel: channel,
            })
            .where('id', '=', approvalId)
            .execute();
          const updated = await approvalQuery(trx)
            .where('a.id', '=', approvalId)
            .executeTakeFirstOrThrow();
          return toApproval(updated);
        });
      },
    },
    status: {
      async get() {
        return state.status;
      },
    },
  };
  return {
    agent,
    calls,
    setStatus(s: AssistantStatus) {
      state.status = s;
    },
  };
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: Config;
  fake: ReturnType<typeof createFakeAgent>;
  close(): Promise<void>;
}

export async function createHarness(
  opts: { env?: Record<string, string>; listen?: AppDeps['listen'] } = {},
): Promise<Harness> {
  const config = testConfig(opts.env);
  const db = testDb();
  const fake = createFakeAgent(db);
  const app = await buildApp(
    {
      config,
      db,
      secrets: testSecrets(config),
      agent: fake.agent,
      listen: opts.listen ?? (async () => async () => {}),
    },
    registerRoutes,
  );
  await app.ready();
  return {
    app,
    db,
    config,
    fake,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}

// Every login comes from its own address so the per-IP login rate limit
// (10/min) never trips across a test file.
let addressSeq = 0;
function nextAddress(): string {
  addressSeq += 1;
  return `10.77.${Math.floor(addressSeq / 250) % 250}.${(addressSeq % 250) + 1}`;
}

/** Real sign-in through POST /v1/auth/login as a native client; returns the bearer token. */
export async function login(app: FastifyInstance, user: TestUser): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email: user.email, password: user.password, platform: 'ios', deviceName: 'Test' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const token = res.json<{ token?: string }>().token;
  if (!token) throw new Error('login returned no token');
  return token;
}

/** Real sign-in as the web client; returns the httpOnly session cookie value. */
export async function loginWeb(app: FastifyInstance, user: TestUser): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email: user.email, password: user.password, platform: 'web' },
  });
  if (res.statusCode !== 200) throw new Error(`web login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'jarvis_session');
  if (!cookie) throw new Error('web login set no session cookie');
  return cookie.value;
}

export interface Client {
  user: TestUser;
  token: string;
  request(
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
}

/** A fresh tenant + user, signed in. */
export async function newClient(
  h: Harness,
  opts: Parameters<typeof createTestUser>[1] = {},
): Promise<Client> {
  const user = await createTestUser(h.db, opts);
  const token = await login(h.app, user);
  return {
    user,
    token,
    request: (method, url, payload, headers = {}) =>
      h.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, ...headers },
        ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
      }),
  };
}

/* ------------------------------------------------------------------ */
/* Seeding (through RLS, as the owning user)                           */
/* ------------------------------------------------------------------ */

export async function seedTask(
  db: Db,
  ctx: DbContext,
  opts: {
    status?: TaskStatus;
    title?: string;
    request?: string;
    createdAt?: Date;
    updatedAt?: Date;
  } = {},
): Promise<string> {
  return withContext(db, ctx, async (trx) => {
    const conv = await trx
      .insertInto('conversations')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const createdAt = opts.createdAt ?? new Date();
    const t = await trx
      .insertInto('tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        conversation_id: conv.id,
        title: opts.title ?? 'Seeded task',
        request: opts.request ?? 'seeded request',
        source: 'text',
        status: opts.status ?? 'QUEUED',
        created_at: createdAt,
        updated_at: opts.updatedAt ?? createdAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return t.id;
  });
}

export async function seedApproval(
  db: Db,
  ctx: DbContext,
  taskId: string,
  opts: { status?: 'PENDING' | 'APPROVED'; createdAt?: Date; position?: number } = {},
): Promise<{ id: string; actionHash: string }> {
  return withContext(db, ctx, async (trx) => {
    const position = opts.position ?? 0;
    const step = await trx
      .insertInto('task_steps')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: taskId,
        position,
        step_key: `s${position}`,
        title: 'Send the summary',
        tool_id: 'email.send',
        input: JSON.stringify({ to: ['me@example.com'] }),
        input_preview: JSON.stringify({ to: ['me@example.com'] }),
        risk_level: 'MEDIUM',
        requires_approval: true,
        status: 'AWAITING_APPROVAL',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const actionHash = `hash-${step.id}`;
    const a = await trx
      .insertInto('approvals')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: taskId,
        step_id: step.id,
        tool_id: 'email.send',
        status: opts.status ?? 'PENDING',
        risk_level: 'MEDIUM',
        summary: 'Send an email to me@example.com',
        details: JSON.stringify({
          kind: 'email',
          from: 'jarvis@example.com',
          to: ['me@example.com'],
          subject: 'Summary',
          body: 'Hello',
        }),
        action_hash: actionHash,
        reasons: ['RISK_MEDIUM'],
        expires_at: new Date(Date.now() + 86_400_000),
        created_at: opts.createdAt ?? new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: a.id, actionHash };
  });
}

export async function seedConnection(
  db: Db,
  ctx: DbContext,
  provider: 'web' | 'smtp',
  status: 'active' | 'error' = 'active',
): Promise<string> {
  return withContext(db, ctx, async (trx) => {
    const row = await trx
      .insertInto('connections')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        provider,
        label: provider === 'web' ? 'Web access' : 'Email',
        account_identifier: provider === 'smtp' ? 'me@example.com' : null,
        permissions: [provider === 'web' ? 'web.fetch' : 'email.send'],
        status,
        config: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

export async function seedNotification(
  db: Db,
  ctx: DbContext,
  opts: { createdAt?: Date; read?: boolean; taskId?: string | null } = {},
): Promise<string> {
  return withContext(db, ctx, async (trx) => {
    const row = await trx
      .insertInto('notifications')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        kind: 'task_completed',
        task_id: opts.taskId ?? null,
        data: JSON.stringify({ taskTitle: 'Seeded task' }),
        read_at: opts.read ? new Date() : null,
        created_at: opts.createdAt ?? new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** Distinct, strictly decreasing timestamps (newest first) for deterministic ordering. */
export function timeline(count: number, stepMs = 60_000, from = Date.now()): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(from - i * stepMs));
}
