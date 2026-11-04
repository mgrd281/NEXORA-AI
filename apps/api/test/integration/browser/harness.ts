/**
 * Shared setup for browser-agent and commerce integration tests: the agent
 * harness (real Postgres with RLS, the real AgentServices and agent worker),
 * the real fixture site (scripts/fixture-site.mjs, its own child process on a
 * random port — never the shared 4599), real headless Chromium through the
 * browser worker's own job loop (runBrowserOnce + a 'browser' heartbeat), and
 * in-memory evidence storage (test double, see memory-storage.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runBrowserOnce } from '../../../src/browser-worker';
import { loadBrowserWorkerConfig } from '../../../src/config';
import { withContext, type DbContext } from '../../../src/db/pool';
import type { BrowserJobDeps } from '../../../src/modules/browser/jobs';
import { heartbeat } from '../../../src/modules/jobs/queue';
import { TEST_APP_URL } from '../env';
import { createHarness, type Harness } from '../agent/harness';
import { memoryStorage, type MemoryStorage } from './memory-storage';

export interface FixtureSiteProcess {
  origin: string;
  port: number;
  /** POST a test control (e.g. '/shop/admin/reset'); returns the JSON. */
  admin(pathAndQuery: string, method?: 'GET' | 'POST'): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

const SCRIPT = path.resolve(import.meta.dirname, '../../../../../scripts/fixture-site.mjs');

export async function startFixtureSiteProcess(): Promise<FixtureSiteProcess> {
  const child: ChildProcess = spawn(process.execPath, [SCRIPT, '--port', '0', '--quiet'], {
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
  const port = Number(new URL(origin).port);
  return {
    origin,
    port,
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

export interface BrowserHarness extends Harness {
  fixture: FixtureSiteProcess;
  evidence: MemoryStorage;
  /** The browser worker's dependencies (tests may change `budgets`). */
  browser: BrowserJobDeps;
  /** Pause / resume the browser worker loop (to observe queued sessions). */
  pauseBrowser(paused: boolean): void;
}

export async function createBrowserHarness(
  opts: Parameters<typeof createHarness>[0] & { browserEnv?: Record<string, string> } = {},
): Promise<BrowserHarness> {
  const fixture = await startFixtureSiteProcess();
  const evidence = memoryStorage();
  const env = {
    BROWSER_FIXTURE_ORIGIN: fixture.origin,
    BROWSER_ALLOW_PRIVATE_HOSTS: `127.0.0.1:${fixture.port}`,
    ...opts.env,
  };
  const h = await createHarness({ ...opts, storage: evidence, env });
  const config = loadBrowserWorkerConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_APP_URL,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: '/nonexistent-browser-test-storage',
    ...env,
    ...opts.browserEnv,
  });
  const browser: BrowserJobDeps = {
    config,
    db: h.db,
    storage: evidence,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    workerId: `browser-test-${randomUUID().slice(0, 8)}`,
    cancelPollMs: 200,
  };
  let running = true;
  let paused = false;
  const beat = () => heartbeat(h.db, browser.workerId, 'test', '0.0.0', 'browser').catch(() => {});
  await beat();
  const beats = setInterval(() => void beat(), 5_000);
  const loop = (async () => {
    while (running) {
      if (!paused) await runBrowserOnce(browser, 2).catch(() => 0);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return {
    ...h,
    fixture,
    evidence,
    browser,
    pauseBrowser(p) {
      paused = p;
    },
    async close() {
      running = false;
      clearInterval(beats);
      await loop;
      await h.db
        .deleteFrom('worker_heartbeats')
        .where('worker_id', '=', browser.workerId)
        .execute()
        .catch(() => {});
      await fixture.stop();
      await h.close();
    },
  };
}

/** Browser sessions of a task, oldest first. */
export async function sessionsOf(h: Harness, user: DbContext, taskId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('browser_sessions')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute(),
  );
}

export async function artifactsOf(h: Harness, user: DbContext, taskId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('evidence_artifacts')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute(),
  );
}

/** A local date `n` days ahead (Europe/Berlin) that is a weekday — the fixture practice's open days. */
export function weekdayAhead(n: number): string {
  let d = new Date(Date.now() + n * 86_400_000);
  for (;;) {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
    const wd = new Date(`${local}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return local;
    d = new Date(d.getTime() + 86_400_000);
  }
}
