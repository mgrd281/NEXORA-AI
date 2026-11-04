/**
 * Pipeline runner: the whole runtime on a real database — intake
 * (AgentServices), the worker (runOnce from src/worker.ts), planning, policy,
 * approvals, tool execution against a local fixture website and an
 * in-process SMTP sink, verification — with Row-Level Security enforced
 * (every read below goes through withContext as the scenario's user).
 *
 * The eval database (EVAL_DATABASE_URL / EVAL_DATABASE_OWNER_URL, default
 * jarvis_test_evals) is dropped and migrated at start; the runner refuses a
 * database whose name does not contain "eval". Jobs are driven explicitly
 * (no timers); retry backoff is skipped by making task jobs due, approval
 * expiry is left alone. Fault injection uses the worker's test hook
 * (afterToolExecute) — the same seam the integration tests use.
 *
 * Phase C: when a scenario needs the browser agent, the real fixture site
 * (scripts/fixture-site.mjs, its own process on a random port) and the
 * browser worker's own job loop (runBrowserOnce + a 'browser' heartbeat, real
 * headless Chromium) run beside the agent worker; when one lists a Google or
 * Microsoft connection, the mock providers (tools/mock-providers) do, and the
 * connection is stored as the OAuth flow would store it (sealed tokens the
 * mock accepts). Side effects then also count orders and reservations at the
 * fixture site and mail the providers sent.
 */
import {
  DEFAULT_PREFERENCES,
  type TaskDetail,
  type TaskSummary,
  type ToolId,
} from '@jarvis/contracts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { runBrowserOnce } from '../../../src/browser-worker';
import { loadBrowserWorkerConfig, type Config } from '../../../src/config';
import { migrate } from '../../../src/db/migrate';
import { createDb, withContext, type Db, type DbContext } from '../../../src/db/pool';
import { SecretBox } from '../../../src/lib/crypto';
import { createAgentServices } from '../../../src/modules/agent/index';
import { silentLogger } from '../../../src/modules/agent/runtime';
import { hashPassword } from '../../../src/modules/auth/password';
import type { BrowserJobDeps } from '../../../src/modules/browser/jobs';
import { sealSecret } from '../../../src/modules/connections/smtp';
import { sealTokens } from '../../../src/modules/integrations/tokens';
import { heartbeat } from '../../../src/modules/jobs/queue';
import { createLocalStorage } from '../../../src/modules/storage/local';
import type { ObjectStorage } from '../../../src/modules/storage/types';
import { loadTaskDetail } from '../../../src/modules/tasks/mappers';
import type { AgentServices } from '../../../src/services';
import { runOnce, type WorkerDeps } from '../../../src/worker';
import {
  startFixtureSite,
  type FixtureRoute,
  type FixtureSite,
} from '../../../test/fixtures/http-site';
import { startSmtpSink, type SmtpSink } from '../../../test/fixtures/smtp-sink';
import {
  startGoogleMock,
  startMicrosoftMock,
  type MockProvider,
} from '../../../../../tools/mock-providers/index.mjs';
import { missingCapabilities } from '../capabilities';
import { compare, type Observed, type ObservedStepPolicy } from '../expect';
import { loadPage } from '../fixtures';
import { errored, pending, resultOf, type RunResult } from '../result';
import type { LoadedScenario } from '../scenario';
import { defaultEmail, evalConfig, prepare, preferencesOf, type Prepared } from './common';

export const EVAL_APP_URL =
  process.env.EVAL_DATABASE_URL ??
  'postgresql://jarvis_app:jarvis_app_dev@localhost:5432/jarvis_test_evals';
export const EVAL_OWNER_URL =
  process.env.EVAL_DATABASE_OWNER_URL ??
  'postgresql://jarvis_owner:jarvis_owner_dev@localhost:5432/jarvis_test_evals';

const SENDER = 'jarvis@eval.test';

export interface PipelineEnv {
  config: Config;
  db: Db;
  secrets: SecretBox;
  storage: ObjectStorage;
  services: AgentServices;
  worker: WorkerDeps;
  site: FixtureSite;
  smtp: SmtpSink;
  siteOrigin: string;
  downOrigin: string;
  /** Tool after whose side effect the worker "crashes" once (fault injection). */
  crash: { afterTool: ToolId | null };
  /** Phase C: the fixture shop / booking site process, when a scenario needs the browser agent. */
  fixture: FixtureProcess | null;
  /** Phase C: the mock OAuth providers, when a scenario lists a Google or Microsoft connection. */
  mocks: { google: MockProvider; microsoft: MockProvider } | null;
  close(): Promise<void>;
}

/** Phase C: the fixture site (shops, booking site) as its own process. */
export interface FixtureProcess {
  origin: string;
  port: number;
  admin(pathAndQuery: string, method?: 'GET' | 'POST'): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

const FIXTURE_SCRIPT = path.resolve(import.meta.dirname, '../../../../../scripts/fixture-site.mjs');
const MOCK_CLIENT = { clientId: 'eval-client', clientSecret: 'eval-secret' };

async function startFixtureProcess(): Promise<FixtureProcess> {
  const child: ChildProcess = spawn(process.execPath, [FIXTURE_SCRIPT, '--port', '0', '--quiet'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fixture site did not start')), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      const m = /fixture site on (http:\/\/[^/\s]+)\//.exec(chunk.toString());
      if (m) {
        clearTimeout(t);
        resolve(m[1]!);
      }
    });
    child.once('exit', (code) => reject(new Error(`fixture site exited (${code})`)));
  });
  return {
    origin,
    port: Number(new URL(origin).port),
    async admin(p, method = 'POST') {
      const res = await fetch(`${origin}${p}`, { method });
      return (await res.json()) as Record<string, unknown>;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

const isOAuth = (p: string): p is 'google' | 'microsoft' => p === 'google' || p === 'microsoft';

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/** Drops and re-creates the eval database schema from the migrations. */
export async function resetEvalDatabase(ownerUrl = EVAL_OWNER_URL): Promise<void> {
  const name = databaseName(ownerUrl);
  if (!/eval/.test(name))
    throw new Error(
      `refusing to reset database "${name}": the eval database name must contain "eval"`,
    );
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  } finally {
    await c.end();
  }
  await migrate(ownerUrl, undefined, () => {});
}

/** A port nothing listens on (connections are refused): the "network failure" host. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Fixture routes of every pipeline scenario ({{site}}/path → page). */
async function siteRoutes(
  scenarios: readonly LoadedScenario[],
): Promise<Record<string, FixtureRoute>> {
  const routes: Record<string, FixtureRoute> = {};
  const owner = new Map<string, string>();
  for (const s of scenarios) {
    for (const [url, fixture] of Object.entries(s.given.pages)) {
      if (!url.startsWith('{{site}}/')) continue;
      const route = url.slice('{{site}}'.length).split('?')[0]!;
      const prev = owner.get(route);
      if (prev && prev !== fixture)
        throw new Error(
          `fixture site: ${route} is ${prev} in one scenario and ${fixture} in ${s.id}`,
        );
      owner.set(route, fixture);
      const page = await loadPage(fixture);
      routes[route] = { type: page.contentType, body: page.body };
    }
  }
  return routes;
}

export async function startPipeline(scenarios: readonly LoadedScenario[]): Promise<PipelineEnv> {
  await resetEvalDatabase();
  const site = await startFixtureSite(await siteRoutes(scenarios));
  const smtp = await startSmtpSink();
  const down = await closedPort();
  const storageDir = await mkdtemp(path.join(tmpdir(), 'jarvis-evals-'));
  const needsBrowser = scenarios.some((s) => s.given.browserAvailable);
  const needsOAuth = scenarios.some((s) => s.given.connections.some(isOAuth));
  const fixture = needsBrowser ? await startFixtureProcess() : null;
  const mocks = needsOAuth
    ? {
        google: await startGoogleMock({ ...MOCK_CLIENT, accounts: [] }),
        microsoft: await startMicrosoftMock({ ...MOCK_CLIENT, accounts: [] }),
      }
    : null;
  const phaseC: Record<string, string> = {
    ...(fixture
      ? {
          BROWSER_FIXTURE_ORIGIN: fixture.origin,
          BROWSER_ALLOW_PRIVATE_HOSTS: `127.0.0.1:${fixture.port}`,
        }
      : {}),
    ...(mocks
      ? {
          GOOGLE_CLIENT_ID: MOCK_CLIENT.clientId,
          GOOGLE_CLIENT_SECRET: MOCK_CLIENT.clientSecret,
          GOOGLE_BASE_URL_OVERRIDE: mocks.google.url,
          MICROSOFT_CLIENT_ID: MOCK_CLIENT.clientId,
          MICROSOFT_CLIENT_SECRET: MOCK_CLIENT.clientSecret,
          MICROSOFT_BASE_URL_OVERRIDE: mocks.microsoft.url,
        }
      : {}),
  };
  const config = evalConfig({
    DATABASE_URL: EVAL_APP_URL,
    FETCH_ALLOW_PRIVATE_HOSTS: `127.0.0.1:${site.port},127.0.0.1:${down}`,
    SMTP_ALLOW_INSECURE_LOCALHOST: 'true',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    ...phaseC,
  });
  const { db } = createDb(EVAL_APP_URL, 5);
  const secrets = new SecretBox(config.SECRET_ENCRYPTION_KEY, config.SECRET_ENCRYPTION_KEY_ID);
  const storage = createLocalStorage(storageDir);
  const services = createAgentServices({ config, db, secrets, storage });
  const crash: PipelineEnv['crash'] = { afterTool: null };
  const worker: WorkerDeps = {
    config,
    db,
    secrets,
    adapter: null,
    storage,
    log: silentLogger,
    workerId: `eval-${randomUUID().slice(0, 8)}`,
    testHooks: {
      afterToolExecute: (toolId) => {
        if (crash.afterTool === toolId) {
          crash.afterTool = null;
          throw new Error('eval fault: the worker died after the side effect');
        }
      },
    },
  };
  // The browser worker's own loop (no SecretBox, no model), as src/browser-worker.ts runs it.
  let browserLoop: Promise<void> | null = null;
  let browserRunning = true;
  let beats: NodeJS.Timeout | null = null;
  const browserId = `eval-browser-${randomUUID().slice(0, 8)}`;
  if (fixture) {
    const browser: BrowserJobDeps = {
      config: loadBrowserWorkerConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: EVAL_APP_URL,
        STORAGE_DRIVER: 'local',
        STORAGE_LOCAL_DIR: storageDir,
        ...phaseC,
      }),
      db,
      storage,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      workerId: browserId,
      cancelPollMs: 200,
    };
    const beat = () => heartbeat(db, browserId, 'eval', '0.0.0', 'browser').catch(() => {});
    await beat();
    beats = setInterval(() => void beat(), 5_000);
    browserLoop = (async () => {
      while (browserRunning) {
        await runBrowserOnce(browser, 2).catch(() => 0);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
  }
  return {
    config,
    db,
    secrets,
    storage,
    services,
    worker,
    site,
    smtp,
    siteOrigin: `http://127.0.0.1:${site.port}`,
    downOrigin: `http://127.0.0.1:${down}`,
    crash,
    fixture,
    mocks,
    async close() {
      browserRunning = false;
      if (beats) clearInterval(beats);
      await browserLoop;
      await db
        .deleteFrom('worker_heartbeats')
        .where('worker_id', '=', browserId)
        .execute()
        .catch(() => {});
      await fixture?.stop();
      await mocks?.google.close();
      await mocks?.microsoft.close();
      await smtp.stop();
      await site.close();
      await db.destroy();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** Phase C: what the outside world received — orders and reservations at the fixture site, provider mail. */
async function externalSideEffects(env: PipelineEnv, email: string): Promise<number> {
  let n = 0;
  if (env.fixture) {
    for (const shop of ['shop', 'outlet']) {
      const r = await env.fixture.admin(`/${shop}/admin/orders`, 'GET');
      n += Array.isArray(r.orders) ? r.orders.length : 0;
    }
    const b = await env.fixture.admin('/booking/admin/reservations', 'GET');
    n += Array.isArray(b.reservations) ? b.reservations.length : 0;
  }
  if (env.mocks)
    for (const m of [env.mocks.google, env.mocks.microsoft]) {
      try {
        n += m.sent(email).length;
      } catch {
        // No such account at this provider.
      }
    }
  return n;
}

/** Phase C: a fresh fixture site and provider mailbox for each scenario. */
async function resetExternal(env: PipelineEnv): Promise<void> {
  if (!env.fixture) return;
  for (const shop of ['shop', 'outlet']) await env.fixture.admin(`/${shop}/admin/reset`);
  await env.fixture.admin('/booking/admin/reset?rotation=off');
}

/* ------------------------------------------------------------------ */
/* Scenario setup                                                      */
/* ------------------------------------------------------------------ */

let passwordHash: Promise<string> | undefined;

async function createUser(env: PipelineEnv, s: LoadedScenario, email: string): Promise<DbContext> {
  passwordHash ??= hashPassword(randomUUID());
  const tenantId = randomUUID();
  const userId = randomUUID();
  const ctx = { tenantId, userId };
  const prefs = { ...DEFAULT_PREFERENCES, ...preferencesOf(s) };
  await withContext(env.db, ctx, async (trx) => {
    await trx
      .insertInto('tenants')
      .values({ id: tenantId, name: `Eval ${s.id}` })
      .execute();
    await trx
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email,
        display_name: 'Eval Owner',
        password_hash: await passwordHash!,
        locale: s.given.account?.locale ?? 'en',
        time_zone: s.given.account?.timeZone ?? 'Europe/Berlin',
        preferences: JSON.stringify(prefs),
      })
      .execute();
    await trx
      .insertInto('user_roles')
      .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
      .execute();
    const status = s.given.connectionStatus ?? {};
    for (const provider of s.given.connections) {
      const connStatus = status[provider] ?? 'active';
      if (isOAuth(provider)) {
        // As the OAuth flow stores it: account, capabilities, scopes, one sealed envelope
        // whose tokens the mock provider accepts (an expired row keeps its envelope; the
        // provider just refuses it, as after a revoked grant).
        const mock = env.mocks![provider];
        const capabilities = s.given.connectionCapabilities?.[provider] ?? [];
        mock.addAccount({ email, name: 'Eval Owner' });
        const accessToken = `at_eval_${randomBytes(12).toString('hex')}`;
        const refreshToken = `rt_eval_${randomBytes(12).toString('hex')}`;
        const scopes = ['openid', 'email'];
        const valid = connStatus === 'active';
        mock.oauth.accessTokens.set(accessToken, {
          email,
          clientId: MOCK_CLIENT.clientId,
          scopes,
          expiresAt: Date.now() + 3_600_000,
          valid,
        });
        mock.oauth.refreshTokens.set(refreshToken, {
          email,
          clientId: MOCK_CLIENT.clientId,
          scopes,
          valid,
        });
        const id = randomUUID();
        await trx
          .insertInto('connections')
          .values({
            id,
            tenant_id: tenantId,
            user_id: userId,
            provider,
            label: provider === 'google' ? 'Google' : 'Microsoft',
            account_identifier: email,
            status: connStatus,
            status_reason: connStatus === 'expired' ? 'GRANT_INVALID' : null,
            permissions: [],
            capabilities,
            granted_scopes: scopes,
            provider_account_id: `eval-${provider}-${userId.slice(0, 8)}`,
            token_expires_at: new Date(Date.now() + 3_600_000),
            ...sealTokens(
              env.secrets,
              { user_id: userId, provider, id },
              {
                accessToken,
                refreshToken,
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                scope: scopes,
                tokenType: 'Bearer',
              },
            ),
          })
          .execute();
      } else if (provider === 'web') {
        await trx
          .insertInto('connections')
          .values({
            tenant_id: tenantId,
            user_id: userId,
            provider: 'web',
            label: 'Web',
            status: connStatus,
            permissions: ['web:read'],
          })
          .execute();
      } else {
        await trx
          .insertInto('connections')
          .values({
            tenant_id: tenantId,
            user_id: userId,
            provider: 'smtp',
            label: 'Email',
            account_identifier: SENDER,
            status: connStatus,
            permissions: ['email:send'],
            config: JSON.stringify({
              host: '127.0.0.1',
              port: env.smtp.port,
              security: 'none',
              fromAddress: SENDER,
              fromName: 'JARVIS',
            }),
            ...sealSecret(env.secrets, userId, 'smtp', {}),
          })
          .execute();
      }
    }
  });
  return ctx;
}

/** Stores the scenario's files as uploads would (unattached; ids from the placeholders). */
async function storeAttachments(
  env: PipelineEnv,
  user: DbContext,
  p: Prepared,
): Promise<{ id: string; earlier: boolean }[]> {
  const out: { id: string; earlier: boolean }[] = [];
  const files = p.scenario.given.attachments;
  for (const [i, a] of files.entries()) {
    const id = p.placeholders.files[i]!;
    const doc = p.documents.get(id)!;
    const key = `tenants/${user.tenantId}/users/${user.userId}/attachments/${id}`;
    await env.storage.put(key, { body: doc.body, contentType: a.mediaType, sha256: doc.sha256 });
    await withContext(env.db, user, (trx) =>
      trx
        .insertInto('attachments')
        .values({
          id,
          tenant_id: user.tenantId,
          user_id: user.userId,
          conversation_id: null,
          filename: a.filename,
          media_type: a.mediaType,
          size_bytes: doc.body.length,
          sha256: doc.sha256,
          storage_driver: env.storage.driver,
          storage_key: key,
          expires_at: new Date(Date.now() + 24 * 3_600_000),
        })
        .execute(),
    );
    out.push({ id, earlier: a.earlier });
  }
  return out;
}

/** Runs due jobs until the queue is idle; task-job retries are made due at once. */
async function drain(env: PipelineEnv, maxRounds = 60): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const n = await runOnce(env.worker);
    if (n > 0) continue;
    // Retries wait for their backoff: skip it (approval expiry and schedules stay as they are).
    const due = await env.db
      .updateTable('jobs')
      .set({ run_at: new Date(0) })
      .where('status', '=', 'queued')
      .where('kind', 'in', ['task.plan', 'task.execute'])
      .where('run_at', '>', new Date())
      .executeTakeFirst();
    if (Number(due.numUpdatedRows) === 0) return;
  }
  throw new Error('job queue did not drain');
}

async function detail(env: PipelineEnv, user: DbContext, taskId: string): Promise<TaskDetail> {
  const d = await withContext(env.db, user, (trx) => loadTaskDetail(trx, taskId));
  if (!d) throw new Error(`task ${taskId} not visible to its owner`);
  return d;
}

/** Decides pending approvals as the scenario says, draining after each decision. */
async function decideApprovals(
  env: PipelineEnv,
  user: DbContext,
  taskId: string,
  mode: 'none' | 'all' | 'reject',
) {
  if (mode === 'none') return;
  for (let i = 0; i < 8; i++) {
    const d = await detail(env, user, taskId);
    const approval = d.approvals.find((a) => a.status === 'PENDING');
    if (!approval) return;
    await env.services.approvals.decide(
      user,
      approval.id,
      { decision: mode === 'reject' ? 'reject' : 'approve', actionHash: approval.actionHash },
      'web',
    );
    await drain(env);
    if (mode === 'reject') return;
  }
}

/** Makes the user's active schedules due now and runs the scheduler twice (exactly once per occurrence). */
async function runDueSchedules(env: PipelineEnv, user: DbContext): Promise<void> {
  const c = new pg.Client({ connectionString: EVAL_OWNER_URL });
  await c.connect();
  try {
    await c.query(
      `UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE user_id = $1 AND status = 'active'`,
      [user.userId],
    );
  } finally {
    await c.end();
  }
  const { schedulerTick } = await import('../../../src/modules/agent/jobs/schedule-run');
  await schedulerTick(env.worker);
  await schedulerTick(env.worker); // a second tick for the same occurrence is a no-op
  await drain(env);
  await schedulerTick(env.worker); // no longer due
  await drain(env);
}

/* ------------------------------------------------------------------ */
/* Observation                                                         */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown> | null;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function observe(
  env: PipelineEnv,
  user: DbContext,
  d: TaskDetail,
  sideEffects: number,
  probeRetry: boolean,
): Promise<Observed> {
  const { steps, executions, schedules, scheduled } = await withContext(
    env.db,
    user,
    async (trx) => ({
      steps: await trx
        .selectFrom('task_steps')
        .select(['tool_id', 'input', 'policy', 'output', 'position'])
        .where('task_id', '=', d.id)
        .orderBy('position')
        .execute(),
      executions: await trx
        .selectFrom('tool_executions')
        .select(['tool_id'])
        .where('task_id', '=', d.id)
        .execute(),
      schedules: await trx
        .selectFrom('scheduled_tasks')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow(),
      scheduled: await trx
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('source', '=', 'schedule')
        .executeTakeFirstOrThrow(),
    }),
  );
  const policy: ObservedStepPolicy[] = [];
  for (const s of steps) {
    const p = s.policy as { decision?: ObservedStepPolicy['decision']; reasons?: string[] } | null;
    if (p?.decision)
      policy.push({
        step: s.position,
        toolId: s.tool_id,
        decision: p.decision,
        reasons: p.reasons ?? [],
      });
  }
  const counts: Partial<Record<ToolId, number>> = {};
  for (const e of executions) counts[e.tool_id as ToolId] = (counts[e.tool_id as ToolId] ?? 0) + 1;
  const denied = policy.some((x) => x.decision === 'deny');
  const planningFailed =
    steps.length === 0 &&
    d.status === 'FAILED' &&
    ['PLANNER_UNSUPPORTED', 'MODEL_ERROR'].includes(d.error?.code ?? '');
  const isQuestion = d.status === 'COMPLETED' && d.outcome === 'question';
  let retryNeedsAcknowledgement: boolean | null = null;
  if (probeRetry && d.status === 'FAILED' && d.error?.code === 'OUTCOME_UNKNOWN') {
    retryNeedsAcknowledgement = await env.services.tasks
      .retry(user, d.id, { acknowledgeUnknownOutcome: false })
      .then(
        () => false,
        (e: unknown) => (e as { code?: string }).code === 'INVALID_STATE',
      );
  }
  const scheduleStep = steps.find((s) => s.tool_id === 'schedule.create');
  const scheduleInput = (scheduleStep?.input ?? null) as Json;
  return {
    result: planningFailed ? 'unsupported' : denied ? 'deny' : isQuestion ? 'question' : 'plan',
    toolSequence: steps.map((s) => s.tool_id as ToolId),
    missing: isQuestion ? (d.question?.missing ?? []) : null,
    errorReason: planningFailed || denied ? (d.error?.reason ?? null) : null,
    recipients: steps
      .filter((s) => s.tool_id === 'email.send')
      .flatMap((s) => {
        const to = (s.input as Json)?.to;
        return Array.isArray(to) ? to.map(String) : [];
      }),
    urls: steps.filter((s) => s.tool_id === 'web.fetch').map((s) => str((s.input as Json)?.url)),
    policy,
    flagged: steps.some((s) => (s.output as Json)?.suspectedInjection === true),
    sideEffects,
    schedule: scheduleInput
      ? {
          recurrence: (scheduleInput.recurrence ?? {}) as Record<string, unknown>,
          request: str(scheduleInput.request),
        }
      : null,
    planner: 'offline',
    costMicro: d.cost.actualMicroUsd,
    pipeline: {
      status: d.status,
      outcome: d.outcome ?? null,
      errorCode: d.error?.code ?? null,
      errorReason: d.error?.reason ?? null,
      retryable: d.error ? d.error.retryable : null,
      retryNeedsAcknowledgement,
      executions: counts,
      schedulesCreated: Number(schedules.n),
      scheduledTasks: Number(scheduled.n),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export async function runPipeline(env: PipelineEnv, s: LoadedScenario): Promise<RunResult> {
  const missing = await missingCapabilities(s.requires, {
    mode: 'pipeline',
    services: env.services,
    storage: true,
  });
  if (missing.length) return pending(s, 'pipeline', `capability missing: ${missing.join(', ')}`);
  if (s.given.conversation.length > 0 && typeof env.services.tasks.followUp !== 'function')
    return pending(s, 'pipeline', 'capability missing: service:followUp');

  const started = performance.now();
  try {
    const email = s.given.account?.email ?? defaultEmail(s);
    const p = await prepare(s, { site: env.siteOrigin, down: env.downOrigin, email });
    await resetExternal(env);
    const user = await createUser(env, s, email);
    const files = await storeAttachments(env, user, p);
    const earlierFiles = files.filter((f) => f.earlier).map((f) => f.id);
    const ownFiles = files.filter((f) => !f.earlier).map((f) => f.id);

    // Earlier turns run for real, in one conversation; the scenario's request follows up.
    let conversationId: string | null = null;
    for (const [i, turn] of p.scenario.given.conversation.entries()) {
      const request = p.turns[i]!.request;
      const attachmentIds = i === 0 && earlierFiles.length ? earlierFiles : undefined;
      const turnInput = {
        request,
        source: 'text' as const,
        ...(attachmentIds ? { attachmentIds } : {}),
      };
      const t: TaskSummary = conversationId
        ? await env.services.tasks.followUp(user, conversationId, turnInput, {})
        : await env.services.tasks.create(user, turnInput, {});
      conversationId = t.conversationId ?? (await detail(env, user, t.id)).conversationId;
      await drain(env);
      if (turn.outcome !== 'question') await decideApprovals(env, user, t.id, 'all');
    }
    const turnSent = env.smtp.messages.length + (await externalSideEffects(env, email));

    env.crash.afterTool = s.given.faults.crashAfterTool ?? null;
    const input = {
      request: p.request,
      source: 'text' as const,
      ...(s.given.language ? { language: s.given.language } : {}),
      ...(ownFiles.length ? { attachmentIds: ownFiles } : {}),
    };
    const created = conversationId
      ? await env.services.tasks.followUp(user, conversationId, input, {})
      : await env.services.tasks.create(user, input, {});
    await drain(env);
    await decideApprovals(env, user, created.id, s.given.approve);
    if (s.expect.pipeline?.scheduledTasksCreated !== undefined) await runDueSchedules(env, user);
    env.crash.afterTool = null;

    const d = await detail(env, user, created.id);
    const sent = async () =>
      env.smtp.messages.length + (await externalSideEffects(env, email)) - turnSent;
    const observed = await observe(
      env,
      user,
      d,
      await sent(),
      p.expect.pipeline?.retryNeedsAcknowledgement !== undefined,
    );
    if (observed.pipeline) {
      observed.pipeline.evidence = await withContext(env.db, user, async (trx) =>
        Number(
          (
            await trx
              .selectFrom('evidence_artifacts')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('task_id', '=', created.id)
              .executeTakeFirstOrThrow()
          ).n,
        ),
      );
      // Scenario 10: the user acknowledges the unknown outcome and retries; the step
      // reconciles with the merchant instead of ordering again.
      if (p.expect.pipeline?.acknowledgedRetry) {
        observed.pipeline.afterRetry = null;
        if (d.status === 'FAILED') {
          await env.services.tasks.retry(user, created.id, { acknowledgeUnknownOutcome: true });
          await drain(env);
          await decideApprovals(env, user, created.id, 'all');
          const after = await detail(env, user, created.id);
          observed.pipeline.afterRetry = { status: after.status, sideEffects: await sent() };
        }
      }
    }
    const failures = compare(p.expect, observed, 'pipeline');
    return resultOf(s, 'pipeline', {
      status: failures.length ? 'failed' : 'passed',
      failures,
      observed,
      latencyMs: performance.now() - started,
      costMicro: observed.costMicro,
    });
  } catch (err) {
    env.crash.afterTool = null;
    return errored(s, 'pipeline', err, performance.now() - started);
  }
}
