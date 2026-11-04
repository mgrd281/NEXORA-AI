/**
 * Retention (docs/architecture/phase-b.md §3.6) and the storage-deletion drain.
 *
 * enqueueRetentionSweeps (worker, daily): pages retention_due_users (SECURITY
 * DEFINER, ids only) and enqueues one retention.sweep job per user
 * (dedupe retention:<user id>).
 *
 * retention.sweep — in the user's RLS context, short transactions of at most
 * RETENTION_BATCH rows each (no long locks):
 *   1. preferences.retention.memoryDays: memories not updated for N days
 *   2. preferences.retention.taskHistoryDays: finished tasks created more than
 *      N days ago (their messages first — messages.task_id is SET NULL —
 *      then the task, which cascades steps, executions, approvals, events,
 *      notifications and file links), then conversations left without tasks
 *      whose last activity is older than the cutoff and that no schedule
 *      collects runs in (their files cascade → storage deletions)
 *   3. unattached uploads past expires_at
 *   4. webhook deliveries older than WEBHOOK_LIMITS.deliveryRetentionDays
 *   5. audit retention.swept with counts only
 * usage_events / cost_records stay (no content; billing history).
 *
 * drainStorageDeletions (worker, every 30 s): storage_deletions_claim →
 * storage.delete → storage_deletions_complete / _failed (backoff up to a day).
 * Every attachments row deletion queues its object (trigger), whatever caused it.
 */
import { TERMINAL_STATUSES, WEBHOOK_LIMITS, type RetentionPreferences } from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type Db, type DbContext } from '../../../db/pool';
import type { JobRow } from '../../../db/types';
import { resolvePreferences } from '../../account/me';
import { audit } from '../../audit/audit';
import { withSpan } from '../../../observability/tracing';
import { enqueue } from '../../jobs/queue';
import type { ObjectStorage } from '../../storage/types';
import { nowOf, type RuntimeDeps, type RuntimeLogger } from '../runtime';

export const RETENTION_BATCH = 500;
const DAY_MS = 86_400_000;

/** Enqueues a retention.sweep job for every user with something to sweep. Returns how many. */
export async function enqueueRetentionSweeps(deps: Pick<RuntimeDeps, 'db'>): Promise<number> {
  let after: string | null = null;
  let enqueued = 0;
  for (;;) {
    const page: { rows: { tenant_id: string; user_id: string }[] } = await sql<{
      tenant_id: string;
      user_id: string;
    }>`
        SELECT * FROM retention_due_users(${after}::uuid, ${RETENTION_BATCH})`.execute(deps.db);
    for (const row of page.rows) {
      const added = await deps.db.transaction().execute((trx) =>
        enqueue(trx, {
          kind: 'retention.sweep',
          tenantId: row.tenant_id,
          userId: row.user_id,
          dedupeKey: `retention:${row.user_id}`,
          maxAttempts: 3,
        }),
      );
      if (added) enqueued++;
    }
    if (page.rows.length < RETENTION_BATCH) return enqueued;
    after = page.rows.at(-1)!.user_id;
  }
}

export interface RetentionCounts {
  memories: number;
  tasks: number;
  conversations: number;
  uploads: number;
  webhookDeliveries: number;
}

/** Runs `batch` in its own transaction until it deletes fewer than RETENTION_BATCH rows. */
async function inBatches(
  db: Db,
  ctx: DbContext,
  batch: (trx: Parameters<Parameters<typeof withContext>[2]>[0]) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withContext(db, ctx, batch);
    total += n;
    if (n < RETENTION_BATCH) return total;
  }
}

/** One user's sweep. Exported for tests (the job calls it). */
export async function sweepUser(
  deps: Pick<RuntimeDeps, 'db' | 'now'>,
  ctx: DbContext,
): Promise<RetentionCounts> {
  const now = nowOf(deps);
  const retention: RetentionPreferences = await withContext(deps.db, ctx, async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select('preferences')
      .where('id', '=', ctx.userId)
      .executeTakeFirst();
    return resolvePreferences(user?.preferences).retention;
  });
  const counts: RetentionCounts = {
    memories: 0,
    tasks: 0,
    conversations: 0,
    uploads: 0,
    webhookDeliveries: 0,
  };

  if (retention.memoryDays !== null) {
    const cutoff = new Date(now.getTime() - retention.memoryDays * DAY_MS);
    counts.memories = await inBatches(deps.db, ctx, async (trx) => {
      const rows = await trx
        .deleteFrom('memories')
        .where(
          'id',
          'in',
          trx
            .selectFrom('memories')
            .select('id')
            .where('updated_at', '<', cutoff)
            .limit(RETENTION_BATCH),
        )
        .returning('id')
        .execute();
      return rows.length;
    });
  }

  if (retention.taskHistoryDays !== null) {
    const cutoff = new Date(now.getTime() - retention.taskHistoryDays * DAY_MS);
    counts.tasks = await inBatches(deps.db, ctx, async (trx) => {
      const ids = (
        await trx
          .selectFrom('tasks')
          .select('id')
          .where('created_at', '<', cutoff)
          .where('status', 'in', TERMINAL_STATUSES)
          .orderBy('created_at')
          .limit(RETENTION_BATCH)
          .forUpdate()
          .skipLocked()
          .execute()
      ).map((r) => r.id);
      if (ids.length === 0) return 0;
      await trx.deleteFrom('messages').where('task_id', 'in', ids).execute();
      const gone = await trx.deleteFrom('tasks').where('id', 'in', ids).returning('id').execute();
      return gone.length;
    });
    counts.conversations = await inBatches(deps.db, ctx, async (trx) => {
      const rows = await trx
        .deleteFrom('conversations')
        .where(
          'id',
          'in',
          trx
            .selectFrom('conversations as c')
            .select('c.id')
            .where('c.updated_at', '<', cutoff)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('tasks as t')
                    .select('t.id')
                    .whereRef('t.conversation_id', '=', 'c.id'),
                ),
              ),
            )
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('scheduled_tasks as s')
                    .select('s.id')
                    .whereRef('s.conversation_id', '=', 'c.id'),
                ),
              ),
            )
            .limit(RETENTION_BATCH),
        )
        .returning('id')
        .execute();
      return rows.length;
    });
  }

  counts.uploads = await inBatches(deps.db, ctx, async (trx) => {
    const rows = await trx
      .deleteFrom('attachments')
      .where(
        'id',
        'in',
        trx
          .selectFrom('attachments')
          .select('id')
          .where('conversation_id', 'is', null)
          .where('expires_at', '<', now)
          .limit(RETENTION_BATCH),
      )
      .returning('id')
      .execute();
    return rows.length;
  });

  const deliveryCutoff = new Date(now.getTime() - WEBHOOK_LIMITS.deliveryRetentionDays * DAY_MS);
  counts.webhookDeliveries = await inBatches(deps.db, ctx, async (trx) => {
    const rows = await trx
      .deleteFrom('webhook_deliveries')
      .where(
        'id',
        'in',
        trx
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('created_at', '<', deliveryCutoff)
          .where('status', '<>', 'pending')
          .limit(RETENTION_BATCH),
      )
      .returning('id')
      .execute();
    return rows.length;
  });

  await withContext(deps.db, ctx, (trx) =>
    audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'retention.swept',
      targetType: 'user',
      targetId: ctx.userId,
      metadata: { ...counts },
    }),
  );
  return counts;
}

export async function handleRetentionJob(deps: RuntimeDeps, job: JobRow): Promise<'done'> {
  const counts = await withSpan('retention.sweep', { 'jarvis.job.id': job.id }, () =>
    sweepUser(deps, { tenantId: job.tenant_id, userId: job.user_id }),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) deps.log.info('retention sweep deleted expired rows', { ...counts });
  return 'done';
}

/** Deletes queued storage objects. Returns how many were deleted. */
export async function drainStorageDeletions(deps: {
  db: Db;
  storage: ObjectStorage | null;
  log: RuntimeLogger;
  limit?: number;
}): Promise<number> {
  const claimed = await sql<{
    id: number;
    storage_driver: string;
    storage_key: string;
    attempts: number;
  }>`SELECT * FROM storage_deletions_claim(${deps.limit ?? 100}, 300)`.execute(deps.db);
  const done: number[] = [];
  for (const row of claimed.rows) {
    if (!deps.storage || deps.storage.driver !== row.storage_driver) {
      // Retried with backoff; operations alert on old rows (a driver was switched off).
      await sql`SELECT storage_deletions_failed(${row.id}, ${`storage driver ${row.storage_driver} not configured`})`.execute(
        deps.db,
      );
      continue;
    }
    try {
      const storage = deps.storage;
      await withSpan(
        'storage.op',
        { 'jarvis.storage.op': 'delete', 'jarvis.storage.driver': storage.driver },
        () => storage.delete(row.storage_key),
      );
      done.push(row.id);
    } catch (err) {
      deps.log.warn('storage deletion failed', { id: row.id, attempts: row.attempts });
      await sql`SELECT storage_deletions_failed(${row.id}, ${String(err instanceof Error ? err.message : err).slice(0, 500)})`.execute(
        deps.db,
      );
    }
  }
  if (done.length > 0)
    await sql`SELECT storage_deletions_complete(${done}::bigint[])`.execute(deps.db);
  return done.length;
}
