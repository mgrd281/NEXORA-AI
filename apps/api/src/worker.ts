/**
 * JARVIS durable worker.
 *
 * Leases jobs from the Postgres queue (FOR UPDATE SKIP LOCKED) up to
 * WORKER_CONCURRENCY, wakes immediately on NOTIFY jarvis_jobs and polls every
 * 2 s, reclaims expired leases every 15 s (failing the tasks of jobs that run
 * out of attempts that way), fails tasks no job will move on any more every
 * minute, heartbeats every 10 s, and on SIGINT/SIGTERM stops leasing and
 * waits for in-flight jobs to finish.
 *
 * Phase B timers: the scheduler tick (due schedules → schedule.run jobs) every
 * 15 s, the storage-deletion drain every 30 s, and the retention check every
 * hour (enqueues the daily retention.sweep jobs when this process has not
 * done so for 23 h). Each is safe with several workers: jobs are deduplicated
 * and occurrences / deletions are claimed in the database.
 *
 * Phase C (docs/architecture/phase-c.md §4.3): the agent worker never leases
 * or reclaims browser.* jobs (src/browser-worker.ts runs those, without
 * secrets); it dispatches the integrations domain's job kinds
 * (agent/jobs/integrations) and runs that domain's timers.
 *
 * Phase D (docs/architecture/phase-d.md §4.3): also the telephony domain's
 * kinds (call.timeout, call.recording_fetch: agent/jobs/telephony) and timers.
 *
 * processJob / runOnce / reclaimOnce are exported for tests (no timers involved).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config';
import { createListener } from './db/listener';
import { createDb, type Db } from './db/pool';
import type { JobRow } from './db/types';
import { SecretBox } from './lib/crypto';
import {
  AGENT_DOMAIN_JOBS,
  onJobDead,
  reconcileAfterJob,
  runJob,
  sweepStuckTasks,
} from './modules/agent/jobs';
import { drainStorageDeletions, enqueueRetentionSweeps } from './modules/agent/jobs/retention';
import { schedulerTick } from './modules/agent/jobs/schedule-run';
import {
  createModelAdapter,
  LeaseLostError,
  type RuntimeDeps,
  type RuntimeLogger,
} from './modules/agent/runtime';
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
import {
  captureException,
  currentTraceIds,
  initTelemetry,
  metrics,
  withSpan,
} from './observability';

export const LEASE_MS = 60_000;
export const POLL_MS = 2_000;
export const RECLAIM_MS = 15_000;
export const HEARTBEAT_MS = 10_000;
/** How often active tasks without a live job are looked for, and how long they get first. */
export const SWEEP_MS = 60_000;
export const STUCK_GRACE_MS = 5 * 60_000;
/** Periodic sweeps look at users whose task jobs changed this recently (the first sweep: all). */
export const SWEEP_LOOKBACK_MS = 60 * 60_000;
/** Phase B: due schedules are turned into schedule.run jobs this often (SCHEDULER_TICK_MS overrides). */
export const SCHEDULER_MS = 15_000;
/** Phase B: queued storage deletions are drained this often. */
export const STORAGE_DRAIN_MS = 30_000;
/** Phase B: retention is checked hourly and swept when this process last did so 23 h ago. */
export const RETENTION_CHECK_MS = 60 * 60_000;
export const RETENTION_EVERY_MS = 23 * 60 * 60_000;
/** Phase C: the agent worker never leases or reclaims browser.* jobs (docs/adr/0017). */
export const AGENT_JOB_KINDS: KindFilter = { except: BROWSER_JOB_KINDS };

export interface WorkerDeps extends Omit<RuntimeDeps, 'signal'> {
  workerId: string;
  /** Lease length (default LEASE_MS); tests shorten it. */
  leaseMs?: number;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Keeps a job's lease alive while it runs: extended every third of the lease,
 * from leasing to the end of the job (every step, the waits between them and
 * the result summary), so the reclaimer never hands a running job to another
 * worker. When an extension finds the lease gone — this worker stalled past
 * it and the job was reclaimed — `signal` is aborted and the job stops.
 */
function holdLease(deps: WorkerDeps, job: JobRow): { signal: AbortSignal; release(): void } {
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const lost = new AbortController();
  let extending = false;
  let released = false;
  const timer = setInterval(
    () => {
      if (extending || lost.signal.aborted) return;
      extending = true;
      extendLease(deps.db, job.id, deps.workerId, leaseMs)
        .then((held) => {
          // (An extension still in flight when the job ended finds it completed: not a loss.)
          if (!held && !released) lost.abort(new LeaseLostError(job.id));
        })
        // A failed extension is retried on the next tick; the lease outlasts two of them.
        .catch((e: unknown) =>
          deps.log.warn('lease extension failed', { jobId: job.id, error: errorMessage(e) }),
        )
        .finally(() => (extending = false));
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  );
  return {
    signal: lost.signal,
    release() {
      released = true;
      clearInterval(timer);
    },
  };
}

/**
 * Runs one leased job to completion, failure (with backoff) or dead-letter,
 * inside a `job` span, recording its duration and outcome (no content).
 */
export async function processJob(deps: WorkerDeps, job: JobRow): Promise<void> {
  const started = Date.now();
  let outcome: 'succeeded' | 'retry' | 'dead' | 'lease_lost' = 'succeeded';
  try {
    await withSpan(
      'job',
      { 'jarvis.job.kind': job.kind, 'jarvis.job.id': job.id, 'jarvis.job.attempt': job.attempts },
      async () => {
        outcome = await runLeasedJob(deps, job);
      },
    );
  } finally {
    metrics.jobFinished(job.kind, outcome, Date.now() - started);
  }
}

async function runLeasedJob(
  deps: WorkerDeps,
  job: JobRow,
): Promise<'succeeded' | 'retry' | 'dead' | 'lease_lost'> {
  const held = holdLease(deps, job);
  const runtime: RuntimeDeps = { ...deps, signal: held.signal };
  try {
    try {
      await runJob(runtime, job);
    } finally {
      held.release();
    }
    if (held.signal.aborted) throw new LeaseLostError(job.id);
    await complete(deps.db, job.id, deps.workerId);
    await reconcileAfterJob(runtime, job);
    return 'succeeded';
  } catch (err) {
    if (held.signal.aborted) {
      // The job may be running elsewhere by now: completing, failing or
      // dead-lettering it here would act on another worker's behalf.
      deps.log.warn('job lease lost; stopped without recording an outcome', {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
      });
      return 'lease_lost';
    }
    captureException(err, { jobId: job.id, jobKind: job.kind });
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
    return result;
  }
}

/**
 * Reclaims expired leases. A job dead-lettered here (lease expired on its last
 * attempt, e.g. its worker kept crashing) gets the same dead-letter handling
 * as one failing in processJob, so its task does not stay active forever.
 * Returns how many jobs were reclaimed.
 */
export async function reclaimOnce(deps: WorkerDeps): Promise<number> {
  const { requeued, dead } = await reclaimExpired(deps.db, AGENT_JOB_KINDS);
  for (const job of dead) {
    deps.log.error('job dead-lettered: its lease expired on the last attempt', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
    });
    // The sweeper fails the task later if this does not succeed.
    await onJobDead(deps, job).catch((e: unknown) =>
      deps.log.error('dead-letter handling failed', { jobId: job.id, error: errorMessage(e) }),
    );
  }
  return requeued + dead.length;
}

/** Leases up to `limit` due jobs and processes them concurrently. Returns how many ran. */
export async function runOnce(deps: WorkerDeps, opts: { limit?: number } = {}): Promise<number> {
  const jobs = await lease(
    deps.db,
    deps.workerId,
    deps.leaseMs ?? LEASE_MS,
    opts.limit ?? deps.config.WORKER_CONCURRENCY,
    AGENT_JOB_KINDS,
  );
  await Promise.all(jobs.map((j) => processJob(deps, j)));
  return jobs.length;
}

/* ------------------------------------------------------------------ */
/* Process entry                                                       */
/* ------------------------------------------------------------------ */

function consoleLogger(): RuntimeLogger {
  // trace_id / span_id of the active span (when tracing is on) correlate log lines with traces.
  const line = (level: string, msg: string, data?: Record<string, unknown>) => {
    const ids = currentTraceIds();
    console.log(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        msg,
        ...(ids ? { trace_id: ids.traceId, span_id: ids.spanId } : {}),
        ...data,
      }),
    );
  };
  return {
    info: (m, d) => line('info', m, d),
    warn: (m, d) => line('warn', m, d),
    error: (m, d) => line('error', m, d),
  };
}

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  // First: tracing, error reporting and metrics (each only when configured; no-ops otherwise).
  // First: tracing, error reporting and metrics (each only when configured; no-ops
  // otherwise). The worker serves its own /metrics (job, tool, model and webhook series)
  // when WORKER_METRICS_PORT is set; the queue gauges come from the API's /metrics.
  const telemetry = initTelemetry(config, 'worker', {
    metricsPort: config.WORKER_METRICS_PORT,
    metricsHost: config.WORKER_METRICS_HOST,
  });
  await telemetry.ready;
  const log = consoleLogger();
  const { db } = createDb(config.DATABASE_URL, config.WORKER_CONCURRENCY + 4);
  const secrets = new SecretBox(config.SECRET_ENCRYPTION_KEY, config.SECRET_ENCRYPTION_KEY_ID);
  const listener = createListener(config.DATABASE_URL, (msg, err) =>
    log.warn(msg, { error: errorMessage(err) }),
  );
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const adapter = createModelAdapter(config);
  const storage = createStorage(config);
  const deps: WorkerDeps = { config, db, secrets, adapter, storage, log, workerId };

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
    reclaimOnce(deps)
      .then((n) => n > 0 && log.warn('reclaimed expired job leases', { count: n }))
      .catch((e: unknown) => log.warn('reclaim failed', { error: errorMessage(e) }));
  }, RECLAIM_MS);
  const sweep = (lookbackMs: number | null) =>
    sweepStuckTasks(deps, { graceMs: STUCK_GRACE_MS, lookbackMs })
      .then((n) => n > 0 && log.warn('failed tasks that no job would move on', { count: n }))
      .catch((e: unknown) => log.warn('stuck-task sweep failed', { error: errorMessage(e) }));
  void sweep(null); // also tasks orphaned while no worker was running
  const sweepTimer = setInterval(() => void sweep(SWEEP_LOOKBACK_MS), SWEEP_MS);

  // Phase B maintenance (each logs and carries on when one round fails).
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    schedulerTick(deps)
      .then((n) => n > 0 && log.info('scheduled runs enqueued', { count: n }))
      .catch((e: unknown) => log.warn('scheduler tick failed', { error: errorMessage(e) }))
      .finally(() => (ticking = false));
  };
  void tick();
  const schedulerTimer = setInterval(tick, config.SCHEDULER_TICK_MS);
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    drainStorageDeletions({ db, storage, log })
      .then((n) => n > 0 && log.info('stored files deleted', { count: n }))
      .catch((e: unknown) => log.warn('storage drain failed', { error: errorMessage(e) }))
      .finally(() => (draining = false));
  };
  const drainTimer = setInterval(drain, STORAGE_DRAIN_MS);
  let lastRetention = 0;
  const retention = () => {
    if (Date.now() - lastRetention < RETENTION_EVERY_MS) return;
    lastRetention = Date.now();
    enqueueRetentionSweeps(deps)
      .then((n) => n > 0 && log.info('retention sweeps enqueued', { count: n }))
      .catch((e: unknown) => {
        lastRetention = 0; // try again at the next check
        log.warn('retention check failed', { error: errorMessage(e) });
      });
  };
  void retention();
  const retentionTimer = setInterval(retention, RETENTION_CHECK_MS);

  // Phase C / D: the domains' timers (email watches, token revocation, OAuth states; telephony).
  const domainTimers = AGENT_DOMAIN_JOBS.flatMap((d) => d.timers).map((timer) => {
    let running = false;
    const round = () => {
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
    };
    return setInterval(round, timer.everyMs(deps));
  });

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
        jobs = await lease(db, workerId, LEASE_MS, free, AGENT_JOB_KINDS);
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
  clearInterval(sweepTimer);
  clearInterval(schedulerTimer);
  clearInterval(drainTimer);
  clearInterval(retentionTimer);
  for (const t of domainTimers) clearInterval(t);
  // Remove this worker's heartbeat so health reflects only live workers.
  await db
    .deleteFrom('worker_heartbeats')
    .where('worker_id', '=', workerId)
    .execute()
    .catch((e: unknown) => log.warn('heartbeat cleanup failed', { error: errorMessage(e) }));
  await listener.close();
  await closeDb(db);
  await telemetry.shutdown();
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
