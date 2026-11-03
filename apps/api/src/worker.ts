/**
 * JARVIS durable worker.
 *
 * Leases jobs from the Postgres queue (FOR UPDATE SKIP LOCKED) up to
 * WORKER_CONCURRENCY, wakes immediately on NOTIFY jarvis_jobs and polls every
 * 2 s, reclaims expired leases every 15 s, heartbeats every 10 s, and on
 * SIGINT/SIGTERM stops leasing and waits for in-flight jobs to finish.
 *
 * processJob / runOnce are exported for tests (no timers involved).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config';
import { createListener } from './db/listener';
import { createDb, type Db } from './db/pool';
import type { JobRow } from './db/types';
import { SecretBox } from './lib/crypto';
import { onJobDead, reconcileAfterJob, runJob } from './modules/agent/jobs';
import { createModelAdapter, type RuntimeDeps, type RuntimeLogger } from './modules/agent/runtime';
import {
  complete,
  extendLease,
  fail,
  heartbeat,
  JOBS_CHANNEL,
  lease,
  reclaimExpired,
} from './modules/jobs/queue';

export const LEASE_MS = 60_000;
export const POLL_MS = 2_000;
export const RECLAIM_MS = 15_000;
export const HEARTBEAT_MS = 10_000;

export interface WorkerDeps extends Omit<RuntimeDeps, 'keepAlive'> {
  workerId: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Runs one leased job to completion, failure (with backoff) or dead-letter. */
export async function processJob(deps: WorkerDeps, job: JobRow): Promise<void> {
  const runtime: RuntimeDeps = {
    ...deps,
    keepAlive: async () => {
      await extendLease(deps.db, job.id, deps.workerId, LEASE_MS);
    },
  };
  try {
    await runJob(runtime, job);
    await complete(deps.db, job.id, deps.workerId);
    await reconcileAfterJob(runtime, job);
  } catch (err) {
    const message = errorMessage(err);
    deps.log.error('job failed', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
      error: message,
    });
    const result = await fail(deps.db, job, deps.workerId, message);
    if (result === 'dead') {
      await onJobDead(runtime, job).catch((e: unknown) =>
        deps.log.error('dead-letter handling failed', { jobId: job.id, error: errorMessage(e) }),
      );
    }
  }
}

/** Leases up to `limit` due jobs and processes them concurrently. Returns how many ran. */
export async function runOnce(deps: WorkerDeps, opts: { limit?: number } = {}): Promise<number> {
  const jobs = await lease(
    deps.db,
    deps.workerId,
    LEASE_MS,
    opts.limit ?? deps.config.WORKER_CONCURRENCY,
  );
  await Promise.all(jobs.map((j) => processJob(deps, j)));
  return jobs.length;
}

/* ------------------------------------------------------------------ */
/* Process entry                                                       */
/* ------------------------------------------------------------------ */

function consoleLogger(): RuntimeLogger {
  const line = (level: string, msg: string, data?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...data }));
  return {
    info: (m, d) => line('info', m, d),
    warn: (m, d) => line('warn', m, d),
    error: (m, d) => line('error', m, d),
  };
}

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  const log = consoleLogger();
  const { db } = createDb(config.DATABASE_URL, config.WORKER_CONCURRENCY + 4);
  const secrets = new SecretBox(config.SECRET_ENCRYPTION_KEY, config.SECRET_ENCRYPTION_KEY_ID);
  const listener = createListener(config.DATABASE_URL, (msg, err) =>
    log.warn(msg, { error: errorMessage(err) }),
  );
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const adapter = createModelAdapter(config);
  const deps: WorkerDeps = { config, db, secrets, adapter, log, workerId };

  let stopping = false;
  const inFlight = new Set<Promise<void>>();
  let wake: (() => void) | null = null;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  await listener.listen(JOBS_CHANNEL, nudge);
  const beat = () =>
    heartbeat(db, workerId, hostname(), config.APP_VERSION).catch((e: unknown) =>
      log.warn('heartbeat failed', { error: errorMessage(e) }),
    );
  await beat();
  const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS);
  const reclaimTimer = setInterval(() => {
    reclaimExpired(db)
      .then((n) => n > 0 && log.warn('reclaimed expired job leases', { count: n }))
      .catch((e: unknown) => log.warn('reclaim failed', { error: errorMessage(e) }));
  }, RECLAIM_MS);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info('shutting down: no new jobs will be leased', { signal, inFlight: inFlight.size });
      stopping = true;
      nudge();
    });
  }

  log.info('worker started', {
    workerId,
    concurrency: config.WORKER_CONCURRENCY,
    planner: adapter ? 'model' : 'offline',
  });

  while (!stopping) {
    const free = config.WORKER_CONCURRENCY - inFlight.size;
    if (free > 0) {
      let jobs: JobRow[] = [];
      try {
        jobs = await lease(db, workerId, LEASE_MS, free);
      } catch (e) {
        log.error('lease failed', { error: errorMessage(e) });
      }
      for (const job of jobs) {
        const p: Promise<void> = processJob(deps, job).finally(() => {
          inFlight.delete(p);
          nudge();
        });
        inFlight.add(p);
      }
      if (jobs.length === free) continue; // more work may be waiting
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
  clearInterval(heartbeatTimer);
  clearInterval(reclaimTimer);
  // Remove this worker's heartbeat so health reflects only live workers.
  await db
    .deleteFrom('worker_heartbeats')
    .where('worker_id', '=', workerId)
    .execute()
    .catch((e: unknown) => log.warn('heartbeat cleanup failed', { error: errorMessage(e) }));
  await listener.close();
  await closeDb(db);
  log.info('worker stopped', { workerId });
}

async function closeDb(db: Db): Promise<void> {
  await db.destroy();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startWorker().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
