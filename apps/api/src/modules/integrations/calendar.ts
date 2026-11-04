/**
 * Provider-neutral calendar facade: the client per provider, proposals of
 * free meeting times computed only from the providers' free/busy answers
 * (an inaccessible calendar is never assumed free), and conflict checks.
 * Times are computed in the zone (timezones.ts), never by adding hours to UTC.
 */
import {
  CALENDAR_LIMITS,
  type CalendarEvent,
  type CalendarEventSummary,
  type FreeBusyResult,
} from '@jarvis/contracts';
import type { DbContext } from '../../db/pool';
import { googleCalendarClient } from './google/calendar';
import { graphCalendarClient } from './microsoft/graph-calendar';
import type { BusyCalendar, CalEvent, CalendarClient } from './calendar-types';
import { addDays, hhmm, localDate, localParts, zonedToUtc } from './timezones';
import type { ConnectionRef, IntegrationDeps } from './types';

export * from './calendar-types';

export function calendarClient(
  deps: IntegrationDeps,
  ctx: DbContext,
  conn: ConnectionRef,
  accountTimeZone: string,
): CalendarClient {
  return conn.provider === 'google'
    ? googleCalendarClient(deps, ctx, conn, accountTimeZone)
    : graphCalendarClient(deps, ctx, conn);
}

/** contracts CalendarEvent (drops the write-only fields). */
export function toCalendarEvent(e: CalEvent): CalendarEvent {
  return {
    id: e.id,
    provider: e.provider,
    connectionId: e.connectionId,
    title: e.title,
    start: e.start,
    end: e.end,
    timeZone: e.timeZone,
    allDay: e.allDay,
    location: e.location,
    status: e.status,
    organizer: e.organizer,
    attendees: e.attendees,
    webLink: e.webLink,
  };
}

export function toEventSummary(e: CalEvent): CalendarEventSummary {
  return {
    id: e.id,
    provider: e.provider,
    connectionId: e.connectionId,
    title: e.title,
    start: e.start,
    end: e.end,
    timeZone: e.timeZone,
    allDay: e.allDay,
    location: e.location,
    status: e.status,
    webLink: e.webLink,
    attendeeCount: e.attendees.length,
  };
}

interface Interval {
  start: number;
  end: number;
}

/** Busy intervals of every accessible calendar, merged and sorted. */
export function mergeBusy(calendars: readonly BusyCalendar[]): Interval[] {
  const all = calendars
    .filter((c) => c.accessible)
    .flatMap((c) => c.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of all) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/**
 * Free times of `durationMinutes` in [from, to), on working days (Mon–Fri)
 * within the working hours of `timeZone`, starting on multiples of
 * `stepMinutes`, not before `now`, free in every accessible calendar.
 * Proposals do not overlap one another.
 */
export function proposeSlots(p: {
  from: Date;
  to: Date;
  durationMinutes: number;
  timeZone: string;
  busy: readonly Interval[];
  now: Date;
  workdayStart?: string;
  workdayEnd?: string;
  max?: number;
  stepMinutes?: number;
}): { start: string; end: string }[] {
  const max = p.max ?? CALENDAR_LIMITS.maxProposedSlots;
  const step = (p.stepMinutes ?? CALENDAR_LIMITS.slotStepMinutes) * 60_000;
  const dur = p.durationMinutes * 60_000;
  const startMin = hhmm(p.workdayStart ?? CALENDAR_LIMITS.defaultWorkdayStart);
  const endMin = hhmm(p.workdayEnd ?? CALENDAR_LIMITS.defaultWorkdayEnd);
  const out: { start: string; end: string }[] = [];
  const lower = Math.max(p.from.getTime(), p.now.getTime());
  let day = localDate(p.from, p.timeZone);
  const lastDay = localDate(new Date(p.to.getTime() - 1), p.timeZone);
  for (
    let guard = 0;
    guard < 400 && day <= lastDay && out.length < max;
    guard++, day = addDays(day, 1)
  ) {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const weekday = localParts(zonedToUtc(y, m, d, 12, 0, p.timeZone), p.timeZone).weekday;
    if (weekday === 0 || weekday === 6) continue;
    const dayStart = zonedToUtc(
      y,
      m,
      d,
      Math.floor(startMin / 60),
      startMin % 60,
      p.timeZone,
    ).getTime();
    const dayEnd = zonedToUtc(y, m, d, Math.floor(endMin / 60), endMin % 60, p.timeZone).getTime();
    let cursor = Math.max(dayStart, lower);
    // Align to the step from the start of the working day (local wall time).
    if (cursor > dayStart) cursor = dayStart + Math.ceil((cursor - dayStart) / step) * step;
    const limit = Math.min(dayEnd, p.to.getTime());
    while (cursor + dur <= limit && out.length < max) {
      const clash = p.busy.find((b) => b.start < cursor + dur && cursor < b.end);
      if (!clash) {
        out.push({
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + dur).toISOString(),
        });
        cursor += dur;
        cursor = dayStart + Math.ceil((cursor - dayStart) / step) * step;
      } else {
        cursor = dayStart + Math.ceil((clash.end - dayStart) / step) * step;
      }
    }
  }
  return out;
}

/** FreeBusyResult from the providers' answers. */
export function freeBusyResult(p: {
  from: Date;
  to: Date;
  timeZone: string;
  durationMinutes: number;
  calendars: readonly BusyCalendar[];
  now: Date;
  workdayStart?: string;
  workdayEnd?: string;
}): FreeBusyResult {
  return {
    timeMin: p.from.toISOString(),
    timeMax: p.to.toISOString(),
    timeZone: p.timeZone,
    durationMinutes: p.durationMinutes,
    calendars: p.calendars.map((c) => ({ email: c.email, accessible: c.accessible, busy: c.busy })),
    slots: proposeSlots({
      from: p.from,
      to: p.to,
      durationMinutes: p.durationMinutes,
      timeZone: p.timeZone,
      busy: mergeBusy(p.calendars),
      now: p.now,
      workdayStart: p.workdayStart,
      workdayEnd: p.workdayEnd,
    }),
  };
}

/** Busy intervals of accessible calendars overlapping [start, end), excluding one event's own time. */
export function conflicts(
  calendars: readonly BusyCalendar[],
  start: Date,
  end: Date,
  ignore?: { start: string; end: string } | null,
): number {
  let n = 0;
  for (const c of calendars) {
    if (!c.accessible) continue;
    for (const b of c.busy) {
      if (
        ignore &&
        b.start === new Date(ignore.start).toISOString() &&
        b.end === new Date(ignore.end).toISOString()
      )
        continue;
      if (Date.parse(b.start) < end.getTime() && start.getTime() < Date.parse(b.end)) n++;
    }
  }
  return n;
}
