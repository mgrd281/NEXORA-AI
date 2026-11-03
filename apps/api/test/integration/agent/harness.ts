/**
 * Shared setup for agent integration tests: real Postgres (RLS enforced), a
 * local fixture website, an in-process SMTP sink, the real AgentServices and
 * the worker's runOnce. Jobs are driven explicitly — no timers, no sleeps.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Preferences, TaskDetail } from '@jarvis/contracts';
import type { Config } from '../../../src/config';
import { withContext, type Db, type DbContext } from '../../../src/db/pool';
import type { SecretBox } from '../../../src/lib/crypto';
import { sealSecret } from '../../../src/modules/connections/smtp';
import { createAgentServices } from '../../../src/modules/agent/index';
import type { ModelAdapter } from '../../../src/modules/agent/models/adapter';
import { silentLogger, type RuntimeDeps } from '../../../src/modules/agent/runtime';
import { loadTaskDetail } from '../../../src/modules/tasks/mappers';
import type { AgentServices } from '../../../src/services';
import { runOnce, type WorkerDeps } from '../../../src/worker';
import { startFixtureSite, type FixtureSite } from '../../fixtures/http-site';
import { startSmtpSink, type SmtpSink } from '../../fixtures/smtp-sink';
import { TEST_OWNER_URL } from '../env';
import { createTestUser, testConfig, testDb, testSecrets, type TestUser } from '../helpers';

export const SENDER = 'jarvis@test.local';

export interface Harness {
  site: FixtureSite;
  smtp: SmtpSink;
  config: Config;
  db: Db;
  secrets: SecretBox;
  services: AgentServices;
  worker: WorkerDeps;
  close(): Promise<void>;
}

export async function createHarness(
  opts: {
    testHooks?: RuntimeDeps['testHooks'];
    env?: Record<string, string>;
    adapter?: ModelAdapter;
  } = {},
): Promise<Harness> {
  const site = await startFixtureSite();
  const smtp = await startSmtpSink();
  const config = testConfig({ FETCH_ALLOW_PRIVATE_HOSTS: `127.0.0.1:${site.port}`, ...opts.env });
  const db = testDb();
  const secrets = testSecrets(config);
  const services = createAgentServices({ config, db, secrets });
  const worker: WorkerDeps = {
    config,
    db,
    secrets,
    adapter: opts.adapter ?? null,
    log: silentLogger,
    workerId: `test-${randomUUID().slice(0, 8)}`,
    testHooks: opts.testHooks,
  };
  return {
    site,
    smtp,
    config,
    db,
    secrets,
    services,
    worker,
    async close() {
      await smtp.stop();
      await site.close();
      await db.destroy();
    },
  };
}

/** Processes due jobs until the queue is idle. */
export async function drain(worker: WorkerDeps, maxRounds = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await runOnce(worker);
    if (n === 0) return total;
    total += n;
  }
  throw new Error('job queue did not drain');
}

export async function newUser(db: Db, preferences?: Partial<Preferences>): Promise<TestUser> {
  return createTestUser(db, { preferences });
}

export async function connectWeb(db: Db, user: DbContext): Promise<void> {
  await withContext(db, user, (trx) =>
    trx
      .insertInto('connections')
      .values({
        tenant_id: user.tenantId,
        user_id: user.userId,
        provider: 'web',
        label: 'Web',
        status: 'active',
        permissions: ['web:read'],
      })
      .execute(),
  );
}

export async function connectSmtp(
  db: Db,
  secrets: SecretBox,
  user: DbContext,
  port: number,
): Promise<void> {
  await withContext(db, user, (trx) =>
    trx
      .insertInto('connections')
      .values({
        tenant_id: user.tenantId,
        user_id: user.userId,
        provider: 'smtp',
        label: 'Email',
        account_identifier: SENDER,
        status: 'active',
        permissions: ['email:send'],
        config: JSON.stringify({
          host: '127.0.0.1',
          port,
          security: 'none',
          fromAddress: SENDER,
          fromName: 'JARVIS',
        }),
        ...sealSecret(secrets, user.userId, 'smtp', {}),
      })
      .execute(),
  );
}

export async function detail(db: Db, user: DbContext, taskId: string): Promise<TaskDetail> {
  const d = await withContext(db, user, (trx) => loadTaskDetail(trx, taskId));
  if (!d) throw new Error(`task ${taskId} not visible`);
  return d;
}

export async function executions(db: Db, user: DbContext, taskId: string) {
  return withContext(db, user, (trx) =>
    trx
      .selectFrom('tool_executions')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('started_at')
      .execute(),
  );
}

/** Makes every queued job for a task due now (instead of waiting for backoff). */
export async function makeJobsDue(db: Db, taskId: string): Promise<void> {
  await db
    .updateTable('jobs')
    .set({ run_at: new Date(0) })
    .where('task_id', '=', taskId)
    .where('status', '=', 'queued')
    .execute();
}

/** Audit actions for a user, read with the owner role (the app role cannot SELECT audit_events). */
export async function auditActions(userId: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try {
    const r = await c.query<{ action: string }>(
      'SELECT action FROM audit_events WHERE actor_id = $1 ORDER BY id',
      [userId],
    );
    return r.rows.map((x) => x.action);
  } finally {
    await c.end();
  }
}

/** Audit metadata for one action (owner role). */
export async function auditMetadata(
  userId: string,
  action: string,
): Promise<Record<string, unknown>[]> {
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try {
    const r = await c.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM audit_events WHERE actor_id = $1 AND action = $2 ORDER BY id',
      [userId, action],
    );
    return r.rows.map((x) => x.metadata);
  } finally {
    await c.end();
  }
}
