/**
 * Reply tracking (docs/architecture/phase-c.md §3.2): email.track_replies
 * inserts one email_watches row per step (unique step_id; one live watch per
 * thread and account), with the newest message as the baseline. The worker's
 * tick enqueues email.watch_poll for due watches (email_watches_due, ids
 * only; dedupe email-watch:<id>); the job, in the owner's RLS context, reads
 * the thread's messages after the baseline: one from someone other than the
 * account → 'replied' + notification email_reply_received; nothing → next
 * check in watchPollMinutes; past expires_at → 'expired'; connection gone /
 * thread gone → 'failed'. Only the subject and the sender are kept.
 */
import { EMAIL_LIMITS, type EmailWatch } from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type DbContext, type Trx } from '../../db/pool';
import type { EmailWatchRow } from '../../db/types';
import { truncate } from '../../lib/redact';
import { AgentError, isUniqueViolation } from '../agent/errors';
import { appendEvent } from '../events/events';
import { enqueue } from '../jobs/queue';
import { createNotification } from '../notifications/create';
import { mailClient, sameMailbox } from './mail';
import { isOAuthProvider, type IntegrationDeps, type OAuthProvider } from './types';

/** After this many failed checks in a row a watch stops ('failed'). */
export const WATCH_MAX_FAILURES = 6;

export function toEmailWatch(r: EmailWatchRow): EmailWatch {
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    provider: r.provider,
    connectionId: r.connection_id,
    threadId: r.thread_id,
    subject: r.subject,
    status: r.status,
    taskId: r.task_id,
    lastCheckedAt: iso(r.last_checked_at),
    nextCheckAt: iso(r.next_check_at),
    replyAt: iso(r.reply_at),
    replyFrom: r.reply_from_address
      ? { name: r.reply_from_name, address: r.reply_from_address }
      : null,
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function changed(
  trx: Trx,
  ctx: DbContext,
  w: Pick<EmailWatchRow, 'id' | 'status' | 'task_id'>,
  change: string,
) {
  await appendEvent(trx, ctx, {
    taskId: null,
    type: 'email_watch.changed',
    data: { watchId: w.id, status: w.status, change },
  });
}

/**
 * Creates the watch of one email.track_replies step (exactly once: an
 * existing row of the step is returned, as is the live watch of the same
 * thread). Throws WATCH_LIMIT_REACHED beyond EMAIL_LIMITS.watchMaxPerUser.
 */
export async function createWatch(
  deps: IntegrationDeps,
  ctx: DbContext,
  w: {
    connectionId: string;
    provider: OAuthProvider;
    threadId: string;
    subject: string;
    taskId: string;
    stepId: string;
    days: number;
    baseline: { messageId: string; at: string } | null;
    now?: Date;
  },
): Promise<{ row: EmailWatchRow; created: boolean }> {
  const now = w.now ?? new Date();
  return withContext(deps.db, ctx, async (trx) => {
    const ofStep = await trx
      .selectFrom('email_watches')
      .selectAll()
      .where('step_id', '=', w.stepId)
      .executeTakeFirst();
    if (ofStep) return { row: ofStep, created: false };
    const live = await trx
      .selectFrom('email_watches')
      .selectAll()
      .where('connection_id', '=', w.connectionId)
      .where('thread_id', '=', w.threadId)
      .where('status', '=', 'watching')
      .executeTakeFirst();
    if (live) return { row: live, created: false };
    const count = await trx
      .selectFrom('email_watches')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', '=', 'watching')
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= EMAIL_LIMITS.watchMaxPerUser)
      throw new AgentError(
        'TOOL_FAILED',
        `JARVIS already watches ${EMAIL_LIMITS.watchMaxPerUser} conversations. Stop one first.`,
        {
          retryable: false,
          reason: 'WATCH_LIMIT_REACHED',
          params: { max: EMAIL_LIMITS.watchMaxPerUser },
        },
      );
    const days = Math.min(EMAIL_LIMITS.watchMaxDays, Math.max(1, Math.floor(w.days)));
    try {
      const row = await trx
        .insertInto('email_watches')
        .values({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          connection_id: w.connectionId,
          provider: w.provider,
          thread_id: w.threadId,
          subject: truncate(w.subject, 300),
          task_id: w.taskId,
          step_id: w.stepId,
          status: 'watching',
          last_seen_message_id: w.baseline?.messageId ?? null,
          last_seen_at: w.baseline ? new Date(w.baseline.at) : null,
          last_checked_at: now,
          next_check_at: new Date(now.getTime() + EMAIL_LIMITS.watchPollMinutes * 60_000),
          created_at: now,
          expires_at: new Date(now.getTime() + days * 86_400_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await changed(trx, ctx, row, 'created');
      return { row, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new AgentError('TOOL_FAILED', 'This conversation is already being watched.', {
        retryable: true,
        transient: true,
      });
    }
  });
}

/** DELETE /v1/email/watches/:id: stops watching (the row stays, 'stopped'). Null when not visible. */
export async function stopWatch(
  trx: Trx,
  ctx: DbContext,
  watchId: string,
): Promise<EmailWatchRow | null> {
  const stopped = await trx
    .updateTable('email_watches')
    .set({ status: 'stopped', next_check_at: null })
    .where('id', '=', watchId)
    .where('status', '=', 'watching')
    .returningAll()
    .executeTakeFirst();
  if (stopped) {
    await changed(trx, ctx, stopped, 'stopped');
    return stopped;
  }
  return (
    (await trx
      .selectFrom('email_watches')
      .selectAll()
      .where('id', '=', watchId)
      .executeTakeFirst()) ?? null
  );
}

type PollResult = 'replied' | 'watching' | 'expired' | 'failed' | 'skipped';

async function finish(
  deps: IntegrationDeps,
  ctx: DbContext,
  watchId: string,
  status: 'expired' | 'failed',
  now: Date,
): Promise<PollResult> {
  return withContext(deps.db, ctx, async (trx) => {
    const row = await trx
      .updateTable('email_watches')
      .set({ status, next_check_at: null, last_checked_at: now })
      .where('id', '=', watchId)
      .where('status', '=', 'watching')
      .returningAll()
      .executeTakeFirst();
    if (row) await changed(trx, ctx, row, status);
    return row ? status : 'skipped';
  });
}

/** One check of one watch (the email.watch_poll job). Safe to run twice. */
export async function pollWatch(
  deps: IntegrationDeps,
  ctx: DbContext,
  watchId: string,
  now: Date = new Date(),
): Promise<PollResult> {
  const loaded = await withContext(deps.db, ctx, async (trx) => {
    const watch = await trx
      .selectFrom('email_watches')
      .selectAll()
      .where('id', '=', watchId)
      .executeTakeFirst();
    if (!watch) return null;
    const conn = await trx
      .selectFrom('connections')
      .select(['id', 'provider', 'status', 'account_identifier', 'capabilities'])
      .where('id', '=', watch.connection_id)
      .executeTakeFirst();
    return { watch, conn };
  });
  if (!loaded || loaded.watch.status !== 'watching') return 'skipped';
  const { watch, conn } = loaded;
  if (now.getTime() >= new Date(watch.expires_at).getTime())
    return finish(deps, ctx, watchId, 'expired', now);
  if (
    !conn ||
    conn.status !== 'active' ||
    !isOAuthProvider(conn.provider) ||
    !conn.capabilities.includes('mail.read')
  )
    return finish(deps, ctx, watchId, 'failed', now);
  const account = conn.account_identifier ?? '';
  let thread;
  try {
    thread = await mailClient(deps, ctx, {
      id: conn.id,
      provider: conn.provider,
      accountIdentifier: conn.account_identifier,
    }).threadMeta(watch.thread_id);
  } catch (err) {
    const definite =
      err instanceof AgentError &&
      (err.code === 'CONNECTION_REQUIRED' ||
        err.reason === 'EMAIL_THREAD_NOT_FOUND' ||
        err.reason === 'PROVIDER_REJECTED');
    if (definite || watch.consecutive_failures + 1 >= WATCH_MAX_FAILURES)
      return finish(deps, ctx, watchId, 'failed', now);
    await withContext(deps.db, ctx, (trx) =>
      trx
        .updateTable('email_watches')
        .set({
          consecutive_failures: sql<number>`consecutive_failures + 1`,
          last_checked_at: now,
          next_check_at: new Date(now.getTime() + EMAIL_LIMITS.watchPollMinutes * 60_000),
        })
        .where('id', '=', watchId)
        .where('status', '=', 'watching')
        .execute(),
    );
    return 'watching';
  }
  if (!thread) return finish(deps, ctx, watchId, 'failed', now);
  const baselineAt = watch.last_seen_at
    ? new Date(watch.last_seen_at).getTime()
    : new Date(watch.created_at).getTime();
  const newer = thread.messages.filter(
    (m) => new Date(m.date).getTime() > baselineAt && m.id !== watch.last_seen_message_id,
  );
  // A reply: someone other than the account, and not an automatic answer (out of office, lists).
  const reply = newer.find((m) => !sameMailbox(m.from.address, account) && !m.automated);
  return withContext(deps.db, ctx, async (trx): Promise<PollResult> => {
    if (reply) {
      const row = await trx
        .updateTable('email_watches')
        .set({
          status: 'replied',
          next_check_at: null,
          last_checked_at: now,
          consecutive_failures: 0,
          reply_message_id: truncate(reply.id, 512),
          reply_from_name: reply.from.name ? truncate(reply.from.name, 200) : null,
          reply_from_address: truncate(reply.from.address, 320),
          reply_at: new Date(reply.date),
        })
        .where('id', '=', watchId)
        .where('status', '=', 'watching')
        .returningAll()
        .executeTakeFirst();
      if (!row) return 'skipped';
      await createNotification(trx, ctx, 'email_reply_received', row.task_id, {
        watchId: row.id,
        provider: row.provider,
        subject: row.subject,
        fromAddress: row.reply_from_address ?? '',
      });
      await changed(trx, ctx, row, 'replied');
      return 'replied';
    }
    const newest = thread.messages.at(-1);
    await trx
      .updateTable('email_watches')
      .set({
        last_checked_at: now,
        consecutive_failures: 0,
        next_check_at: new Date(now.getTime() + EMAIL_LIMITS.watchPollMinutes * 60_000),
        ...(newest && new Date(newest.date).getTime() > baselineAt
          ? { last_seen_message_id: truncate(newest.id, 512), last_seen_at: new Date(newest.date) }
          : {}),
      })
      .where('id', '=', watchId)
      .where('status', '=', 'watching')
      .execute();
    return 'watching';
  });
}

/** The worker's tick: due watches → email.watch_poll jobs (dedupe email-watch:<id>). */
export async function enqueueDueWatches(deps: IntegrationDeps, limit = 500): Promise<number> {
  const due = await sql<{ watch_id: string; tenant_id: string; user_id: string }>`
    SELECT watch_id, tenant_id, user_id FROM email_watches_due(${limit})`.execute(deps.db);
  let n = 0;
  for (const w of due.rows) {
    const added = await deps.db.transaction().execute((trx) =>
      enqueue(trx, {
        kind: 'email.watch_poll',
        tenantId: w.tenant_id,
        userId: w.user_id,
        payload: { watchId: w.watch_id },
        dedupeKey: `email-watch:${w.watch_id}`,
        maxAttempts: 3,
      }),
    );
    if (added) n++;
  }
  return n;
}
