import { sql } from 'kysely';
import type { Db, Trx } from '../../db/pool';
import type { JobKind, JobRow } from '../../db/types';

export const JOBS_CHANNEL = 'jarvis_jobs';

export interface EnqueueInput {
  kind: JobKind;
  tenantId: string;
  userId: string;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  /** At most one queued/running job per key; duplicates are silently dropped. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** Enqueue inside the caller's transaction so job + state change commit atomically. */
export async function enqueue(trx: Trx, j: EnqueueInput): Promise<boolean> {
  const res = await sql<{ id: number }>`
    INSERT INTO jobs (kind, tenant_id, user_id, task_id, payload, dedupe_key, run_at, max_attempts)
    VALUES (${j.kind}, ${j.tenantId}, ${j.userId}, ${j.taskId ?? null}, ${JSON.stringify(j.payload ?? {})}::jsonb,
            ${j.dedupeKey ?? null}, ${j.runAt ?? new Date()}, ${j.maxAttempts ?? 5})
    ON CONFLICT (dedupe_key) WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`.execute(trx);
  if (res.rows.length > 0) await sql`select pg_notify(${JOBS_CHANNEL}, ${j.kind})`.execute(trx);
  return res.rows.length > 0;
}

/** Atomically claim up to `limit` ready jobs (FOR UPDATE SKIP LOCKED). */
export async function lease(
  db: Db,
  workerId: string,
  leaseMs: number,
  limit: number,
): Promise<JobRow[]> {
  const res = await sql<JobRow>`
    UPDATE jobs SET status = 'running', locked_by = ${workerId},
           locked_until = now() + (${leaseMs} * interval '1 millisecond'), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
        ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT ${limit})
    RETURNING *`.execute(db);
  return res.rows;
}

export async function extendLease(
  db: Db,
  jobId: number,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const res = await db
    .updateTable('jobs')
    .set({ locked_until: sql`now() + (${leaseMs} * interval '1 millisecond')` as unknown as Date })
    .where('id', '=', jobId)
    .where('locked_by', '=', workerId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function complete(db: Db, jobId: number, workerId: string): Promise<void> {
  await db
    .updateTable('jobs')
    .set({ status: 'succeeded', locked_by: null, locked_until: null })
    .where('id', '=', jobId)
    .where('locked_by', '=', workerId)
    .execute();
}

/** Retry with exponential backoff, or mark dead once attempts are exhausted. */
export async function fail(
  db: Db,
  job: JobRow,
  workerId: string,
  error: string,
): Promise<'retry' | 'dead'> {
  const dead = job.attempts >= job.max_attempts;
  const backoffMs = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
  await db
    .updateTable('jobs')
    .set({
      status: dead ? 'dead' : 'queued',
      locked_by: null,
      locked_until: null,
      last_error: error.slice(0, 2000),
      run_at: dead ? job.run_at : new Date(Date.now() + backoffMs),
    })
    .where('id', '=', job.id)
    .where('locked_by', '=', workerId)
    .execute();
  return dead ? 'dead' : 'retry';
}

/** Return jobs whose worker died (lease expired) to the queue. */
export async function reclaimExpired(db: Db): Promise<number> {
  const res = await sql`
    UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
           locked_by = NULL, locked_until = NULL,
           last_error = COALESCE(last_error, '') || ' [lease expired]'
     WHERE status = 'running' AND locked_until < now()`.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

export async function heartbeat(
  db: Db,
  workerId: string,
  hostname: string,
  version: string,
): Promise<void> {
  await sql`
    INSERT INTO worker_heartbeats (worker_id, hostname, version) VALUES (${workerId}, ${hostname}, ${version})
    ON CONFLICT (worker_id) DO UPDATE SET last_heartbeat_at = now(), version = EXCLUDED.version`.execute(
    db,
  );
}

/** Most recent heartbeat of any worker; healthy if within 30 s. */
export async function workerHealth(
  db: Db,
): Promise<{ healthy: boolean; lastHeartbeatAt: Date | null }> {
  const row = await db
    .selectFrom('worker_heartbeats')
    .select((eb) => eb.fn.max('last_heartbeat_at').as('last'))
    .executeTakeFirst();
  const last = (row?.last as Date | null | undefined) ?? null;
  return { healthy: !!last && Date.now() - last.getTime() < 30_000, lastHeartbeatAt: last };
}
