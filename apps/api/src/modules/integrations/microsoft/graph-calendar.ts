/**
 * Microsoft Graph calendar client: /me/calendarView (instants in UTC via
 * Prefer: outlook.timezone="UTC"; the event's own zone from
 * originalStartTimeZone, Windows → IANA), getSchedule for free/busy, and
 * writes. Exactly once: a created event carries transactionId and a
 * single-value extended property with the idempotency key, looked up before
 * creating. Updates send If-Match with the changeKey (412 = EVENT_CHANGED).
 * Graph always sends meeting requests to attendees of an event it creates.
 */
import type { AttendeeResponse, CalendarAttendee } from '@jarvis/contracts';
import type { DbContext } from '../../../db/pool';
import { sha256Hex } from '../../../lib/crypto';
import {
  eventChanged,
  eventNotFound,
  type CalEvent,
  type CalendarClient,
  type EventWrite,
} from '../calendar-types';
import { providerCall } from '../http';
import { localDateTime, windowsToIana, zonedToUtc } from '../timezones';
import type { ConnectionRef, IntegrationDeps } from '../types';
import { GRAPH_KEY_PROPERTY, odataString } from './graph-mail';

interface GraphDtz {
  dateTime?: string;
  timeZone?: string;
}
interface GraphEvent {
  id: string;
  changeKey?: string;
  '@odata.etag'?: string;
  subject?: string;
  body?: { content?: string };
  bodyPreview?: string;
  start?: GraphDtz;
  end?: GraphDtz;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  location?: { displayName?: string };
  organizer?: { emailAddress?: { address?: string } };
  attendees?: {
    status?: { response?: string };
    emailAddress?: { name?: string; address?: string };
  }[];
  webLink?: string;
  originalStartTimeZone?: string;
}

const RESPONSE: Record<string, AttendeeResponse> = {
  accepted: 'accepted',
  organizer: 'accepted',
  declined: 'declined',
  tentativelyAccepted: 'tentative',
  none: 'needs_action',
  notResponded: 'needs_action',
};

/** A Graph dateTime in UTC ("2026-11-05T10:00:00.0000000") → ISO instant. */
export function graphUtc(v: GraphDtz | undefined): string {
  const raw = (v?.dateTime ?? '').replace(/\.\d+$/, '');
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(raw)) return new Date(raw).toISOString();
  const tz = windowsToIana(v?.timeZone ?? 'UTC') ?? 'UTC';
  if (tz === 'UTC' || tz === 'Etc/UTC') return new Date(`${raw}Z`).toISOString();
  // A wall time in the event's zone (no Prefer header honoured): convert in that zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (!m) return new Date(`${raw}Z`).toISOString();
  return zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz).toISOString();
}

export const transactionIdFor = (key: string) =>
  `jarvis-${sha256Hex(`calendar.event:${key}`).slice(0, 32)}`;

export function fromGraphEvent(e: GraphEvent, conn: ConnectionRef): CalEvent {
  const owner = conn.accountIdentifier?.toLowerCase() ?? '';
  const organizer = e.organizer?.emailAddress?.address?.toLowerCase() ?? null;
  const attendees: CalendarAttendee[] = (e.attendees ?? [])
    .filter((a) => a.emailAddress?.address)
    .map((a) => {
      const email = a.emailAddress!.address!.toLowerCase();
      return {
        email,
        name:
          a.emailAddress?.name && a.emailAddress.name !== a.emailAddress.address
            ? a.emailAddress.name
            : null,
        response: RESPONSE[a.status?.response ?? ''] ?? null,
        organizer: email === organizer,
        self: email === owner,
      };
    });
  return {
    id: e.id,
    provider: 'microsoft',
    connectionId: conn.id,
    title: e.subject ?? '',
    start: graphUtc(e.start),
    end: graphUtc(e.end),
    timeZone: e.isAllDay ? null : windowsToIana(e.originalStartTimeZone),
    allDay: !!e.isAllDay,
    location: e.location?.displayName || null,
    description: e.body?.content ?? e.bodyPreview ?? null,
    status: e.isCancelled ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed',
    organizer,
    attendees,
    webLink: e.webLink ?? null,
    etag: e.changeKey ?? null,
  };
}

function toGraph(w: EventWrite) {
  return {
    subject: w.title,
    body: { contentType: 'text', content: w.description ?? '' },
    start: { dateTime: localDateTime(w.start, w.timeZone), timeZone: w.timeZone },
    end: { dateTime: localDateTime(w.end, w.timeZone), timeZone: w.timeZone },
    isAllDay: w.allDay,
    location: { displayName: w.location ?? '' },
    attendees: w.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
  };
}

export function graphCalendarClient(
  deps: IntegrationDeps,
  ctx: DbContext,
  conn: ConnectionRef,
): CalendarClient {
  const graph = deps.config.oauth.microsoft?.endpoints.graph;
  if (!graph) throw new Error('Microsoft is not configured on this server');
  const ref = { id: conn.id, provider: 'microsoft' as const };
  const utc = { prefer: 'outlook.timezone="UTC"' };

  async function get(eventId: string, signal?: AbortSignal): Promise<CalEvent | null> {
    const res = await providerCall(
      deps,
      ctx,
      ref,
      {
        method: 'GET',
        url: `${graph}/me/events/${encodeURIComponent(eventId)}`,
        headers: utc,
        accept: [404],
        capability: 'calendar.read',
      },
      signal,
    );
    return res.status === 200 ? fromGraphEvent(res.json as GraphEvent, conn) : null;
  }

  async function findByKey(key: string, signal?: AbortSignal): Promise<CalEvent | null> {
    const res = await providerCall(
      deps,
      ctx,
      ref,
      {
        method: 'GET',
        url: `${graph}/me/events`,
        query: {
          $filter: `singleValueExtendedProperties/Any(ep: ep/id eq ${odataString(GRAPH_KEY_PROPERTY)} and ep/value eq ${odataString(key)})`,
          $top: 1,
        },
        headers: utc,
        capability: 'calendar.read',
      },
      signal,
    );
    const e = ((res.json?.value ?? []) as GraphEvent[])[0];
    return e ? fromGraphEvent(e, conn) : null;
  }

  return {
    async list(r, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'GET',
          url: `${graph}/me/calendarView`,
          query: {
            startDateTime: r.from.toISOString(),
            endDateTime: r.to.toISOString(),
            $top: Math.min(1000, r.limit + 1),
            $orderby: 'start/dateTime',
          },
          headers: utc,
          capability: 'calendar.read',
        },
        signal,
      );
      let items = ((res.json?.value ?? []) as GraphEvent[]).filter((e) => !e.isCancelled);
      if (r.query) {
        const q = r.query.toLowerCase();
        items = items.filter((e) =>
          `${e.subject ?? ''} ${e.location?.displayName ?? ''} ${e.bodyPreview ?? ''}`
            .toLowerCase()
            .includes(q),
        );
      }
      return {
        events: items.slice(0, r.limit).map((e) => fromGraphEvent(e, conn)),
        truncated: items.length > r.limit || !!res.json?.['@odata.nextLink'],
      };
    },
    get,
    findByKey,
    async freeBusy(r, signal) {
      const self = conn.accountIdentifier ?? '';
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: `${graph}/me/calendar/getSchedule`,
          headers: utc,
          json: {
            schedules: [self, ...r.emails],
            startTime: { dateTime: r.from.toISOString().replace('Z', ''), timeZone: 'UTC' },
            endTime: { dateTime: r.to.toISOString().replace('Z', ''), timeZone: 'UTC' },
            availabilityViewInterval: 15,
          },
          capability: 'calendar.read',
        },
        signal,
      );
      const value = (res.json?.value ?? []) as {
        scheduleId?: string;
        error?: unknown;
        scheduleItems?: { status?: string; start?: GraphDtz; end?: GraphDtz }[];
      }[];
      const byId = new Map(value.map((v) => [String(v.scheduleId ?? '').toLowerCase(), v]));
      return [self, ...r.emails].map((email) => {
        const v = byId.get(email.toLowerCase());
        if (!v || v.error) return { email, accessible: false, busy: [] };
        return {
          email,
          accessible: true,
          busy: (v.scheduleItems ?? [])
            .filter((i) => i.status !== 'free')
            .map((i) => ({ start: graphUtc(i.start), end: graphUtc(i.end) })),
        };
      });
    },
    async create(w, opts, signal) {
      const existing = await findByKey(opts.key, signal);
      if (existing) return { event: existing, reconciled: true };
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: `${graph}/me/events`,
          headers: utc,
          json: {
            ...toGraph(w),
            transactionId: transactionIdFor(opts.key),
            singleValueExtendedProperties: [{ id: GRAPH_KEY_PROPERTY, value: opts.key }],
          },
          capability: 'calendar.write',
        },
        signal,
      );
      return { event: fromGraphEvent(res.json as GraphEvent, conn), reconciled: false };
    },
    async update(eventId, w, opts, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'PATCH',
          url: `${graph}/me/events/${encodeURIComponent(eventId)}`,
          headers: { ...utc, ...(opts.etag ? { 'if-match': `W/"${opts.etag}"` } : {}) },
          json: toGraph(w),
          accept: [404, 412],
          capability: 'calendar.write',
        },
        signal,
      );
      if (res.status === 412) throw eventChanged();
      if (res.status === 404) throw eventNotFound();
      return fromGraphEvent(res.json as GraphEvent, conn);
    },
    async cancel(eventId, opts, signal) {
      // The organizer cancels a meeting with attendees (they are told); otherwise delete it.
      const current = await get(eventId, signal);
      if (!current) throw eventNotFound();
      if (opts.etag && current.etag && opts.etag !== current.etag) throw eventChanged();
      const others = current.attendees.some((a) => !a.self);
      const isOrganizer =
        !current.organizer || current.organizer === conn.accountIdentifier?.toLowerCase();
      const res = await providerCall(
        deps,
        ctx,
        ref,
        others && isOrganizer
          ? {
              method: 'POST',
              url: `${graph}/me/events/${encodeURIComponent(eventId)}/cancel`,
              json: { comment: '' },
              accept: [404],
              capability: 'calendar.write',
            }
          : {
              method: 'DELETE',
              url: `${graph}/me/events/${encodeURIComponent(eventId)}`,
              headers: opts.etag ? { 'if-match': `W/"${opts.etag}"` } : {},
              accept: [404, 412],
              capability: 'calendar.write',
            },
        signal,
      );
      if (res.status === 412) throw eventChanged();
      if (res.status === 404) throw eventNotFound();
      return { alreadyCancelled: false };
    },
  };
}
