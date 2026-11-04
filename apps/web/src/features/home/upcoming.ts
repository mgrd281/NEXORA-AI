/**
 * Home "Upcoming" as data: events grouped by day in the viewer's time zone, overlaps between
 * them (conflicts), and the calendars that could not answer. Times are instants from the
 * provider (UTC); every date and time is computed in a zone with Intl, never by adding hours.
 * Pure — unit-tested in test/phase-c.test.ts.
 */
import type { CalendarEventSummary, CalendarSource, UpcomingEvents } from '@jarvis/contracts';

/** "2026-11-04" of an instant in `zone`. */
export function dayKey(iso: string | number | Date, zone: string | undefined): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Days between two "YYYY-MM-DD" keys (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface UpcomingDay {
  key: string;
  /** 0 = today, 1 = tomorrow (in the viewer's zone), else null. */
  relative: 0 | 1 | null;
  /** An instant on that day (for formatting the date). */
  anchor: string;
  events: CalendarEventSummary[];
}

/**
 * Events by day in the viewer's zone, in start order. An all-day event belongs to its own date
 * (its start is local midnight of that date in the event's zone, so it is read in that zone).
 */
export function upcomingDays(
  events: readonly CalendarEventSummary[],
  zone: string | undefined,
  now: number,
): UpcomingDay[] {
  const today = dayKey(now, zone);
  const byDay = new Map<string, CalendarEventSummary[]>();
  const sorted = [...events].sort(
    (a, b) => a.start.localeCompare(b.start) || Number(b.allDay) - Number(a.allDay),
  );
  for (const e of sorted) {
    const key = e.allDay ? dayKey(e.start, e.timeZone ?? zone) : dayKey(e.start, zone);
    const list = byDay.get(key) ?? [];
    list.push(e);
    byDay.set(key, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const diff = daysBetween(today, key);
      return {
        key,
        relative: diff === 0 ? 0 : diff === 1 ? 1 : null,
        anchor: list.find((e) => !e.allDay)?.start ?? `${key}T12:00:00Z`,
        events: list.sort(
          (a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start),
        ),
      };
    });
}

/** Events that count for conflicts: timed and not cancelled (tentative ones still block time). */
function blocksTime(e: CalendarEventSummary): boolean {
  return !e.allDay && e.status !== 'cancelled';
}

/**
 * For each event, the other events it overlaps (start before the other's end and end after its
 * start; back-to-back events do not conflict). Ids are unique per provider, so keys combine both.
 */
export function conflicts(
  events: readonly CalendarEventSummary[],
): Map<string, CalendarEventSummary[]> {
  const out = new Map<string, CalendarEventSummary[]>();
  const timed = events.filter(blocksTime);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i]!;
      const b = timed[j]!;
      if (Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)) {
        out.set(eventKey(a), [...(out.get(eventKey(a)) ?? []), b]);
        out.set(eventKey(b), [...(out.get(eventKey(b)) ?? []), a]);
      }
    }
  }
  return out;
}

export function eventKey(e: Pick<CalendarEventSummary, 'provider' | 'connectionId' | 'id'>) {
  return `${e.connectionId}:${e.id}`;
}

/** The event is happening right now. */
export function isNow(e: Pick<CalendarEventSummary, 'start' | 'end' | 'allDay'>, now: number) {
  return !e.allDay && Date.parse(e.start) <= now && now < Date.parse(e.end);
}

/** Calendars that did not answer (expired, scope missing, unavailable): shown with their fix. */
export function problemSources(upcoming: Pick<UpcomingEvents, 'sources'>): CalendarSource[] {
  return upcoming.sources.filter((s) => s.status !== 'ok');
}

/** The event's own zone differs from the viewer's (shown as a second time). */
export function otherZone(
  e: Pick<CalendarEventSummary, 'timeZone' | 'allDay' | 'start'>,
  zone: string | undefined,
): string | null {
  if (e.allDay || !e.timeZone || !zone || e.timeZone === zone) return null;
  // Zones with the same wall-clock time right now (aliases, same offset) need no second time.
  const same = (z: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: z, hour: '2-digit', minute: '2-digit' }).format(
      new Date(e.start),
    );
  try {
    return same(e.timeZone) === same(zone) ? null : e.timeZone;
  } catch {
    return null;
  }
}
