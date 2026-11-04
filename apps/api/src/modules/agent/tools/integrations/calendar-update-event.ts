/**
 * calendar.update_event / calendar.cancel_event — change or cancel an event
 * JARVIS read in an earlier calendar.list step (its id and etag / changeKey
 * are referenced). MEDIUM, approval kind calendar_event with the new values,
 * the event as it was read (`previous`) and exactly who is told.
 *
 * Nothing is written when the event changed since it was read (If-Match →
 * EVENT_CHANGED), and never when people would be told who were not in the
 * approval: the event's attendees must all be among the approved ones
 * (otherwise EVENT_CHANGED). Updates keep every existing attendee (the
 * approved list replaces it only if it contains them all). Graph tells
 * attendees of an organizer's change in any case; the approval says so.
 */
import { CALENDAR_LIMITS, type OAuthProvider } from '@jarvis/contracts';
import { z } from 'zod';
import { truncate } from '../../../../lib/redact';
import {
  calendarClient,
  conflicts,
  eventChanged,
  eventNotFound,
  type CalEvent,
} from '../../../integrations/calendar';
import { scopeMissingError } from '../../../integrations/tokens';
import { AgentError } from '../../errors';
import { msg, render } from '../../i18n';
import { hasTemplate } from '../../templates';
import { check, evidence, type ApprovalContext, type ToolDefinition } from '../types';
import { checkTimes } from './calendar-create-event';
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

const Previous = z
  .object({ title: z.string().max(300), start: TimeField, end: TimeField })
  .optional()
  .describe(
    'The event as calendar.list read it (refs to firstEventTitle / firstEventStart / firstEventEnd).',
  );

const literalAttendees = z
  .array(z.email().max(254))
  .max(CALENDAR_LIMITS.maxAttendees)
  .default([])
  .describe(
    'Everyone who is (still) invited, exactly as the user wrote their addresses. Never references.',
  );

export const CalendarUpdateEventInput = z.object({
  provider: ProviderField,
  eventId: z.string().min(1).max(1024).describe('e.g. {{s1.firstEventId}}.'),
  etag: z
    .string()
    .max(256)
    .optional()
    .describe('e.g. {{s1.firstEventEtag}}: nothing is written if it changed.'),
  title: z.string().trim().min(1).max(200),
  start: TimeField,
  end: TimeField,
  timeZone: TimeZoneField,
  allDay: z.boolean().default(false),
  location: z.string().trim().max(300).optional(),
  description: z.string().max(5_000).optional(),
  attendees: literalAttendees,
  notifyAttendees: z.boolean().default(false),
  allowConflict: z.boolean().default(false),
  previous: Previous,
});
export type CalendarUpdateEventInput = z.infer<typeof CalendarUpdateEventInput>;

export const CalendarCancelEventInput = z.object({
  provider: ProviderField,
  eventId: z.string().min(1).max(1024),
  etag: z.string().max(256).optional(),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('The event’s title as read (shown in the approval).'),
  start: TimeField,
  end: TimeField,
  timeZone: TimeZoneField,
  attendees: literalAttendees,
  notifyAttendees: z.boolean().default(false),
});
export type CalendarCancelEventInput = z.infer<typeof CalendarCancelEventInput>;

const noRefs = (attendees: unknown, tool: string) =>
  Array.isArray(attendees) && attendees.some((a) => typeof a === 'string' && hasTemplate(a))
    ? [`${tool} "attendees" must be literal addresses; references are not allowed.`]
    : [];

/** Graph tells attendees of an organizer's change whatever JARVIS asks; Google only with sendUpdates. */
const notifies = (provider: OAuthProvider, attendees: readonly string[], notify: boolean) =>
  provider === 'microsoft' ? attendees.length > 0 || notify : notify && attendees.length > 0;

/** The event must be unchanged and everyone it would tell must be in the approval. */
function guard(
  current: CalEvent | null,
  etag: string | undefined,
  approved: readonly string[],
  owner: string,
): CalEvent {
  if (!current || current.status === 'cancelled') throw eventNotFound();
  if (etag && !hasTemplate(etag) && current.etag && current.etag !== etag) throw eventChanged();
  const ok = new Set([...approved.map((a) => a.toLowerCase()), owner.toLowerCase()]);
  if (current.attendees.some((a) => !a.self && !ok.has(a.email.toLowerCase())))
    throw eventChanged();
  return current;
}

function approvalOf(
  action: 'update' | 'cancel',
  input: CalendarUpdateEventInput | CalendarCancelEventInput,
  ctx: ApprovalContext,
) {
  const provider = chosenProvider(input.provider, { has: (p) => !!ctx.accounts?.[p] });
  const tz = input.timeZone ?? ctx.account?.timeZone ?? 'UTC';
  const attendees = [...new Set(input.attendees.map((a) => a.toLowerCase()))];
  const previous =
    'previous' in input && input.previous
      ? {
          title: input.previous.title,
          start: instantOf(input.previous.start, tz),
          end: instantOf(input.previous.end, tz),
        }
      : action === 'cancel'
        ? { title: input.title, start: instantOf(input.start, tz), end: instantOf(input.end, tz) }
        : null;
  const summaryMessage =
    action === 'update'
      ? msg('approval.eventUpdate', { title: input.title })
      : msg('approval.eventCancel', { title: input.title });
  return {
    details: {
      kind: 'calendar_event' as const,
      action,
      provider,
      account: ctx.accounts?.[provider] ?? '',
      eventId: input.eventId,
      title: input.title,
      start: instantOf(input.start, tz),
      end: instantOf(input.end, tz),
      timeZone: tz,
      allDay: 'allDay' in input ? input.allDay : false,
      location: 'location' in input ? (input.location ?? null) : null,
      description: 'description' in input ? (input.description ?? null) : null,
      attendees,
      notifyAttendees: notifies(provider, attendees, input.notifyAttendees),
      previous,
      conflictCheck: action === 'update' && !('allowConflict' in input && input.allowConflict),
    },
    summary: render(ctx.language, summaryMessage),
    summaryMessage,
  };
}

const shared = {
  requiredConnection: null,
  connectionOptions: optionsFor('calendar.write'),
  requires: requiresFor('calendar.write'),
  permissions: ['calendar:write'],
  sideEffect: 'external' as const,
  idempotency: 'once_per_step' as const,
  timeoutMs: 45_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none' as const,
  riskLevel: () => 'MEDIUM' as const,
  estimateCostMicro: () => 0,
  allowedRefTools: ['calendar.list'] as const,
};

export const calendarUpdateEventTool: ToolDefinition<CalendarUpdateEventInput> = {
  ...shared,
  id: 'calendar.update_event',
  version: '1.0.0',
  description:
    'Change an event read by calendar.list (refer to its firstEventId and firstEventEtag). Asks first with the new values and the old ones; never writes if the event changed meanwhile. Output: eventId.',
  inputSchema: CalendarUpdateEventInput,
  validatePlanned: (input) => noRefs(input.attendees, 'calendar.update_event'),
  outputFields: ['eventId', 'start', 'end'],
  bind: (input, ctx) => ({
    ...input,
    provider: input.provider ?? bindProvider('calendar.write', ctx),
    timeZone: input.timeZone ?? ctx.timeZone,
  }),
  attendees: (input) => input.attendees.map((a) => a.toLowerCase()),
  preview: (input) => ({
    ...input,
    description: input.description ? truncate(input.description, 500) : undefined,
  }),
  approvalDetails: (input, ctx) => approvalOf('update', input, ctx),
  async execute(input, rt, signal) {
    const tz = input.timeZone ?? rt.account.timeZone;
    const start = resolveTime(input.start, tz);
    const end = resolveTime(input.end, tz);
    checkTimes(start, end, input.allDay);
    const conn = await connectionFor(rt, input.provider, 'calendar.write');
    const owner = conn.accountIdentifier ?? rt.account.email;
    const client = calendarClient(rt, rt.ctx, conn, tz);
    const current = guard(
      await client.get(input.eventId, signal),
      input.etag,
      input.attendees,
      owner,
    );
    if (!input.allowConflict) {
      if (!conn.capabilities.includes('calendar.read'))
        throw scopeMissingError(conn.provider, 'calendar.read');
      const busy = await client.freeBusy(
        { from: start, to: end, timeZone: tz, emails: [] },
        signal,
      );
      const count = conflicts(busy.slice(0, 1), start, end, {
        start: current.start,
        end: current.end,
      });
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
    }
    const keep = current.attendees.filter((a) => !a.self).map((a) => a.email);
    const attendees = [
      ...new Set([...keep, ...input.attendees.map((a) => a.toLowerCase())]),
    ].filter((a) => a !== owner.toLowerCase());
    const updated = await client.update(
      input.eventId,
      {
        title: input.title,
        start,
        end,
        timeZone: tz,
        allDay: input.allDay,
        location: input.location ?? null,
        description: input.description ?? null,
        attendees,
      },
      {
        etag: input.etag && !hasTemplate(input.etag) ? input.etag : current.etag,
        notify: input.notifyAttendees,
      },
      signal,
    );
    const output = {
      provider: conn.provider,
      eventId: updated.id,
      start: updated.start,
      end: updated.end,
      title: updated.title,
      timesMatch:
        new Date(updated.start).getTime() === start.getTime() &&
        new Date(updated.end).getTime() === end.getTime(),
    };
    return {
      output,
      outputPreview: output,
      evidence: [
        evidence(
          'provider_response',
          `${conn.provider} event updated`,
          updated.id,
          'CALENDAR_EVENT',
          {
            provider: conn.provider,
            eventId: updated.id,
            action: 'update',
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
      check('eventWritten', `Event ${String(output.eventId)} changed`, {
        id: String(output.eventId ?? ''),
      }),
    ],
  }),
  resultLine: (input) => msg('result.eventUpdated', { title: input.title }),
  resultFact: (input) => `Changed the calendar event “${truncate(input.title, 120)}”.`,
  audit: (input, output) => ({
    action: 'calendar.event_updated',
    metadata: { provider: output.provider, attendeeCount: input.attendees.length },
  }),
};

export const calendarCancelEventTool: ToolDefinition<CalendarCancelEventInput> = {
  ...shared,
  id: 'calendar.cancel_event',
  version: '1.0.0',
  description:
    'Cancel an event read by calendar.list (refer to its firstEventId, firstEventEtag, firstEventTitle, firstEventStart, firstEventEnd). Asks first; never cancels if the event changed meanwhile. Output: eventId.',
  inputSchema: CalendarCancelEventInput,
  validatePlanned: (input) => noRefs(input.attendees, 'calendar.cancel_event'),
  outputFields: ['eventId'],
  bind: (input, ctx) => ({
    ...input,
    provider: input.provider ?? bindProvider('calendar.write', ctx),
    timeZone: input.timeZone ?? ctx.timeZone,
  }),
  attendees: (input) => input.attendees.map((a) => a.toLowerCase()),
  preview: (input) => ({ ...input }),
  approvalDetails: (input, ctx) => approvalOf('cancel', input, ctx),
  async execute(input, rt, signal) {
    const tz = input.timeZone ?? rt.account.timeZone;
    const conn = await connectionFor(rt, input.provider, 'calendar.write');
    const owner = conn.accountIdentifier ?? rt.account.email;
    const client = calendarClient(rt, rt.ctx, conn, tz);
    const current = guard(
      await client.get(input.eventId, signal),
      input.etag,
      input.attendees,
      owner,
    );
    const res = await client.cancel(
      input.eventId,
      {
        etag: input.etag && !hasTemplate(input.etag) ? input.etag : current.etag,
        notify: input.notifyAttendees,
      },
      signal,
    );
    const output = {
      provider: conn.provider,
      eventId: input.eventId,
      cancelled: true,
      alreadyCancelled: res.alreadyCancelled,
    };
    return {
      output,
      outputPreview: output,
      evidence: [
        evidence(
          'provider_response',
          `${conn.provider} event cancelled`,
          input.eventId,
          'CALENDAR_EVENT',
          {
            provider: conn.provider,
            eventId: input.eventId,
            action: 'cancel',
          },
        ),
      ],
      costMicro: 0,
    };
  },
  verify: (_input, output) => ({
    ok: output.cancelled === true,
    checks: [
      check('eventWritten', `Event ${String(output.eventId)} cancelled`, {
        id: String(output.eventId ?? ''),
      }),
    ],
  }),
  resultLine: (input) => msg('result.eventCancelled', { title: input.title }),
  resultFact: (input) => `Cancelled the calendar event “${truncate(input.title, 120)}”.`,
  audit: (input, output) => ({
    action: 'calendar.event_cancelled',
    metadata: { provider: output.provider, attendeeCount: input.attendees.length },
  }),
};
