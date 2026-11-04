/**
 * Google Calendar API v3 client (the primary calendar): events.list/get/
 * insert/patch/delete and freeBusy.query. Exactly once: an inserted event's
 * id is derived from the idempotency key (base32hex, allowed by the API), so
 * a retried insert answers 409 and the existing event is read instead.
 * Updates and cancellations carry the etag read earlier (If-Match → 412 =
 * EVENT_CHANGED). sendUpdates=all only when attendees are to be told.
 */
import type { AttendeeResponse, CalendarAttendee } from '@jarvis/contracts';
import type { DbContext } from '../../../db/pool';
import { sha256 } from '../../../lib/crypto';
import {
  eventChanged,
  eventNotFound,
  type CalEvent,
  type CalendarClient,
  type EventWrite,
} from '../calendar-types';
import { providerCall } from '../http';
import { localDate, midnight } from '../timezones';
import type { ConnectionRef, IntegrationDeps } from '../types';

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/** A Google event id from an idempotency key: 32 base32hex characters (deterministic). */
export function googleEventId(key: string): string {
  const bytes = sha256(`calendar.event:${key}`).subarray(0, 20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

interface GoogleTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}
interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  organizer?: { email?: string; self?: boolean };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
  }[];
}

const RESPONSE: Record<string, AttendeeResponse> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  needsAction: 'needs_action',
};

export function fromGoogleEvent(
  e: GoogleEvent,
  conn: ConnectionRef,
  calendarTimeZone: string,
): CalEvent {
  const allDay = !!e.start?.date;
  const zone = e.start?.timeZone ?? calendarTimeZone;
  const start = allDay
    ? midnight(e.start!.date!, zone).toISOString()
    : new Date(e.start?.dateTime ?? 0).toISOString();
  const end = allDay
    ? midnight(e.end?.date ?? e.start!.date!, zone).toISOString()
    : new Date(e.end?.dateTime ?? e.start?.dateTime ?? 0).toISOString();
  const attendees: CalendarAttendee[] = (e.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => ({
      email: a.email!.toLowerCase(),
      name: a.displayName ?? null,
      response: RESPONSE[a.responseStatus ?? ''] ?? null,
      organizer: !!a.organizer,
      self:
        !!a.self ||
        (!!conn.accountIdentifier &&
          a.email!.toLowerCase() === conn.accountIdentifier.toLowerCase()),
    }));
  return {
    id: e.id,
    provider: 'google',
    connectionId: conn.id,
    title: e.summary ?? '',
    start,
    end,
    timeZone: allDay ? null : zone,
    allDay,
    location: e.location ?? null,
    description: e.description ?? null,
    status:
      e.status === 'tentative' ? 'tentative' : e.status === 'cancelled' ? 'cancelled' : 'confirmed',
    organizer: e.organizer?.email?.toLowerCase() ?? null,
    attendees,
    webLink: e.htmlLink ?? null,
    etag: e.etag ?? null,
  };
}

function toGoogleTimes(w: EventWrite): { start: GoogleTime; end: GoogleTime } {
  if (w.allDay)
    return {
      start: { date: localDate(w.start, w.timeZone) },
      end: { date: localDate(w.end, w.timeZone) },
    };
  return {
    start: { dateTime: w.start.toISOString(), timeZone: w.timeZone },
    end: { dateTime: w.end.toISOString(), timeZone: w.timeZone },
  };
}

export function googleCalendarClient(
  deps: IntegrationDeps,
  ctx: DbContext,
  conn: ConnectionRef,
  accountTimeZone: string,
): CalendarClient {
  const base = deps.config.oauth.google?.endpoints.calendar;
  if (!base) throw new Error('Google is not configured on this server');
  const ref = { id: conn.id, provider: 'google' as const };
  const events = `${base}/calendars/primary/events`;
  let calendarZone = accountTimeZone;

  async function get(eventId: string, signal?: AbortSignal): Promise<CalEvent | null> {
    const res = await providerCall(
      deps,
      ctx,
      ref,
      {
        method: 'GET',
        url: `${events}/${encodeURIComponent(eventId)}`,
        accept: [404, 410],
        capability: 'calendar.read',
      },
      signal,
    );
    if (res.status !== 200) return null;
    return fromGoogleEvent(res.json as GoogleEvent, conn, calendarZone);
  }

  return {
    async list(r, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'GET',
          url: events,
          query: {
            timeMin: r.from.toISOString(),
            timeMax: r.to.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: Math.min(2500, r.limit + 1),
            ...(r.query ? { q: r.query } : {}),
          },
          capability: 'calendar.read',
        },
        signal,
      );
      if (typeof res.json?.timeZone === 'string') calendarZone = res.json.timeZone;
      const items = ((res.json?.items ?? []) as GoogleEvent[]).filter(
        (e) => e.status !== 'cancelled',
      );
      return {
        events: items.slice(0, r.limit).map((e) => fromGoogleEvent(e, conn, calendarZone)),
        truncated: items.length > r.limit || !!res.json?.nextPageToken,
      };
    },
    get,
    findByKey: (key, signal) => get(googleEventId(key), signal),
    async freeBusy(r, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: `${base}/freeBusy`,
          json: {
            timeMin: r.from.toISOString(),
            timeMax: r.to.toISOString(),
            timeZone: r.timeZone,
            items: [{ id: 'primary' }, ...r.emails.map((id) => ({ id }))],
          },
          capability: 'calendar.read',
        },
        signal,
      );
      const calendars = (res.json?.calendars ?? {}) as Record<
        string,
        { busy?: { start: string; end: string }[]; errors?: unknown[] }
      >;
      const one = (id: string, email: string) => {
        const c = calendars[id] ?? calendars[id.toLowerCase()];
        if (!c || (Array.isArray(c.errors) && c.errors.length > 0))
          return { email, accessible: false, busy: [] };
        return {
          email,
          accessible: true,
          busy: (c.busy ?? []).map((b) => ({
            start: new Date(b.start).toISOString(),
            end: new Date(b.end).toISOString(),
          })),
        };
      };
      return [
        one('primary', conn.accountIdentifier ?? 'primary'),
        ...r.emails.map((e) => one(e, e)),
      ];
    },
    async create(w, opts, signal) {
      const id = googleEventId(opts.key);
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: events,
          query: { sendUpdates: opts.notify && w.attendees.length ? 'all' : 'none' },
          json: {
            id,
            summary: w.title,
            ...(w.description ? { description: w.description } : {}),
            ...(w.location ? { location: w.location } : {}),
            ...toGoogleTimes(w),
            ...(w.attendees.length ? { attendees: w.attendees.map((email) => ({ email })) } : {}),
          },
          accept: [409],
          capability: 'calendar.write',
        },
        signal,
      );
      if (res.status === 409) {
        // This step already created it (an interrupted attempt): read it, never create a second.
        const existing = await get(id, signal);
        if (!existing) throw eventNotFound();
        return { event: existing, reconciled: true };
      }
      return {
        event: fromGoogleEvent(res.json as GoogleEvent, conn, w.timeZone),
        reconciled: false,
      };
    },
    async update(eventId, w, opts, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'PATCH',
          url: `${events}/${encodeURIComponent(eventId)}`,
          query: { sendUpdates: opts.notify ? 'all' : 'none' },
          headers: opts.etag ? { 'if-match': opts.etag } : {},
          json: {
            summary: w.title,
            description: w.description ?? '',
            location: w.location ?? '',
            ...toGoogleTimes(w),
            attendees: w.attendees.map((email) => ({ email })),
          },
          accept: [404, 410, 412],
          capability: 'calendar.write',
        },
        signal,
      );
      if (res.status === 412) throw eventChanged();
      if (res.status !== 200) throw eventNotFound();
      return fromGoogleEvent(res.json as GoogleEvent, conn, w.timeZone);
    },
    async cancel(eventId, opts, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'DELETE',
          url: `${events}/${encodeURIComponent(eventId)}`,
          query: { sendUpdates: opts.notify ? 'all' : 'none' },
          headers: opts.etag ? { 'if-match': opts.etag } : {},
          accept: [404, 410, 412],
          capability: 'calendar.write',
        },
        signal,
      );
      if (res.status === 412) throw eventChanged();
      if (res.status === 404) throw eventNotFound();
      return { alreadyCancelled: res.status === 410 };
    },
  };
}
