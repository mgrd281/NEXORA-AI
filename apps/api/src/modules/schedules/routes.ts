/** Schedules HTTP surface (docs/architecture/phase-b.md §3.5). */
import type { FastifyInstance } from 'fastify';
import { SCHEDULE_LIMITS, type Recurrence, type ScheduleDetail } from '@jarvis/contracts';
import { withContext, type Trx } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { taskSummaryQuery, toTaskSummary, type TaskAggregate } from '../tasks/mappers';
import { toSchedule, toScheduleRun } from './mappers';
import { occurrencesAfter, toRRuleString } from './recurrence';
import {
  deleteSchedule,
  insertSchedule,
  nextOccurrence,
  pauseSchedule,
  resolveRecurrence,
  resumeSchedule,
  scheduleCompletedError,
  updateSchedule,
} from './service';

/** A schedule with its next occurrences and newest runs (each with its task, when it still exists). */
export async function loadScheduleDetail(
  trx: Trx,
  scheduleId: string,
): Promise<ScheduleDetail | null> {
  const row = await trx
    .selectFrom('scheduled_tasks')
    .selectAll()
    .where('id', '=', scheduleId)
    .executeTakeFirst();
  if (!row) return null;
  const upcoming: Date[] = [];
  if (row.status === 'active' && row.next_run_at) {
    upcoming.push(row.next_run_at);
    let cursor = row.next_run_at;
    while (upcoming.length < SCHEDULE_LIMITS.upcomingShown) {
      const next = nextOccurrence(row, cursor);
      if (!next) break;
      upcoming.push(next);
      cursor = next;
    }
  }
  const runs = await trx
    .selectFrom('schedule_runs')
    .selectAll()
    .where('schedule_id', '=', scheduleId)
    .orderBy('occurrence_at', 'desc')
    .orderBy('id', 'desc')
    .limit(SCHEDULE_LIMITS.runsShown)
    .execute();
  const taskIds = runs.map((r) => r.task_id).filter((id): id is string => !!id);
  const tasks = taskIds.length
    ? ((await taskSummaryQuery(trx).where('t.id', 'in', taskIds).execute()) as TaskAggregate[])
    : [];
  const byId = new Map(tasks.map((t) => [t.id, toTaskSummary(t)]));
  return {
    ...toSchedule(row),
    upcoming: upcoming.map((d) => d.toISOString()),
    runs: runs.map((r) => toScheduleRun(r, r.task_id ? (byId.get(r.task_id) ?? null) : null)),
  };
}

export function registerScheduleRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listSchedules', async ({ ctx }) => {
    const rows = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('scheduled_tasks')
        .selectAll()
        .where('user_id', '=', ctx.userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute(),
    );
    return { items: rows.map(toSchedule) };
  });

  defineRoute(app, deps, 'createSchedule', async ({ ctx, body }) =>
    toSchedule(
      await withContext(db, ctx, (trx) => insertSchedule(trx, ctx, body, { createdBy: 'user' })),
    ),
  );

  defineRoute(app, deps, 'previewSchedule', async ({ ctx, body }) => {
    const recurrence: Recurrence = await withContext(db, ctx, (trx) =>
      resolveRecurrence(trx, body.recurrence),
    );
    const now = new Date();
    const occurrences = occurrencesAfter(recurrence, {
      anchor: now,
      after: now,
      limit: body.count,
    });
    return {
      rrule: toRRuleString(recurrence, occurrences[0] ?? now),
      occurrences: occurrences.map((d) => d.toISOString()),
      timeZone: recurrence.timeZone,
    };
  });

  defineRoute(app, deps, 'getSchedule', async ({ ctx, params }) => {
    const detail = await withContext(db, ctx, (trx) => loadScheduleDetail(trx, params.id));
    if (!detail) throw notFound('Schedule');
    return detail;
  });

  defineRoute(app, deps, 'updateSchedule', async ({ ctx, params, body }) =>
    toSchedule(await withContext(db, ctx, (trx) => updateSchedule(trx, ctx, params.id, body))),
  );

  defineRoute(app, deps, 'deleteSchedule', async ({ ctx, params }) => {
    await withContext(db, ctx, (trx) => deleteSchedule(trx, ctx, params.id));
  });

  defineRoute(app, deps, 'pauseSchedule', async ({ ctx, params }) =>
    toSchedule(await withContext(db, ctx, (trx) => pauseSchedule(trx, ctx, params.id, 'user'))),
  );

  defineRoute(app, deps, 'resumeSchedule', async ({ ctx, params }) => {
    // Committed either way: a schedule whose series ended is stored as completed.
    const { row, completed } = await withContext(db, ctx, (trx) =>
      resumeSchedule(trx, ctx, params.id),
    );
    if (completed) throw scheduleCompletedError();
    return toSchedule(row);
  });
}
