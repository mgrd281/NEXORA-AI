/**
 * Schedule state (docs/architecture/phase-b.md §3.5). Every function runs
 * inside the caller's RLS-scoped transaction; the HTTP routes and the
 * runtime's scheduler (schedule.run) and schedule.create tool share them, so
 * a schedule changes state in exactly one way whoever changes it.
 *
 *   insertSchedule        create (user or agent), validated and normalised
 *   lockDueSchedule       the scheduler's row lock (SKIP LOCKED) on a due schedule
 *   advanceSchedule       after an occurrence ran: counters and the next run
 *   recordScheduleRunResult  a run's task ended: failure counting, auto-pause
 *   pauseSchedule / resumeSchedule / updateSchedule / deleteSchedule
 *
 * A user-created schedule needs no approval (the user acts directly); every
 * run is still planned and checked by the Policy Engine when it runs.
 */
import { sql } from 'kysely';
import {
  CreateScheduleRequest,
  Recurrence,
  SCHEDULE_LIMITS,
  type ApiErrorReason,
  type SchedulePauseReason,
  type UpdateScheduleRequest,
} from '@jarvis/contracts';
import type { DbContext, Trx } from '../../db/pool';
import type { ScheduleRow } from '../../db/types';
import { AppError, notFound } from '../../lib/errors';
import { canonicalTimeZone } from '../../lib/period';
import { asLocale } from '../agent/i18n';
import { detectLanguage } from '../agent/models/offline';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { toSchedule } from './mappers';
import {
  normalizeRecurrence,
  occurrencesAfter,
  scheduleOccurrencesAfter,
  toRRuleString,
} from './recurrence';

export { toSchedule };

type ScheduleChange =
  'created' | 'updated' | 'paused' | 'resumed' | 'completed' | 'deleted' | 'run';

const reasonError = (
  code: ConstructorParameters<typeof AppError>[0],
  reason: ApiErrorReason,
  message: string,
  extra: Record<string, unknown> = {},
) => new AppError(code, message, { reason, ...extra });

export const unknownTimeZoneError = () =>
  reasonError('VALIDATION_FAILED', 'UNKNOWN_TIME_ZONE', 'Unknown time zone', {
    issues: [{ path: 'recurrence.timeZone', message: 'Unknown time zone' }],
  });

const noOccurrencesError = () =>
  reasonError(
    'VALIDATION_FAILED',
    'RECURRENCE_HAS_NO_OCCURRENCES',
    'This recurrence has no future occurrences',
    { issues: [{ path: 'recurrence', message: 'No future occurrences' }] },
  );

const limitError = () =>
  reasonError('CONFLICT', 'SCHEDULE_LIMIT_REACHED', 'Schedule limit reached', {
    max: SCHEDULE_LIMITS.maxPerUser,
  });

export const scheduleCompletedError = () =>
  reasonError('INVALID_STATE', 'SCHEDULE_COMPLETED', 'This schedule has no more occurrences');

const invalidRecurrenceError = (issues: { path: string; message: string }[]) =>
  reasonError('VALIDATION_FAILED', 'INVALID_RECURRENCE', 'Invalid recurrence', { issues });

/** Serialises schedule creation per user (the per-user cap) without touching row locks. */
async function lockUserSchedules(trx: Trx, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`schedules:${userId}`}, 0))`.execute(
    trx,
  );
}

async function assertBelowLimit(trx: Trx, userId: string): Promise<void> {
  const { n } = await trx
    .selectFrom('scheduled_tasks')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('status', '<>', 'completed')
    .executeTakeFirstOrThrow();
  if (Number(n) >= SCHEDULE_LIMITS.maxPerUser) throw limitError();
}

/**
 * A recurrence the server accepts: contract-valid, in a zone both Postgres
 * and Node know (stored in Postgres's spelling), normalised.
 */
export async function resolveRecurrence(trx: Trx, input: unknown): Promise<Recurrence> {
  const parsed = Recurrence.safeParse(input);
  if (!parsed.success) {
    throw invalidRecurrenceError(
      parsed.error.issues.map((i) => ({
        path: ['recurrence', ...i.path].join('.'),
        message: i.message,
      })),
    );
  }
  const zone = await canonicalTimeZone(trx, parsed.data.timeZone);
  if (!zone) throw unknownTimeZoneError();
  return normalizeRecurrence(parsed.data, zone);
}

/** First occurrence of a new series starting now, and the RRULE text anchored on it. */
function startSeries(r: Recurrence, now: Date): { first: Date; rrule: string } {
  const first = occurrencesAfter(r, { anchor: now, after: now, limit: 1 })[0];
  if (!first) throw noOccurrencesError();
  return { first, rrule: toRRuleString(r, first) };
}

function seriesOf(row: ScheduleRow) {
  return { recurrence: row.recurrence as Recurrence, rrule: row.rrule, createdAt: row.created_at };
}

/** The next occurrence of a stored schedule strictly after `after`, or null when the series ended. */
export function nextOccurrence(row: ScheduleRow, after: Date): Date | null {
  return scheduleOccurrencesAfter(seriesOf(row), after, 1)[0] ?? null;
}

async function changed(
  trx: Trx,
  ctx: DbContext,
  row:
    | Pick<ScheduleRow, 'id' | 'status' | 'next_run_at'>
    | { id: string; status: null; next_run_at: null },
  change: ScheduleChange,
): Promise<void> {
  await appendEvent(trx, ctx, {
    taskId: null,
    type: 'schedule.changed',
    data: {
      scheduleId: row.id,
      change,
      status: row.status,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    },
  });
}

async function lockSchedule(trx: Trx, scheduleId: string): Promise<ScheduleRow> {
  const row = await trx
    .selectFrom('scheduled_tasks')
    .selectAll()
    .where('id', '=', scheduleId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound('Schedule');
  return row;
}

/* ------------------------------------------------------------------ */
/* Cross-boundary API (frozen signatures, phase-b.md §4)               */
/* ------------------------------------------------------------------ */

export async function insertSchedule(
  trx: Trx,
  ctx: DbContext,
  input: CreateScheduleRequest,
  meta: { createdBy: 'user' | 'agent'; createdByTaskId?: string | null; now?: Date },
): Promise<ScheduleRow> {
  const now = meta.now ?? new Date();
  const createdByTaskId = meta.createdBy === 'agent' ? (meta.createdByTaskId ?? null) : null;
  if (createdByTaskId) {
    // The approved schedule.create step may run again (retry, resume): one schedule per step.
    const existing = await trx
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('created_by_task_id', '=', createdByTaskId)
      .executeTakeFirst();
    if (existing) return existing;
  }
  const parsed = CreateScheduleRequest.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    if (issues.some((i) => i.path.startsWith('recurrence'))) throw invalidRecurrenceError(issues);
    throw new AppError('VALIDATION_FAILED', 'Invalid schedule', { issues });
  }
  const body = parsed.data;
  const recurrence = await resolveRecurrence(trx, body.recurrence);

  await lockUserSchedules(trx, ctx.userId);
  await assertBelowLimit(trx, ctx.userId);
  const { first, rrule } = startSeries(recurrence, now);

  const user = await trx
    .selectFrom('users')
    .select('locale')
    .where('id', '=', ctx.userId)
    .executeTakeFirstOrThrow();
  const language = body.language ?? detectLanguage(body.request, asLocale(user.locale));

  const row = await trx
    .insertInto('scheduled_tasks')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      title: body.title,
      request: body.request,
      rrule,
      time_zone: recurrence.timeZone,
      recurrence: JSON.stringify(recurrence),
      status: 'active',
      next_run_at: first,
      language,
      created_by: meta.createdBy,
      created_by_task_id: createdByTaskId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await changed(trx, ctx, row, 'created');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: meta.createdBy === 'agent' ? 'agent' : 'user',
    actorId: ctx.userId,
    action: 'schedule.created',
    targetType: 'schedule',
    targetId: row.id,
    // Shape only: never the title or request text.
    metadata: {
      frequency: recurrence.frequency,
      interval: recurrence.interval,
      createdBy: meta.createdBy,
      ...(createdByTaskId ? { taskId: createdByTaskId } : {}),
    },
  });
  return row;
}

/** The scheduler's lock on one schedule: null unless it is active and due (another worker may hold it). */
export async function lockDueSchedule(
  trx: Trx,
  scheduleId: string,
  now: Date,
): Promise<ScheduleRow | null> {
  const row = await trx
    .selectFrom('scheduled_tasks')
    .selectAll()
    .where('id', '=', scheduleId)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (!row || row.status !== 'active' || !row.next_run_at) return null;
  return row.next_run_at.getTime() <= now.getTime() ? row : null;
}

/**
 * After an occurrence was handled: last run, last task, run count (runs that
 * created a task), and the next run — the first occurrence after
 * max(now, occurrenceAt), so missed occurrences collapse into one run — or
 * 'completed' when the series has ended.
 */
export async function advanceSchedule(
  trx: Trx,
  ctx: DbContext,
  schedule: ScheduleRow,
  run: { occurrenceAt: Date; taskId: string | null; now: Date },
): Promise<ScheduleRow> {
  const base = new Date(Math.max(run.now.getTime(), run.occurrenceAt.getTime()));
  const next = schedule.status === 'active' ? nextOccurrence(schedule, base) : null;
  const status = schedule.status === 'active' ? (next ? 'active' : 'completed') : schedule.status;
  const row = await trx
    .updateTable('scheduled_tasks')
    .set({
      last_run_at: run.now,
      ...(run.taskId ? { last_task_id: run.taskId, run_count: sql<number>`run_count + 1` } : {}),
      status,
      next_run_at: status === 'active' ? next : null,
    })
    .where('id', '=', schedule.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await changed(trx, ctx, row, 'run');
  return row;
}

/**
 * A run's task ended. Failures count up and pause the schedule after
 * SCHEDULE_LIMITS.failuresBeforePause in a row; a success resets the count.
 */
export async function recordScheduleRunResult(
  trx: Trx,
  ctx: DbContext,
  scheduleId: string,
  result: 'succeeded' | 'failed',
): Promise<{ paused: boolean; schedule: ScheduleRow } | null> {
  const current = await trx
    .selectFrom('scheduled_tasks')
    .selectAll()
    .where('id', '=', scheduleId)
    .forUpdate()
    .executeTakeFirst();
  if (!current) return null;
  if (result === 'succeeded') {
    if (current.consecutive_failures === 0) return { paused: false, schedule: current };
    const row = await trx
      .updateTable('scheduled_tasks')
      .set({ consecutive_failures: 0 })
      .where('id', '=', scheduleId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { paused: false, schedule: row };
  }
  const failures = current.consecutive_failures + 1;
  const pause = current.status === 'active' && failures >= SCHEDULE_LIMITS.failuresBeforePause;
  const row = await trx
    .updateTable('scheduled_tasks')
    .set({
      consecutive_failures: failures,
      last_failure_at: sql<Date>`now()`,
      ...(pause
        ? { status: 'paused' as const, paused_reason: 'failures' as const, next_run_at: null }
        : {}),
    })
    .where('id', '=', scheduleId)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (pause) {
    await changed(trx, ctx, row, 'paused');
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'schedule.paused',
      targetType: 'schedule',
      targetId: scheduleId,
      metadata: { reason: 'failures', consecutiveFailures: failures },
    });
  }
  return { paused: pause, schedule: row };
}

/** Pauses an active schedule (idempotent for a paused one; a completed one cannot be paused). */
export async function pauseSchedule(
  trx: Trx,
  ctx: DbContext,
  scheduleId: string,
  reason: SchedulePauseReason,
): Promise<ScheduleRow> {
  const current = await lockSchedule(trx, scheduleId);
  if (current.status === 'completed') throw scheduleCompletedError();
  if (current.status === 'paused') return current;
  const row = await trx
    .updateTable('scheduled_tasks')
    .set({ status: 'paused', paused_reason: reason, next_run_at: null })
    .where('id', '=', scheduleId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await changed(trx, ctx, row, 'paused');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: reason === 'user' ? 'user' : 'system',
    actorId: reason === 'user' ? ctx.userId : null,
    action: 'schedule.paused',
    targetType: 'schedule',
    targetId: scheduleId,
    metadata: { reason },
  });
  return row;
}

/* ------------------------------------------------------------------ */
/* HTTP operations                                                     */
/* ------------------------------------------------------------------ */

/**
 * Resumes a paused schedule from its next occurrence after now (failures
 * reset). A schedule whose series has ended becomes 'completed' and the
 * caller gets `completed: true` (the route answers 409 SCHEDULE_COMPLETED).
 */
export async function resumeSchedule(
  trx: Trx,
  ctx: DbContext,
  scheduleId: string,
  now = new Date(),
): Promise<{ row: ScheduleRow; completed: boolean }> {
  const current = await lockSchedule(trx, scheduleId);
  if (current.status === 'completed') return { row: current, completed: true };
  if (current.status === 'active') return { row: current, completed: false };
  const next = nextOccurrence(current, now);
  const row = await trx
    .updateTable('scheduled_tasks')
    .set(
      next
        ? { status: 'active', paused_reason: null, next_run_at: next, consecutive_failures: 0 }
        : { status: 'completed', paused_reason: null, next_run_at: null },
    )
    .where('id', '=', scheduleId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await changed(trx, ctx, row, next ? 'resumed' : 'completed');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: next ? 'schedule.resumed' : 'schedule.completed',
    targetType: 'schedule',
    targetId: scheduleId,
  });
  return { row, completed: !next };
}

/**
 * Title, request and/or recurrence. A new recurrence starts a new series
 * from now (new DTSTART): an active schedule gets its next run recomputed, a
 * paused one stays paused (resume picks the next occurrence), and a
 * completed one becomes active again (within the per-user cap).
 */
export async function updateSchedule(
  trx: Trx,
  ctx: DbContext,
  scheduleId: string,
  patch: UpdateScheduleRequest,
  now = new Date(),
): Promise<ScheduleRow> {
  const recurrence =
    patch.recurrence === undefined ? undefined : await resolveRecurrence(trx, patch.recurrence);
  const current = await lockSchedule(trx, scheduleId);
  const set: {
    title?: string;
    request?: string;
    language?: 'en' | 'de' | 'ar';
    recurrence?: string;
    rrule?: string;
    time_zone?: string;
    status?: 'active';
    next_run_at?: Date | null;
  } = {};
  const fields: string[] = [];
  if (patch.title !== undefined && patch.title !== current.title) {
    set.title = patch.title;
    fields.push('title');
  }
  if (patch.request !== undefined && patch.request !== current.request) {
    const user = await trx
      .selectFrom('users')
      .select('locale')
      .where('id', '=', ctx.userId)
      .executeTakeFirstOrThrow();
    set.request = patch.request;
    set.language = detectLanguage(patch.request, asLocale(current.language ?? user.locale));
    fields.push('request');
  }
  if (recurrence) {
    if (current.status === 'completed') {
      await lockUserSchedules(trx, ctx.userId);
      await assertBelowLimit(trx, ctx.userId);
    }
    const { first, rrule } = startSeries(recurrence, now);
    set.recurrence = JSON.stringify(recurrence);
    set.rrule = rrule;
    set.time_zone = recurrence.timeZone;
    if (current.status !== 'paused') {
      set.status = 'active';
      set.next_run_at = first;
    }
    fields.push('recurrence');
  }
  if (fields.length === 0) return current;
  const row = await trx
    .updateTable('scheduled_tasks')
    .set(set)
    .where('id', '=', scheduleId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await changed(trx, ctx, row, 'updated');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'schedule.updated',
    targetType: 'schedule',
    targetId: scheduleId,
    metadata: {
      fields,
      frequency: (row.recurrence as Recurrence).frequency,
    },
  });
  return row;
}

/** Deletes a schedule (its runs cascade; tasks it created stay, with schedule_id cleared). */
export async function deleteSchedule(trx: Trx, ctx: DbContext, scheduleId: string): Promise<void> {
  const row = await trx
    .deleteFrom('scheduled_tasks')
    .where('id', '=', scheduleId)
    .returning(['id', 'recurrence'])
    .executeTakeFirst();
  if (!row) throw notFound('Schedule');
  await changed(trx, ctx, { id: row.id, status: null, next_run_at: null }, 'deleted');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'schedule.deleted',
    targetType: 'schedule',
    targetId: row.id,
    metadata: { frequency: (row.recurrence as Recurrence).frequency },
  });
}
