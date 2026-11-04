/**
 * Phase C — per-domain job handlers and periodic timers (docs/architecture/phase-c.md §4).
 *
 * Each domain exports one `DomainJobs` map; the worker process that runs the
 * domain dispatches its job kinds to it and starts its timers:
 *   integrations  modules/agent/jobs/integrations/index.ts → src/worker.ts (agent worker)
 *   browser       modules/browser/jobs/index.ts            → src/browser-worker.ts (browser worker)
 * A job kind is handled by exactly one domain (checked at load). New kinds are
 * a contract change (db/types.ts JobKind + the jobs.kind CHECK in a migration).
 * This file is frozen.
 */
import type { JobKind, JobRow } from '../../db/types';

/** What a handler reports (as the core handlers: 'awaiting_approval' only for task jobs). */
export type JobOutcome = 'done' | 'awaiting_approval';

export interface JobHandler<D> {
  /**
   * Runs one leased job. Throwing = failure (the queue retries with backoff,
   * then dead-letters). Must be idempotent: a job may run again after a crash
   * or a lost lease. `deps.signal` (when present) aborts when the lease is lost.
   */
  run(deps: D, job: JobRow): Promise<JobOutcome>;
  /** The job used up its attempts (or its lease expired on the last one). */
  onDead?(deps: D, job: JobRow): Promise<void>;
}

export interface WorkerTimer<D> {
  /** For logs: e.g. 'email.watch_tick', 'oauth.revocation_drain'. */
  name: string;
  /** How often it runs, from the process's dependencies (e.g. config.EMAIL_WATCH_TICK_MS); never overlaps itself. */
  everyMs(deps: D): number;
  /**
   * One round; returns how many items it handled (logged when > 0). Must be
   * safe with several worker processes running it at once (claim in the
   * database: FOR UPDATE SKIP LOCKED, dedupe keys, SECURITY DEFINER functions).
   */
  run(deps: D): Promise<number>;
}

export interface DomainJobs<D> {
  handlers: Partial<Record<JobKind, JobHandler<D>>>;
  timers: readonly WorkerTimer<D>[];
}
