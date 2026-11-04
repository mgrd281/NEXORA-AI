/**
 * schedule.create — store a schedule the planner proposed ("every Monday at 9
 * summarize <url> and email it to me"). docs/architecture/phase-b.md §3.5.
 *
 * Creating a schedule means future side effects, so it is MEDIUM and the
 * policy always asks first (FUTURE_RUNS, never auto-approved). The approval
 * shows the exact request each run will carry out, the recurrence, the
 * derived RRULE and the next runs. Nothing is pre-approved: every run is a
 * normal task, planned and policy-checked when it happens.
 *
 * Plan time: no references anywhere (validatePlanned) and every email address
 * and link inside `request` must be written in one of the user's own requests
 * of the conversation (literalTexts → validatePlan). Execution goes through
 * insertSchedule (schedules/service.ts), which is idempotent per creating task.
 */
import { Recurrence, SCHEDULE_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../db/pool';
import { AppError } from '../../../lib/errors';
import { truncate } from '../../../lib/redact';
import { normalizeRecurrence, occurrencesAfter, toRRuleString } from '../../schedules/recurrence';
import { insertSchedule } from '../../schedules/service';
import { AgentError } from '../errors';
import { msg, render } from '../i18n';
import { findMalformedRefs, findRefs } from '../templates';
import { check, evidence, type ToolDefinition } from './types';

export const ScheduleCreateInput = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Short name of the schedule, in the request language.'),
  request: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe(
      'What each run should do, as a complete request in the user’s words (without the timing), e.g. "Summarize https://example.com/news and email it to me".',
    ),
  recurrence: Recurrence.describe(
    'When it runs: frequency daily/weekly/monthly, interval, byWeekday (weekly), byMonthDay (monthly, -1 = last day), time "HH:MM", timeZone = the owner’s time zone.',
  ),
});
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInput>;

/** The canonical recurrence, its RRULE and the next runs — or nulls when it cannot be evaluated. */
export function schedulePreview(
  recurrence: Recurrence,
  now: Date,
): { recurrence: Recurrence; rrule: string; next: Date[] } | null {
  try {
    const r = normalizeRecurrence(recurrence, recurrence.timeZone);
    return {
      recurrence: r,
      rrule: toRRuleString(r, now),
      next: occurrencesAfter(r, { anchor: now, after: now, limit: SCHEDULE_LIMITS.upcomingShown }),
    };
  } catch {
    return null;
  }
}

function validZone(zone: unknown): boolean {
  if (typeof zone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** insertSchedule's AppErrors (details.reason) as step failures clients can explain. */
function scheduleError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof AppError) {
    const reason = (err.details as { reason?: string } | undefined)?.reason;
    if (reason === 'SCHEDULE_LIMIT_REACHED')
      return new AgentError('TOOL_FAILED', err.message, {
        retryable: false,
        reason: 'SCHEDULE_LIMIT_REACHED',
        params: { max: SCHEDULE_LIMITS.maxPerUser },
      });
    if (
      reason === 'INVALID_RECURRENCE' ||
      reason === 'RECURRENCE_HAS_NO_OCCURRENCES' ||
      reason === 'UNKNOWN_TIME_ZONE' ||
      err.code === 'VALIDATION_FAILED'
    )
      return new AgentError('TOOL_FAILED', err.message, {
        retryable: false,
        reason: 'INVALID_RECURRENCE',
      });
  }
  return new AgentError('INTERNAL', 'The schedule could not be saved.', { retryable: true });
}

export const scheduleCreateTool: ToolDefinition<ScheduleCreateInput> = {
  id: 'schedule.create',
  version: '1.0.0',
  description:
    'Create a schedule that runs a request repeatedly (daily, weekly on given weekdays, or monthly on given days) at a local time in the owner’s time zone. Each run is planned and checked when it happens. Use only when the user asks for something recurring ("every Monday at 9 …"). The user always confirms a new schedule. Output: scheduleId, nextRunAt.',
  inputSchema: ScheduleCreateInput,
  validatePlanned(input) {
    const issues: string[] = [];
    if (findRefs(input).length > 0 || findMalformedRefs(input).length > 0)
      issues.push(
        'schedule.create input must be literal; references to other steps are not allowed.',
      );
    if (input.recurrence && !validZone(input.recurrence.timeZone))
      issues.push(
        `schedule.create recurrence.timeZone (${String(input.recurrence.timeZone)}) is not a known time zone.`,
      );
    return issues;
  },
  literalTexts: (input) => [input.request, input.title],
  outputFields: ['scheduleId', 'nextRunAt', 'title'],
  requiredConnection: null,
  permissions: ['schedules:write'],
  sideEffect: 'internal',
  idempotency: 'once_per_step',
  timeoutMs: 10_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  riskLevel: () => 'MEDIUM',
  estimateCostMicro: () => 0,
  preview: (input) => ({
    title: input.title,
    request: truncate(input.request, 500),
    recurrence: input.recurrence,
  }),
  approvalDetails(input, ctx) {
    const preview = schedulePreview(input.recurrence, ctx.now ?? new Date());
    const summaryMessage = msg('approval.schedule', { title: input.title });
    return {
      details: {
        kind: 'schedule',
        title: input.title,
        request: input.request,
        recurrence: preview?.recurrence ?? input.recurrence,
        rrule: preview?.rrule ?? '',
        nextOccurrences: (preview?.next ?? []).map((d) => d.toISOString()),
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  async execute(input, rt) {
    let row;
    try {
      row = await withContext(rt.db, rt.ctx, (trx) =>
        insertSchedule(
          trx,
          rt.ctx,
          {
            title: input.title,
            request: input.request,
            recurrence: input.recurrence,
            language: rt.language,
          },
          { createdBy: 'agent', createdByTaskId: rt.taskId },
        ),
      );
    } catch (err) {
      throw scheduleError(err);
    }
    const nextRunAt = row.next_run_at ? new Date(row.next_run_at).toISOString() : null;
    const output = {
      scheduleId: row.id,
      nextRunAt,
      title: row.title,
      rrule: row.rrule,
      timeZone: row.time_zone,
      status: row.status,
    };
    return {
      output,
      outputPreview: { scheduleId: row.id, title: row.title, nextRunAt, timeZone: row.time_zone },
      evidence: [
        evidence(
          'record',
          'Schedule saved',
          `schedule ${row.id}, next run ${nextRunAt ?? '—'}`,
          'SCHEDULE_RECORD',
          {
            scheduleId: row.id,
            nextRunAt: nextRunAt ?? '',
          },
        ),
      ],
      costMicro: 0,
    };
  },
  verify(_input, output) {
    const id = typeof output.scheduleId === 'string' ? output.scheduleId : '';
    const at = typeof output.nextRunAt === 'string' ? output.nextRunAt : '';
    return {
      ok: id.length > 0 && at.length > 0,
      checks: [
        check('scheduleStored', `Schedule ${id} stored`, { id }),
        check('nextRunComputed', `Next run ${at}`, { at }),
      ],
    };
  },
  // insertSchedule writes the schedule.created audit entry (metadata only).
};
