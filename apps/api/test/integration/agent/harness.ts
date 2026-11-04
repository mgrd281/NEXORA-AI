/**
 * Shared setup for agent integration tests: real Postgres (RLS enforced), a
 * local fixture website, an in-process SMTP sink, the real AgentServices and
 * the worker's runOnce. Jobs are driven explicitly — no timers, no sleeps.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { Preferences, TaskDetail } from '@jarvis/contracts';
import type { Config } from '../../../src/config';
import { withContext, type Db, type DbContext } from '../../../src/db/pool';
import type { SecretBox } from '../../../src/lib/crypto';
import { sealSecret } from '../../../src/modules/connections/smtp';
import { createAgentServices } from '../../../src/modules/agent/index';
import type { ModelAdapter } from '../../../src/modules/agent/models/adapter';
import { silentLogger, type RuntimeDeps } from '../../../src/modules/agent/runtime';
import { createLocalStorage } from '../../../src/modules/storage/local';
import type { ObjectStorage } from '../../../src/modules/storage/types';
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
  /** Attachment storage (a temporary local directory unless one was passed). */
  storage: ObjectStorage | null;
  close(): Promise<void>;
}

export async function createHarness(
  opts: {
    testHooks?: RuntimeDeps['testHooks'];
    env?: Record<string, string>;
    adapter?: ModelAdapter;
    /** null: no storage configured (STORAGE_DRIVER=none). Default: a temporary local directory. */
    storage?: ObjectStorage | null;
    /** The worker's clock for scheduler/retention jobs (default: the system clock). */
    now?: () => Date;
  } = {},
): Promise<Harness> {
  const site = await startFixtureSite();
  const smtp = await startSmtpSink();
  const config = testConfig({ FETCH_ALLOW_PRIVATE_HOSTS: `127.0.0.1:${site.port}`, ...opts.env });
  const db = testDb();
  const secrets = testSecrets(config);
  let storageDir: string | null = null;
  let storage: ObjectStorage | null;
  if (opts.storage !== undefined) storage = opts.storage;
  else {
    storageDir = await mkdtemp(path.join(tmpdir(), 'jarvis-storage-'));
    storage = createLocalStorage(storageDir);
  }
  const services = createAgentServices({ config, db, secrets, storage });
  const worker: WorkerDeps = {
    config,
    db,
    secrets,
    adapter: opts.adapter ?? null,
    storage,
    log: silentLogger,
    workerId: `test-${randomUUID().slice(0, 8)}`,
    testHooks: opts.testHooks,
    now: opts.now,
  };
  return {
    site,
    smtp,
    config,
    db,
    secrets,
    services,
    worker,
    storage,
    async close() {
      await smtp.stop();
      await site.close();
      await db.destroy();
      if (storageDir) await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** A second worker on the same database (concurrency tests). */
export function secondWorker(h: Harness, overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return { ...h.worker, workerId: `test-${randomUUID().slice(0, 8)}`, ...overrides };
}

/** Makes every queued job due now (retries and scheduled attempts included). */
export async function makeAllJobsDue(db: Db): Promise<void> {
  await db
    .updateTable('jobs')
    .set({ run_at: new Date(0) })
    .where('status', '=', 'queued')
    .execute();
}

/**
 * Stores a file as an upload would (storage + attachments row, unattached),
 * bypassing the HTTP layer. Returns the attachment id.
 */
export async function storeAttachment(
  h: Harness,
  user: DbContext,
  file: { filename: string; mediaType: string; body: Buffer },
): Promise<string> {
  if (!h.storage) throw new Error('no storage configured');
  const id = randomUUID();
  const key = `tenants/${user.tenantId}/users/${user.userId}/attachments/${id}`;
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(file.body).digest('hex');
  await h.storage.put(key, { body: file.body, contentType: file.mediaType, sha256 });
  await withContext(h.db, user, (trx) =>
    trx
      .insertInto('attachments')
      .values({
        id,
        tenant_id: user.tenantId,
        user_id: user.userId,
        conversation_id: null,
        filename: file.filename,
        media_type: file.mediaType as never,
        size_bytes: file.body.length,
        sha256,
        storage_driver: h.storage!.driver,
        storage_key: key,
        expires_at: new Date(Date.now() + 24 * 3_600_000),
      })
      .execute(),
  );
  return id;
}

/** Runs a query as the owner role (bypasses RLS; for test setup and inspection only). */
export async function asOwner<T extends pg.QueryResultRow>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try {
    return (await c.query<T>(query, params)).rows;
  } finally {
    await c.end();
  }
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
