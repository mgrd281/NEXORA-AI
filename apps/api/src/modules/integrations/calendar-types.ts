/** Provider-neutral calendar model shared by the Google and Graph clients and the facade. */
import type { CalendarAttendee, OAuthProvider } from '@jarvis/contracts';
import { AgentError } from '../agent/errors';

/** contracts CalendarEvent plus what writes need (etag / changeKey, description). */
export interface CalEvent {
  id: string;
  provider: OAuthProvider;
  connectionId: string;
  title: string;
  start: string;
  end: string;
  timeZone: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizer: string | null;
  attendees: CalendarAttendee[];
  webLink: string | null;
  /** Google etag / Graph changeKey: update and cancel send it (If-Match). */
  etag: string | null;
}

export interface EventWrite {
  title: string;
  start: Date;
  end: Date;
  /** IANA zone the event is written in. */
  timeZone: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  /** Invitation recipients (never the owner). */
  attendees: string[];
}

export interface BusyCalendar {
  email: string;
  /** false: the provider does not share this calendar's free/busy. */
  accessible: boolean;
  busy: { start: string; end: string }[];
}

export interface CalendarClient {
  list(
    r: { from: Date; to: Date; limit: number; query?: string },
    signal?: AbortSignal,
  ): Promise<{ events: CalEvent[]; truncated: boolean }>;
  get(eventId: string, signal?: AbortSignal): Promise<CalEvent | null>;
  /** The event an earlier attempt with this idempotency key created, if any. */
  findByKey(key: string, signal?: AbortSignal): Promise<CalEvent | null>;
  /** The account's own calendar first, then each of `emails`. */
  freeBusy(
    r: { from: Date; to: Date; timeZone: string; emails: string[] },
    signal?: AbortSignal,
  ): Promise<BusyCalendar[]>;
  create(
    w: EventWrite,
    opts: { key: string; notify: boolean },
    signal?: AbortSignal,
  ): Promise<{ event: CalEvent; reconciled: boolean }>;
  update(
    eventId: string,
    w: EventWrite,
    opts: { etag: string | null; notify: boolean },
    signal?: AbortSignal,
  ): Promise<CalEvent>;
  cancel(
    eventId: string,
    opts: { etag: string | null; notify: boolean },
    signal?: AbortSignal,
  ): Promise<{ alreadyCancelled: boolean }>;
}

export const eventNotFound = () =>
  new AgentError('TOOL_FAILED', 'That calendar event was not found.', {
    retryable: false,
    reason: 'EVENT_NOT_FOUND',
  });

export const eventChanged = () =>
  new AgentError(
    'TOOL_FAILED',
    'The event changed since JARVIS read it, so nothing was written. Check it and ask again.',
    { retryable: false, reason: 'EVENT_CHANGED' },
  );
