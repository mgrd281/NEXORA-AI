/**
 * JARVIS browser worker (docs/adr/0017-browser-agent-isolation.md).
 *
 * A separate process type that runs the isolated browser agent: it leases
 * ONLY browser.* jobs (BROWSER_JOB_KINDS) from the Postgres queue — the agent
 * worker never takes them — and dispatches them to the browser domain's
 * handlers (modules/browser/jobs). It is configured with
 * loadBrowserWorkerConfig: no SECRET_ENCRYPTION_KEY, model key or OAuth client
 * secret (refused in production, scrubbed from the environment in
 * development), so a compromised browser process cannot decrypt connection
 * tokens or act as JARVIS elsewhere. Chromium (playwright-core,
 * BROWSER_EXECUTABLE_PATH) is launched by the handlers with an explicit,
 * minimal environment, a fresh context per session and no persistent profile.
 *
 * It heartbeats as kind 'browser' (AssistantStatus.capabilities.browser needs
 * a live one), reclaims only browser.* leases, and on SIGINT/SIGTERM stops
 * leasing and lets in-flight sessions finish (their own timeouts bound that).
 *
 * Owner from stage 2: browser + commerce engineer (docs/architecture/phase-c.md §2).
 * processBrowserJob / runBrowserOnce / reclaimBrowserOnce are exported for tests.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadBrowserWorkerConfig, scrubBrowserWorkerEnv } from './config';
import { createListener } from './db/listener';
import { createDb } from './db/pool';
import type { JobRow } from './db/types';
import { browserJobs, type BrowserJobDeps } from './modules/browser/jobs';
import {
  BROWSER_JOB_KINDS,
  complete,
  extendLease,
  fail,
  heartbeat,
  JOBS_CHANNEL,
  lease,
  reclaimExpired,
  type KindFilter,
} from './modules/jobs/queue';
import { createStorage } from './modules/storage';

export const BROWSER_LEASE_MS = 120_000;
const POLL_MS = 2_000;
const RECLAIM_MS = 15_000;
const HEARTBEAT_MS = 10_000;

export const BROWSER_KINDS: KindFilter = { only: BROWSER_JOB_KINDS };

const errorMessage = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/** Runs one leased browser job to completion, failure (with backoff) or dead-letter. */
export async function processBrowserJob(deps: BrowserJobDeps, job: JobRow): Promise<void> {
  const lost = new AbortController();
  let released = false;
  const timer = setInterval(
    () => {
      extendLease(deps.db, job.id, deps.workerId, BROWSER_LEASE_MS)
        .then((held) => {
          if (!held && !released) lost.abort();
        })
        .catch((e: unknown) =>
          deps.log.warn('lease extension failed', { jobId: job.id, error: errorMessage(e) }),
        );
    },
    Math.floor(BROWSER_LEASE_MS / 3),
  );
  const signal = deps.signal ? AbortSignal.any([deps.signal, lost.signal]) : lost.signal;
  try {
    const handler = browserJobs.handlers[job.kind];
    if (!handler) throw new Error(`the browser worker has no handler for job kind ${job.kind}`);
    try {
      await handler.run({ ...deps, signal }, job);
    } finally {
      released = true;
      clearInterval(timer);
    }
    if (lost.signal.aborted) return; // another worker may own it now: record nothing
    await complete(deps.db, job.id, deps.workerId);
  } catch (err) {
    released = true;
    clearInterval(timer);
    if (lost.signal.aborted) return;
    deps.log.error('browser job failed', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
      error: errorMessage(err),
    });
    const result = await fail(deps.db, job, deps.workerId, errorMessage(err));
    if (result === 'dead') {
      await browserJobs.handlers[job.kind]
        ?.onDead?.(deps, job)
        .catch((e: unknown) =>
          deps.log.error('dead-letter handling failed', { jobId: job.id, error: errorMessage(e) }),
        );
    }
  }
}

/** Reclaims expired browser.* leases (dead-lettering those out of attempts). */
export async function reclaimBrowserOnce(deps: BrowserJobDeps): Promise<number> {
  const { requeued, dead } = await reclaimExpired(deps.db, BROWSER_KINDS);
  for (const job of dead) {
    await browserJobs.handlers[job.kind]
      ?.onDead?.(deps, job)
      .catch((e: unknown) =>
        deps.log.error('dead-letter handling failed', { jobId: job.id, error: errorMessage(e) }),
      );
  }
  return requeued + dead.length;
}

/** Leases up to `limit` due browser jobs and processes them concurrently. Returns how many ran. */
export async function runBrowserOnce(deps: BrowserJobDeps, limit: number): Promise<number> {
  const jobs = await lease(deps.db, deps.workerId, BROWSER_LEASE_MS, limit, BROWSER_KINDS);
  await Promise.all(jobs.map((j) => processBrowserJob(deps, j)));
  return jobs.length;
}

function consoleLogger(): BrowserJobDeps['log'] {
  const line = (level: string, msg: string, data?: Record<string, unknown>) =>
    console.log(
      JSON.stringify({ level, time: new Date().toISOString(), process: 'browser', msg, ...data }),
    );
  return {
    info: (m, d) => line('info', m, d),
    warn: (m, d) => line('warn', m, d),
    error: (m, d) => line('error', m, d),
  };
}

export async function startBrowserWorker(): Promise<void> {
  const config = loadBrowserWorkerConfig();
  const log = consoleLogger();
  // Development: one .env holds every secret; this process must not keep them.
  const scrubbed = scrubBrowserWorkerEnv();
  if (scrubbed.length > 0) log.warn('removed secrets from the environment', { names: scrubbed });

  const { db } = createDb(config.DATABASE_URL, config.BROWSER_WORKER_CONCURRENCY + 2);
  const storage = createStorage(config);
  const listener = createListener(config.DATABASE_URL, (msg, err) =>
    log.warn(msg, { error: errorMessage(err) }),
  );
  const workerId = `browser:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const shutdown = new AbortController();
  const deps: BrowserJobDeps = { config, db, storage, log, workerId, signal: shutdown.signal };

  let stopping = false;
  const inFlight = new Set<Promise<void>>();
  let wake: (() => void) | null = null;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  await listener.listen(JOBS_CHANNEL, (kind) => {
    if ((BROWSER_JOB_KINDS as readonly string[]).includes(kind)) nudge();
  });

  const beat = () =>
    heartbeat(db, workerId, hostname(), config.APP_VERSION, 'browser').catch((e: unknown) =>
      log.warn('heartbeat failed', { error: errorMessage(e) }),
    );
  await beat();
  const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS);
  const reclaimTimer = setInterval(() => {
    reclaimBrowserOnce(deps)
      .then((n) => n > 0 && log.warn('reclaimed expired browser job leases', { count: n }))
      .catch((e: unknown) => log.warn('reclaim failed', { error: errorMessage(e) }));
  }, RECLAIM_MS);
  const domainTimers = browserJobs.timers.map((timer) => {
    let running = false;
    return setInterval(() => {
      if (running) return;
      running = true;
      timer
        .run(deps)
        .then(
          (n) => n > 0 && log.info('timer round handled items', { timer: timer.name, count: n }),
        )
        .catch((e: unknown) =>
          log.warn('timer round failed', { timer: timer.name, error: errorMessage(e) }),
        )
        .finally(() => (running = false));
    }, timer.everyMs(deps));
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log.info('shutting down: no new browser sessions will be leased', {
        signal: sig,
        inFlight: inFlight.size,
      });
      stopping = true;
      nudge();
    });
  }

  log.info('browser worker started', {
    workerId,
    concurrency: config.BROWSER_WORKER_CONCURRENCY,
    executable: config.browserExecutablePath ? 'configured' : 'missing',
    storage: storage ? config.storageDriver : 'none',
  });

  while (!stopping) {
    const free = config.BROWSER_WORKER_CONCURRENCY - inFlight.size;
    if (free > 0) {
      let jobs: JobRow[] = [];
      try {
        jobs = await lease(db, workerId, BROWSER_LEASE_MS, free, BROWSER_KINDS);
      } catch (e) {
        log.error('lease failed', { error: errorMessage(e) });
      }
      for (const job of jobs) {
        const p: Promise<void> = processBrowserJob(deps, job).finally(() => {
          inFlight.delete(p);
          nudge();
        });
        inFlight.add(p);
      }
      if (jobs.length === free) continue;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  await Promise.allSettled([...inFlight]);
  shutdown.abort();
  clearInterval(heartbeatTimer);
  clearInterval(reclaimTimer);
  for (const t of domainTimers) clearInterval(t);
  await db
    .deleteFrom('worker_heartbeats')
    .where('worker_id', '=', workerId)
    .execute()
    .catch((e: unknown) => log.warn('heartbeat cleanup failed', { error: errorMessage(e) }));
  await listener.close();
  await db.destroy();
  log.info('browser worker stopped', { workerId });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startBrowserWorker().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
