/**
 * calendar.free_busy — when the account and the named people are free
 * (Google freeBusy.query / Graph getSchedule), and up to
 * CALENDAR_LIMITS.maxProposedSlots meeting times free for everyone within
 * working hours of the zone. Proposals come only from the providers'
 * answers: a calendar the provider does not share is reported and never
 * assumed free. LOW, read-only. Addresses are literal from the user's words
 * (literalTexts: plan validation), never from mail, pages or results.
 */
import { CALENDAR_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { calendarClient, freeBusyResult } from '../../../integrations/calendar';
import { AgentError } from '../../errors';
import { hasTemplate } from '../../templates';
import { check, evidence, genericApprovalSummary, type ToolDefinition } from '../types';
import {
  ProviderField,
  TimeField,
  TimeZoneField,
  bindProvider,
  connectionFor,
  formatWhen,
  optionsFor,
  requiresFor,
  resolveTime,
  words,
} from './common';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CalendarFreeBusyInput = z.object({
  provider: ProviderField,
  attendees: z
    .array(z.email().max(254))
    .max(CALENDAR_LIMITS.maxAttendees)
    .default([])
    .describe('People to meet, exactly as the user wrote their addresses. Never references.'),
  from: TimeField.describe('Start of the window to search.'),
  to: TimeField.describe('End of the window to search.'),
  durationMinutes: z
    .number()
    .int()
    .min(CALENDAR_LIMITS.minDurationMinutes)
    .max(CALENDAR_LIMITS.maxDurationMinutes)
    .default(30),
  timeZone: TimeZoneField,
  workdayStart: z.string().regex(HHMM).optional(),
  workdayEnd: z.string().regex(HHMM).optional(),
});
export type CalendarFreeBusyInput = z.infer<typeof CalendarFreeBusyInput>;

export const calendarFreeBusyTool: ToolDefinition<CalendarFreeBusyInput> = {
  id: 'calendar.free_busy',
  version: '1.0.0',
  description:
    'Find times when the user and the named people are all free (from their calendars’ free/busy), within working hours. Read-only. Output: text (proposed times), slotCount, firstSlotStart, firstSlotEnd, result.',
  inputSchema: CalendarFreeBusyInput,
  validatePlanned: (input) =>
    Array.isArray(input.attendees) &&
    input.attendees.some((a) => typeof a === 'string' && hasTemplate(a))
      ? [
          'calendar.free_busy "attendees" must be literal addresses the user wrote; references are not allowed.',
        ]
      : [],
  literalTexts: (input) => [input.attendees.join(' ')],
  outputFields: ['text', 'result', 'slotCount', 'firstSlotStart', 'firstSlotEnd', 'timeZone'],
  requiredConnection: null,
  connectionOptions: optionsFor('calendar.read'),
  requires: requiresFor('calendar.read'),
  bind: (input, ctx) => ({
    ...input,
    provider: input.provider ?? bindProvider('calendar.read', ctx),
    timeZone: input.timeZone ?? ctx.timeZone,
  }),
  resultTextField: 'text',
  permissions: ['calendar:read'],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 30_000,
  retry: { maxAttempts: 3, retryableCodes: ['TOOL_FAILED', 'TOOL_TIMEOUT'] },
  modelUse: 'none',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ ...input }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'calendar.free_busy',
      fields: [{ label: 'With', value: input.attendees.join(', ') }],
    },
    ...genericApprovalSummary(ctx, 'calendar.free_busy'),
  }),
  async execute(input, rt, signal) {
    const tz = input.timeZone ?? rt.account.timeZone;
    const from = resolveTime(input.from, tz);
    const to = resolveTime(input.to, tz);
    if (
      !(to > from) ||
      to.getTime() - from.getTime() > CALENDAR_LIMITS.freeBusyMaxDays * 86_400_000
    )
      throw new AgentError(
        'TOOL_FAILED',
        `The window must be in the future and at most ${CALENDAR_LIMITS.freeBusyMaxDays} days long.`,
        { retryable: false, reason: 'INVALID_TIME_RANGE' },
      );
    const conn = await connectionFor(rt, input.provider, 'calendar.read');
    const owner = (conn.accountIdentifier ?? rt.account.email).toLowerCase();
    const others = [...new Set(input.attendees.map((a) => a.toLowerCase()))].filter(
      (a) => a !== owner,
    );
    const calendars = await calendarClient(rt, rt.ctx, conn, tz).freeBusy(
      { from, to, timeZone: tz, emails: others },
      signal,
    );
    const result = freeBusyResult({
      from,
      to,
      timeZone: tz,
      durationMinutes: input.durationMinutes,
      calendars,
      now: new Date(),
      workdayStart: input.workdayStart,
      workdayEnd: input.workdayEnd,
    });
    if (!calendars[0]?.accessible)
      throw new AgentError('TOOL_FAILED', 'Your own calendar’s free/busy could not be read.', {
        retryable: true,
        transient: true,
        reason: 'PROVIDER_UNAVAILABLE',
        params: { provider: conn.provider },
      });
    if (result.slots.length === 0)
      throw new AgentError('TOOL_FAILED', 'No time in this window is free for everyone.', {
        retryable: true,
        reason: 'NO_FREE_SLOTS',
      });
    const lang = rt.language;
    const hidden = result.calendars.filter((c) => !c.accessible).map((c) => c.email);
    const text = [
      words(lang, 'freeTimes', { minutes: input.durationMinutes, tz }),
      ...result.slots.map((s, i) => `${i + 1}. ${formatWhen(s.start, s.end, tz, lang)}`),
      ...(hidden.length ? [words(lang, 'notShared', { who: hidden.join(', ') })] : []),
    ].join('\n');
    return {
      output: {
        provider: conn.provider,
        result,
        text,
        slotCount: result.slots.length,
        firstSlotStart: result.slots[0]!.start,
        firstSlotEnd: result.slots[0]!.end,
        timeZone: tz,
        attendees: others,
      },
      outputPreview: { provider: conn.provider, result, slotCount: result.slots.length, text },
      evidence: [
        evidence(
          'provider_response',
          `${conn.provider} free/busy`,
          `${result.calendars.length} calendar(s), ${result.slots.length} free time(s)`,
          'FREE_BUSY',
          {
            provider: conn.provider,
            calendars: result.calendars.length,
            slots: result.slots.length,
          },
        ),
      ],
      costMicro: 0,
    };
  },
  verify: (_input, output) => {
    const n = Number(output.slotCount ?? 0);
    return { ok: n > 0, checks: [check('slotsFound', `${n} free time(s) found`, { count: n })] };
  },
  resultFact: (_input, output) => `Found ${Number(output.slotCount ?? 0)} free meeting time(s).`,
};
