/**
 * calendar.create_event — add an event to the connected calendar and, with
 * attendees, send them invitations (Google sendUpdates=all; Graph always
 * invites). MEDIUM (HIGH above 10 attendees), approval kind calendar_event
 * showing the exact title, instants, zone, place, description and every
 * attendee; anyone but the owner adds RECIPIENT_EXTERNAL (policy-domain).
 * Attendees are literal from the user's words (plan validation).
 *
 * Right before writing, free/busy of the account is re-checked: busy →
 * CALENDAR_CONFLICT { count } and nothing written (unless allowConflict, shown
 * in the approval). Exactly once: the event is keyed by the idempotency key
 * (Google: a deterministic event id → 409 on a retried insert; Graph:
 * transactionId + a tagged extended property), and an earlier attempt's event
 * is found and returned instead of creating a second one.
 */
import { CALENDAR_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../../db/pool';
import { truncate } from '../../../../lib/redact';
import { recordBookingCalendarEvent } from '../../../commerce/bookings';
import { calendarClient, conflicts } from '../../../integrations/calendar';
import { scopeMissingError } from '../../../integrations/tokens';
import { AgentError } from '../../errors';
import { msg, render } from '../../i18n';
import { hasTemplate } from '../../templates';
import { recipientsParam } from '../email-send';
import { check, evidence, type ToolDefinition } from '../types';
import {
  ProviderField,
  TimeField,
  TimeZoneField,
  bindProvider,
  chosenProvider,
  connectionFor,
  instantOf,
  optionsFor,
  requiresFor,
  resolveTime,
} from './common';

export const CalendarCreateEventInput = z.object({
  provider: ProviderField,
  title: z.string().trim().min(1).max(200),
  start: TimeField.describe(
    'Start: an ISO date-time with offset, or a local YYYY-MM-DDTHH:MM in timeZone.',
  ),
  end: TimeField.describe('End (after start).'),
  timeZone: TimeZoneField,
  allDay: z.boolean().default(false),
  location: z.string().trim().max(300).optional(),
  description: z.string().max(5_000).optional(),
  attendees: z
    .array(z.email().max(254))
    .max(CALENDAR_LIMITS.maxAttendees)
    .default([])
    .describe('People to invite, exactly as the user wrote their addresses. Never references.'),
  allowConflict: z.boolean().default(false).describe('Create it even if the time is already busy.'),
  sourceBookingId: z
    .string()
    .max(64)
    .optional()
    .describe('The booking this event records ({{sN.bookingId}} of booking.book).'),
});
export type CalendarCreateEventInput = z.infer<typeof CalendarCreateEventInput>;

/** Attendees other than the owner are the ones invited (the owner's own address is the calendar). */
const invitees = (input: CalendarCreateEventInput) => [
  ...new Set(input.attendees.map((a) => a.toLowerCase())),
];

export function checkTimes(start: Date, end: Date, allDay: boolean): void {
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  const bad =
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    minutes <= 0 ||
    (!allDay &&
      (minutes < CALENDAR_LIMITS.minDurationMinutes ||
        minutes > CALENDAR_LIMITS.maxDurationMinutes));
  if (bad)
    throw new AgentError('TOOL_FAILED', 'The event’s times are not valid.', {
      retryable: false,
      reason: 'INVALID_TIME_RANGE',
    });
}

export const calendarCreateEventTool: ToolDefinition<CalendarCreateEventInput> = {
  id: 'calendar.create_event',
  version: '1.0.0',
  description:
    'Create an event in the connected calendar (with attendees: send them invitations). Always asks first with the exact title, time, time zone and attendees; checks the time is free right before writing. Output: eventId, webLink, start, end.',
  inputSchema: CalendarCreateEventInput,
  validatePlanned: (input) =>
    Array.isArray(input.attendees) &&
    input.attendees.some((a) => typeof a === 'string' && hasTemplate(a))
      ? ['calendar.create_event "attendees" must be literal addresses; references are not allowed.']
      : [],
  allowedRefTools: ['booking.book', 'calendar.free_busy'],
  outputFields: ['eventId', 'webLink', 'start', 'end'],
  requiredConnection: null,
  connectionOptions: optionsFor('calendar.write'),
  requires: requiresFor('calendar.write'),
  bind: (input, ctx) => ({
    ...input,
    provider: input.provider ?? bindProvider('calendar.write', ctx),
    timeZone: input.timeZone ?? ctx.timeZone,
  }),
  attendees: (input) => invitees(input),
  permissions: ['calendar:write'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 45_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  riskLevel: (input) => ((input.attendees?.length ?? 0) > 10 ? 'HIGH' : 'MEDIUM'),
  estimateCostMicro: () => 0,
  preview: (input) => ({
    ...input,
    description: input.description ? truncate(input.description, 500) : undefined,
  }),
  approvalDetails(input, ctx) {
    const provider = chosenProvider(input.provider, { has: (p) => !!ctx.accounts?.[p] });
    const tz = input.timeZone ?? ctx.account?.timeZone ?? 'UTC';
    const people = invitees(input);
    const summaryMessage = people.length
      ? msg('approval.eventInvite', { title: input.title, recipients: recipientsParam(people) })
      : msg('approval.eventCreate', { title: input.title });
    return {
      details: {
        kind: 'calendar_event',
        action: 'create',
        provider,
        account: ctx.accounts?.[provider] ?? '',
        eventId: null,
        title: input.title,
        start: instantOf(input.start, tz),
        end: instantOf(input.end, tz),
        timeZone: tz,
        allDay: input.allDay,
        location: input.location ?? null,
        description: input.description ?? null,
        attendees: people,
        notifyAttendees: people.length > 0,
        previous: null,
        conflictCheck: !input.allowConflict,
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  async execute(input, rt, signal) {
    const tz = input.timeZone ?? rt.account.timeZone;
    const start = resolveTime(input.start, tz);
    const end = resolveTime(input.end, tz);
    checkTimes(start, end, input.allDay);
    const conn = await connectionFor(rt, input.provider, 'calendar.write');
    const client = calendarClient(rt, rt.ctx, conn, tz);
    const people = invitees(input).filter(
      (a) => a !== (conn.accountIdentifier ?? '').toLowerCase(),
    );
    let created = await client.findByKey(rt.idempotencyKey, signal);
    let reconciled = !!created;
    let checked = false;
    if (!created) {
      if (!input.allowConflict) {
        if (!conn.capabilities.includes('calendar.read'))
          throw scopeMissingError(conn.provider, 'calendar.read');
        const busy = await client.freeBusy(
          { from: start, to: end, timeZone: tz, emails: [] },
          signal,
        );
        const count = conflicts(busy.slice(0, 1), start, end);
        if (count > 0)
          throw new AgentError(
            'TOOL_FAILED',
            'That time is already busy in the calendar. Nothing was written.',
            {
              retryable: true,
              reason: 'CALENDAR_CONFLICT',
              params: { count },
            },
          );
        checked = true;
      }
      const res = await client.create(
        {
          title: input.title,
          start,
          end,
          timeZone: tz,
          allDay: input.allDay,
          location: input.location ?? null,
          description: input.description ?? null,
          attendees: people,
        },
        { key: rt.idempotencyKey, notify: people.length > 0 },
        signal,
      );
      created = res.event;
      reconciled = res.reconciled;
    }
    const timesMatch = input.allDay
      ? created.allDay
      : new Date(created.start).getTime() === start.getTime() &&
        new Date(created.end).getTime() === end.getTime();
    if (input.sourceBookingId && !hasTemplate(input.sourceBookingId)) {
      await withContext(rt.db, rt.ctx, (trx) =>
        recordBookingCalendarEvent(trx, rt.ctx, input.sourceBookingId!, created.id),
      );
    }
    const output = {
      provider: conn.provider,
      eventId: created.id,
      webLink: created.webLink ?? '',
      start: created.start,
      end: created.end,
      timeZone: tz,
      title: created.title,
      attendees: people,
      notified: people.length > 0,
      reconciled,
      conflictChecked: checked,
      timesMatch,
    };
    return {
      output,
      outputPreview: {
        provider: conn.provider,
        eventId: created.id,
        start: created.start,
        end: created.end,
        title: created.title,
        attendees: people,
      },
      evidence: [
        evidence(
          'provider_response',
          `${conn.provider} event created`,
          created.id,
          'CALENDAR_EVENT',
          {
            provider: conn.provider,
            eventId: created.id,
            action: 'create',
          },
        ),
      ],
      costMicro: 0,
    };
  },
  verify: (_input, output) => ({
    ok:
      typeof output.eventId === 'string' && output.eventId.length > 0 && output.timesMatch === true,
    checks: [
      check('eventWritten', `Event ${String(output.eventId)} written`, {
        id: String(output.eventId ?? ''),
      }),
      ...(output.conflictChecked
        ? [check('noConflict', 'The time was free right before writing')]
        : []),
    ],
  }),
  resultLine: (input, output) =>
    msg('result.eventCreated', { title: String(output.title ?? input.title) }),
  resultFact: (input) => `Created the calendar event “${truncate(input.title, 120)}”.`,
  audit: (input, output) => ({
    action: 'calendar.event_created',
    metadata: {
      provider: output.provider,
      attendeeCount: input.attendees.length,
      reconciled: output.reconciled,
    },
  }),
};
