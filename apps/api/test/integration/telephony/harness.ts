/**
 * Integration harness of the phone agent: real Postgres (RLS), the real Fastify app listening
 * on a local port (the signature-validated webhook routes and the user routes), the mock Twilio
 * REST API + call simulator (tools/mock-twilio — it signs every webhook like Twilio and drives
 * the call against the app), the real AgentServices and the worker's runOnce. The webhook base
 * URL is the app's own origin, so every signature the app checks is computed over the URL the
 * simulator really requested.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Approval, Locale } from '@jarvis/contracts';
import { startMockTwilio, type MockTwilio } from '../../../../../tools/mock-twilio/index.mjs';
import type { Config } from '../../../src/config';
import { withContext, type Db, type DbContext } from '../../../src/db/pool';
import { buildApp } from '../../../src/http/app';
import type { SecretBox } from '../../../src/lib/crypto';
import { createAgentServices } from '../../../src/modules/agent/index';
import type { ModelAdapter } from '../../../src/modules/agent/models/adapter';
import { silentLogger } from '../../../src/modules/agent/runtime';
import { createLocalStorage } from '../../../src/modules/storage/local';
import type { ObjectStorage } from '../../../src/modules/storage/types';
import { approvalQuery, toApproval } from '../../../src/modules/tasks/mappers';
import { registerRoutes } from '../../../src/routes';
import type { AgentServices } from '../../../src/services';
import type { WorkerDeps } from '../../../src/worker';
import { detail, drain } from '../agent/harness';
import { createTestUser, testConfig, testDb, testSecrets, type TestUser } from '../helpers';
import { login } from '../http/support';

export const ACCOUNT_SID = `AC${'a1b2c3d4'.repeat(4)}`;
export const AUTH_TOKEN = 'mock-twilio-auth-token-for-tests';
/** This server's caller id (a German number: CALL_ALLOWED_COUNTRIES defaults to its country). */
export const CALLER_ID = '+4930901820';

export interface TelephonyHarness {
  mock: MockTwilio;
  app: FastifyInstance;
  /** The app's origin (PUBLIC_WEBHOOK_BASE_URL). */
  base: string;
  config: Config;
  db: Db;
  secrets: SecretBox;
  services: AgentServices;
  worker: WorkerDeps;
  storage: ObjectStorage;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function createTelephonyHarness(
  opts: {
    env?: Record<string, string>;
    adapter?: ModelAdapter;
    telephony?: boolean;
    testHooks?: WorkerDeps['testHooks'];
  } = {},
): Promise<TelephonyHarness> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const mock = await startMockTwilio({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    numbers: [CALLER_ID],
    stepMs: 2,
  });
  const config = testConfig({
    ...(opts.telephony === false
      ? {}
      : {
          TWILIO_ACCOUNT_SID: ACCOUNT_SID,
          TWILIO_AUTH_TOKEN: AUTH_TOKEN,
          TWILIO_FROM_NUMBER: CALLER_ID,
          TWILIO_BASE_URL_OVERRIDE: mock.url,
          PUBLIC_WEBHOOK_BASE_URL: base,
        }),
    // Tests run at any hour: the calling-hours rule is exercised with its own window.
    CALL_ALLOWED_HOURS: '00:00-23:59',
    CALL_ALLOWED_COUNTRIES: 'DE,GB,US,AE',
    CALL_PRICE_PER_MINUTE_USD: '0.05',
    STORAGE_DRIVER: 'local',
    ...(opts.adapter ? { ANTHROPIC_API_KEY: 'test-key-scripted' } : {}),
    ...opts.env,
  });
  const db = testDb();
  const secrets = testSecrets(config);
  const storageDir = await mkdtemp(path.join(tmpdir(), 'jarvis-telephony-'));
  const storage = createLocalStorage(storageDir);
  const services = createAgentServices({ config, db, secrets, storage });
  const app = await buildApp(
    {
      config,
      db,
      secrets,
      agent: services,
      storage,
      listen: async () => async () => {},
      modelAdapter: opts.adapter ?? null,
    },
    registerRoutes,
  );
  await app.listen({ port, host: '127.0.0.1' });
  const worker: WorkerDeps = {
    config,
    db,
    secrets,
    adapter: opts.adapter ?? null,
    storage,
    log: silentLogger,
    workerId: `test-${randomUUID().slice(0, 8)}`,
    testHooks: opts.testHooks,
  };
  return {
    mock,
    app,
    base,
    config,
    db,
    secrets,
    services,
    worker,
    storage,
    async close() {
      await mock.close();
      await app.close();
      // The watchdogs of these calls fall due minutes later: they must not run in another test
      // file sharing this database (its worker would lease them).
      await db
        .deleteFrom('jobs')
        .where('kind', 'in', ['call.timeout', 'call.recording_fetch'])
        .where('status', 'in', ['queued', 'running'])
        .execute();
      await db.destroy();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** A user calling on their own behalf (display name, zone, locale, optionally a phone number). */
export async function newCaller(
  h: TelephonyHarness,
  opts: {
    locale?: Locale;
    name?: string;
    timeZone?: string;
    phone?: string;
    verified?: boolean;
  } = {},
): Promise<TestUser> {
  const user = await createTestUser(h.db, { locale: opts.locale ?? 'en' });
  await withContext(h.db, user, (trx) =>
    trx
      .updateTable('users')
      .set({
        display_name: opts.name ?? 'Alex Example',
        time_zone: opts.timeZone ?? 'Europe/Berlin',
        phone_number: opts.phone ?? null,
        phone_verified_at: opts.phone && opts.verified ? new Date() : null,
      })
      .where('id', '=', user.userId)
      .execute(),
  );
  return user;
}

/** Creates a task from the request and runs the queue until it waits (or ends). */
export async function ask(h: TelephonyHarness, user: DbContext, request: string): Promise<string> {
  const t = await h.services.tasks.create(user, { request, source: 'text' }, {});
  await drain(h.worker);
  return t.id;
}

export async function pendingApproval(
  h: TelephonyHarness,
  user: DbContext,
  taskId: string,
): Promise<Approval> {
  const row = await withContext(h.db, user, (trx) =>
    approvalQuery(trx)
      .where('a.task_id', '=', taskId)
      .where('a.status', '=', 'PENDING')
      .orderBy('a.created_at', 'desc')
      .executeTakeFirst(),
  );
  if (!row) throw new Error('no pending approval');
  return toApproval(row as never);
}

/** Approves the pending approval by tap (web), then runs the queue (the call happens meanwhile). */
export async function approve(
  h: TelephonyHarness,
  user: DbContext,
  taskId: string,
): Promise<Approval> {
  const a = await pendingApproval(h, user, taskId);
  await h.services.approvals.decide(
    user,
    a.id,
    { decision: 'approve', actionHash: a.actionHash },
    'web',
  );
  await drain(h.worker);
  return a;
}

export { detail, drain };

/** A signed-in API client (bearer token) of the user. */
export async function clientOf(h: TelephonyHarness, user: TestUser) {
  const token = await login(h.app, user);
  return (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
}

/** Call rows of a task, read in the owner's context. */
export async function callsOf(h: TelephonyHarness, user: DbContext, taskId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('call_sessions')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('attempt')
      .execute(),
  );
}
