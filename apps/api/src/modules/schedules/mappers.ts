/** Schedule rows → contract. */
import type { Recurrence, Schedule, ScheduleRun, TaskSummary } from '@jarvis/contracts';
import type { ScheduleRow, ScheduleRunRow } from '../../db/types';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function rowRecurrence(row: Pick<ScheduleRow, 'recurrence'>): Recurrence {
  return row.recurrence as Recurrence;
}

export function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    title: row.title,
    request: row.request,
    language: row.language,
    recurrence: rowRecurrence(row),
    rrule: row.rrule,
    status: row.status,
    pausedReason: row.paused_reason,
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    lastTaskId: row.last_task_id,
    conversationId: row.conversation_id,
    runCount: row.run_count,
    consecutiveFailures: row.consecutive_failures,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toScheduleRun(row: ScheduleRunRow, task: TaskSummary | null): ScheduleRun {
  return {
    id: row.id,
    occurrenceAt: new Date(row.occurrence_at).toISOString(),
    status: row.status,
    reason: row.reason,
    task,
    createdAt: row.created_at.toISOString(),
  };
}
