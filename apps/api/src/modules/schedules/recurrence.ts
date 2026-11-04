/**
 * Recurrence math for schedules (docs/architecture/phase-b.md §3.5). Pure
 * functions, imported by the HTTP layer and the runtime (scheduler,
 * schedule.create approval details).
 *
 * The pattern (frequency, interval, weekdays, month days, count, until) is
 * evaluated by the `rrule` package in *floating local time*: wall-clock
 * dates represented as UTC Date values, so DST plays no part in matching.
 * Each local occurrence is then turned into an instant in the schedule's IANA
 * zone with Intl (rrule's own `tzid` support returns floating dates). DST
 * semantics (the contracts' Recurrence doc):
 *   - a local time that does not exist (spring forward) runs at the first
 *     valid time after it — the instant of the transition (02:30 → 03:00);
 *   - a local time that exists twice (fall back) runs once, at the first one.
 *
 * DTSTART of a stored schedule is its first occurrence (RFC 5545: DTSTART is
 * the first instance), so COUNT counts the series from there and the stored
 * RRULE is meaningful to any RFC 5545 consumer.
 */
import * as rruleModule from 'rrule';
import type { RRule as RRuleInstance, Options as RRuleOptions } from 'rrule';
import type { Recurrence, Weekday } from '@jarvis/contracts';

/**
 * rrule ships CommonJS as "main" with no "exports" map. Under plain Node ESM
 * (the production bundle keeps it external; tsx in development) Node cannot
 * detect its named exports, so only `default` (module.exports) exists; tools
 * that read its "module" field (Vitest) see the ES build with named exports
 * and no default. Take RRule from whichever shape is present.
 */
const { RRule } =
  (rruleModule as unknown as { default?: typeof rruleModule }).default?.RRule !== undefined
    ? (rruleModule as unknown as { default: typeof rruleModule }).default
    : rruleModule;

const DAY_MS = 86_400_000;
const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const RRULE_WEEKDAY = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
} as const;
const RRULE_FREQ = { daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY } as const;
/** rrule iterates no further than year 9999. */
const FLOATING_MAX = new Date(Date.UTC(9999, 11, 31, 23, 59, 59));

/* ------------------------------------------------------------------ */
/* Zone arithmetic (Intl)                                              */
/* ------------------------------------------------------------------ */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock time of `instantMs` in `timeZone`, as a floating (UTC-fields) epoch value. */
function floatingMs(instantMs: number, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  let year = Number(parts.year);
  if (parts.era === 'BC' || parts.era === 'B') year = 1 - year;
  const hour = Number(parts.hour) % 24;
  return Date.UTC(
    year,
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
}

/** UTC offset of `timeZone` at `instantMs`, in ms (whole seconds). */
function offsetAt(instantMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  return floatingMs(wholeSecond, timeZone) - wholeSecond;
}

/** Floating wall-clock Date of an instant in `timeZone`. */
export function toFloating(instant: Date, timeZone: string): Date {
  return new Date(floatingMs(instant.getTime(), timeZone));
}

/**
 * The instant at which the wall clock of `timeZone` shows `floating`. A time
 * that exists twice resolves to the first instance; one that does not exist
 * resolves to the transition (the first valid wall-clock time after it).
 */
export function fromFloating(floating: Date, timeZone: string): Date {
  const local = floating.getTime();
  const offsets = new Set([
    offsetAt(local - DAY_MS, timeZone),
    offsetAt(local, timeZone),
    offsetAt(local + DAY_MS, timeZone),
  ]);
  const valid = [...offsets]
    .map((o) => local - o)
    .filter((candidate) => offsetAt(candidate, timeZone) === local - candidate)
    .sort((a, b) => a - b);
  if (valid.length > 0) return new Date(valid[0]!);

  // In a gap: binary-search the transition between the two candidate instants.
  const candidates = [...offsets].map((o) => local - o);
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  const before = offsetAt(lo, timeZone);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (mid <= lo) break;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/* ------------------------------------------------------------------ */
/* Recurrence                                                          */
/* ------------------------------------------------------------------ */

const sortDays = (days: readonly number[]) =>
  [...new Set(days)].sort((a, b) => (a < 0 ? 100 : a) - (b < 0 ? 100 : b));

/** Canonical form: the given (canonical) zone, interval set, sorted unique lists, fixed key order. */
export function normalizeRecurrence(r: Recurrence, timeZone: string): Recurrence {
  return {
    frequency: r.frequency,
    interval: r.interval ?? 1,
    ...(r.frequency === 'weekly' && r.byWeekday
      ? { byWeekday: WEEKDAYS.filter((d) => r.byWeekday!.includes(d)) }
      : {}),
    ...(r.frequency === 'monthly' && r.byMonthDay ? { byMonthDay: sortDays(r.byMonthDay) } : {}),
    time: r.time,
    timeZone,
    ...(r.until !== undefined ? { until: r.until } : {}),
    ...(r.count !== undefined ? { count: r.count } : {}),
  };
}

function timeOf(r: Recurrence): { hour: number; minute: number } {
  const [h, m] = r.time.split(':').map(Number);
  return { hour: h!, minute: m! };
}

/** Floating end of the `until` date (inclusive). */
function untilFloating(until: string): Date {
  const [y, m, d] = until.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 23, 59, 59));
}

function buildRule(r: Recurrence, dtstart: Date): RRuleInstance {
  const { hour, minute } = timeOf(r);
  const options: Partial<RRuleOptions> = {
    freq: RRULE_FREQ[r.frequency],
    interval: r.interval ?? 1,
    dtstart,
    wkst: RRule.MO,
    byhour: [hour],
    byminute: [minute],
    bysecond: [0],
  };
  if (r.frequency === 'weekly' && r.byWeekday)
    options.byweekday = r.byWeekday.map((d) => RRULE_WEEKDAY[d]);
  if (r.frequency === 'monthly' && r.byMonthDay) options.bymonthday = [...r.byMonthDay];
  if (r.count !== undefined) options.count = r.count;
  if (r.until !== undefined) options.until = untilFloating(r.until);
  return new RRule(options);
}

/** Occurrences of the series starting at the floating `dtstart`, strictly after the instant `after`. */
function occurrencesFromFloatingStart(
  r: Recurrence,
  dtstart: Date,
  after: Date,
  limit: number,
): Date[] {
  if (limit <= 0) return [];
  const rule = buildRule(r, dtstart);
  const afterMs = after.getTime();
  // Skip ahead in floating time; a margin of two days covers any UTC offset.
  const lower = new Date(Math.max(floatingMs(afterMs, r.timeZone) - 2 * DAY_MS, dtstart.getTime()));
  const out: Date[] = [];
  rule.between(lower, FLOATING_MAX, true, (local) => {
    const instant = fromFloating(local, r.timeZone);
    const last = out[out.length - 1];
    if (instant.getTime() > afterMs && (!last || instant.getTime() > last.getTime()))
      out.push(instant);
    return out.length < limit;
  });
  return out;
}

/**
 * Instants of the series that starts at `anchor` (its wall-clock time in the
 * recurrence's zone), strictly after `after`, at most `limit`. `until` is the
 * last local date (inclusive); `count` counts the series from `anchor`.
 */
export function occurrencesAfter(
  r: Recurrence,
  opts: { anchor: Date; after: Date; limit: number },
): Date[] {
  const start = new Date(Math.floor(floatingMs(opts.anchor.getTime(), r.timeZone) / 1000) * 1000);
  return occurrencesFromFloatingStart(r, start, opts.after, opts.limit);
}

/** The local date of `instant` in `timeZone` as YYYYMMDD. */
function localDateCompact(instant: Date, timeZone: string): string {
  return toFloating(instant, timeZone).toISOString().slice(0, 10).replaceAll('-', '');
}

function utcCompact(instant: Date): string {
  return `${instant.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
}

/**
 * The RFC 5545 text stored with a schedule. DTSTART is the local date of
 * `dtstart` (the first occurrence) at the recurrence's time — a run that a
 * DST gap moves keeps its nominal time; UNTIL is the end of the last local
 * date, in UTC (RFC 5545 requires UTC when DTSTART has a TZID).
 */
export function toRRuleString(r: Recurrence, dtstart: Date): string {
  const { hour, minute } = timeOf(r);
  const hhmm = `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}00`;
  const parts = [`FREQ=${r.frequency.toUpperCase()}`, `INTERVAL=${r.interval ?? 1}`];
  if (r.frequency === 'weekly' && r.byWeekday) parts.push(`BYDAY=${r.byWeekday.join(',')}`);
  if (r.frequency === 'monthly' && r.byMonthDay) parts.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`);
  parts.push(`BYHOUR=${hour}`, `BYMINUTE=${minute}`, 'BYSECOND=0');
  if (r.until !== undefined)
    parts.push(`UNTIL=${utcCompact(fromFloating(untilFloating(r.until), r.timeZone))}`);
  if (r.count !== undefined) parts.push(`COUNT=${r.count}`);
  return `DTSTART;TZID=${r.timeZone}:${localDateCompact(dtstart, r.timeZone)}T${hhmm}\nRRULE:${parts.join(';')}`;
}

/** The floating DTSTART of a stored RRULE text (null when absent or malformed). */
export function parseDtstart(rrule: string): Date | null {
  const m = /^DTSTART;TZID=[^:\n]+:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/m.exec(rrule);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  const date = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Occurrences of a stored schedule strictly after `after`: the series starts
 * at the DTSTART in its RRULE text (falling back to `createdAt` for a row
 * whose text cannot be read), so count and interval stay anchored.
 */
export function scheduleOccurrencesAfter(
  schedule: { recurrence: Recurrence; rrule: string; createdAt: Date },
  after: Date,
  limit: number,
): Date[] {
  const start = parseDtstart(schedule.rrule);
  if (start) return occurrencesFromFloatingStart(schedule.recurrence, start, after, limit);
  return occurrencesAfter(schedule.recurrence, { anchor: schedule.createdAt, after, limit });
}
