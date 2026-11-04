import { describe, expect, it } from 'vitest';
import { Recurrence } from '@jarvis/contracts';
import {
  fromFloating,
  normalizeRecurrence,
  occurrencesAfter,
  parseDtstart,
  scheduleOccurrencesAfter,
  toFloating,
  toRRuleString,
} from '../../../src/modules/schedules/recurrence';

const rec = (r: Partial<Recurrence> & Pick<Recurrence, 'frequency' | 'time' | 'timeZone'>) =>
  normalizeRecurrence(Recurrence.parse(r), r.timeZone);
const at = (s: string) => new Date(s);
const iso = (ds: Date[]) => ds.map((d) => d.toISOString());
const next = (r: Recurrence, from: string, limit = 5) =>
  iso(occurrencesAfter(r, { anchor: at(from), after: at(from), limit }));

describe('zone arithmetic', () => {
  it('maps a non-existent local time to the transition and an ambiguous one to its first instance', () => {
    // Europe/Berlin: 2026-03-29 02:00 → 03:00; 2026-10-25 03:00 → 02:00.
    expect(
      fromFloating(new Date(Date.UTC(2026, 2, 29, 2, 30)), 'Europe/Berlin').toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
    expect(
      fromFloating(new Date(Date.UTC(2026, 9, 25, 2, 30)), 'Europe/Berlin').toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    expect(fromFloating(new Date(Date.UTC(2026, 5, 1, 9, 0)), 'Asia/Tokyo').toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(toFloating(at('2026-06-01T00:00:00Z'), 'Asia/Tokyo').toISOString()).toBe(
      '2026-06-01T09:00:00.000Z',
    );
  });
});

describe('occurrences', () => {
  it('Europe/Berlin daily across the spring-forward change (2026-03-29)', () => {
    const r = rec({ frequency: 'daily', time: '02:30', timeZone: 'Europe/Berlin' });
    expect(next(r, '2026-03-27T00:00:00Z', 4)).toEqual([
      '2026-03-27T01:30:00.000Z', // 02:30 CET
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:00:00.000Z', // 02:30 does not exist: runs at 03:00 CEST
      '2026-03-30T00:30:00.000Z', // 02:30 CEST
    ]);
    const nine = rec({ frequency: 'daily', time: '09:00', timeZone: 'Europe/Berlin' });
    expect(next(nine, '2026-03-28T12:00:00Z', 2)).toEqual([
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
  });

  it('Europe/Berlin daily across the fall-back change (2026-10-25) runs once', () => {
    const r = rec({ frequency: 'daily', time: '02:30', timeZone: 'Europe/Berlin' });
    expect(next(r, '2026-10-24T00:00:00Z', 3)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z', // first of the two 02:30s
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('America/New_York weekly on weekdays across its DST change (2026-11-01)', () => {
    const r = rec({
      frequency: 'weekly',
      byWeekday: ['FR', 'MO'],
      time: '08:15',
      timeZone: 'America/New_York',
    });
    expect(r.byWeekday).toEqual(['MO', 'FR']);
    expect(next(r, '2026-10-28T00:00:00Z', 3)).toEqual([
      '2026-10-30T12:15:00.000Z', // EDT
      '2026-11-02T13:15:00.000Z', // EST
      '2026-11-06T13:15:00.000Z',
    ]);
  });

  it('Australia/Sydney across its spring-forward change (2026-10-04 02:00 → 03:00)', () => {
    const r = rec({ frequency: 'daily', time: '02:30', timeZone: 'Australia/Sydney' });
    expect(next(r, '2026-10-02T00:00:00Z', 3)).toEqual([
      '2026-10-02T16:30:00.000Z',
      '2026-10-03T16:00:00.000Z', // 03:00 AEDT
      '2026-10-04T15:30:00.000Z',
    ]);
  });

  it('Asia/Tokyo and UTC (no DST)', () => {
    const tokyo = rec({ frequency: 'daily', time: '00:00', timeZone: 'Asia/Tokyo' });
    expect(next(tokyo, '2026-06-01T10:00:00Z', 2)).toEqual([
      '2026-06-01T15:00:00.000Z',
      '2026-06-02T15:00:00.000Z',
    ]);
    const utc = rec({ frequency: 'daily', time: '23:59', timeZone: 'UTC' });
    expect(next(utc, '2026-06-01T23:59:00Z', 1)).toEqual(['2026-06-02T23:59:00.000Z']); // strictly after
  });

  it('monthly on the last day (-1), and 29–31 skipping months without them', () => {
    const last = rec({ frequency: 'monthly', byMonthDay: [-1], time: '18:00', timeZone: 'UTC' });
    expect(next(last, '2027-01-01T00:00:00Z', 4)).toEqual([
      '2027-01-31T18:00:00.000Z',
      '2027-02-28T18:00:00.000Z',
      '2027-03-31T18:00:00.000Z',
      '2027-04-30T18:00:00.000Z',
    ]);
    const thirty = rec({ frequency: 'monthly', byMonthDay: [30], time: '12:00', timeZone: 'UTC' });
    expect(next(thirty, '2027-01-01T00:00:00Z', 3)).toEqual([
      '2027-01-30T12:00:00.000Z',
      '2027-03-30T12:00:00.000Z', // February has no 30th: skipped (RFC 5545)
      '2027-04-30T12:00:00.000Z',
    ]);
    const leap = rec({ frequency: 'monthly', byMonthDay: [29], time: '12:00', timeZone: 'UTC' });
    expect(next(leap, '2027-12-01T00:00:00Z', 3)).toEqual([
      '2027-12-29T12:00:00.000Z',
      '2028-01-29T12:00:00.000Z',
      '2028-02-29T12:00:00.000Z',
    ]);
    // Sorted, unique; -1 last.
    expect(
      rec({ frequency: 'monthly', byMonthDay: [-1, 15, 1], time: '01:00', timeZone: 'UTC' })
        .byMonthDay,
    ).toEqual([1, 15, -1]);
  });

  it('until is the last local date, inclusive', () => {
    const r = rec({
      frequency: 'daily',
      time: '22:00',
      timeZone: 'America/New_York',
      until: '2026-12-03',
    });
    expect(next(r, '2026-12-01T00:00:00Z', 10)).toEqual([
      '2026-12-01T03:00:00.000Z', // Nov 30 22:00 EST (anchor's local date)
      '2026-12-02T03:00:00.000Z',
      '2026-12-03T03:00:00.000Z',
      '2026-12-04T03:00:00.000Z', // Dec 3 22:00 local: still the until date
    ]);
  });

  it('count counts the series from its start, even when asked for later occurrences', () => {
    const r = rec({
      frequency: 'weekly',
      byWeekday: ['MO'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      count: 3,
    });
    const anchor = at('2026-11-04T13:00:00Z');
    expect(iso(occurrencesAfter(r, { anchor, after: anchor, limit: 10 }))).toEqual([
      '2026-11-09T08:00:00.000Z',
      '2026-11-16T08:00:00.000Z',
      '2026-11-23T08:00:00.000Z',
    ]);
    expect(
      iso(occurrencesAfter(r, { anchor, after: at('2026-11-17T00:00:00Z'), limit: 10 })),
    ).toEqual(['2026-11-23T08:00:00.000Z']);
    expect(occurrencesAfter(r, { anchor, after: at('2026-11-24T00:00:00Z'), limit: 10 })).toEqual(
      [],
    );
  });

  it('interval: every second day / week / month', () => {
    const d = rec({ frequency: 'daily', interval: 2, time: '07:00', timeZone: 'UTC' });
    expect(next(d, '2026-06-01T00:00:00Z', 3)).toEqual([
      '2026-06-01T07:00:00.000Z',
      '2026-06-03T07:00:00.000Z',
      '2026-06-05T07:00:00.000Z',
    ]);
    const w = rec({
      frequency: 'weekly',
      interval: 2,
      byWeekday: ['WE'],
      time: '07:00',
      timeZone: 'UTC',
    });
    expect(next(w, '2026-06-01T00:00:00Z', 3)).toEqual([
      '2026-06-03T07:00:00.000Z',
      '2026-06-17T07:00:00.000Z',
      '2026-07-01T07:00:00.000Z',
    ]);
    const m = rec({
      frequency: 'monthly',
      interval: 3,
      byMonthDay: [1],
      time: '07:00',
      timeZone: 'UTC',
    });
    expect(next(m, '2026-06-01T08:00:00Z', 2)).toEqual([
      '2026-09-01T07:00:00.000Z',
      '2026-12-01T07:00:00.000Z',
    ]);
  });

  it('a pattern that never occurs yields nothing (and terminates)', () => {
    const never = rec({
      frequency: 'monthly',
      interval: 12,
      byMonthDay: [31],
      time: '09:00',
      timeZone: 'UTC',
    });
    expect(next(never, '2026-02-10T00:00:00Z', 1)).toEqual([]);
    const past = rec({ frequency: 'daily', time: '09:00', timeZone: 'UTC', until: '2020-01-01' });
    expect(next(past, '2026-02-10T00:00:00Z', 1)).toEqual([]);
  });
});

describe('RRULE text', () => {
  it('anchors DTSTART on the first occurrence, in the zone, with UNTIL in UTC', () => {
    const r = rec({
      frequency: 'weekly',
      byWeekday: ['MO'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
    });
    const first = occurrencesAfter(r, {
      anchor: at('2026-11-04T13:00:00Z'),
      after: at('2026-11-04T13:00:00Z'),
      limit: 1,
    })[0]!;
    expect(toRRuleString(r, first)).toBe(
      'DTSTART;TZID=Europe/Berlin:20261109T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    );
    const u = rec({
      frequency: 'monthly',
      byMonthDay: [31, -1],
      time: '18:00',
      timeZone: 'America/New_York',
      until: '2027-03-31',
    });
    expect(toRRuleString(u, at('2026-11-30T23:00:00Z'))).toBe(
      'DTSTART;TZID=America/New_York:20261130T180000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31,-1;BYHOUR=18;BYMINUTE=0;BYSECOND=0;UNTIL=20270401T035959Z',
    );
    const c = rec({ frequency: 'daily', time: '06:05', timeZone: 'UTC', count: 4 });
    expect(toRRuleString(c, at('2026-01-01T06:05:00Z'))).toMatch(/;COUNT=4$/);
  });

  it('keeps the nominal time when the first run is moved by a DST gap', () => {
    const r = rec({ frequency: 'daily', time: '02:30', timeZone: 'Europe/Berlin', count: 3 });
    const anchor = at('2026-03-28T12:00:00Z');
    const runs = occurrencesAfter(r, { anchor, after: anchor, limit: 3 });
    expect(iso(runs)[0]).toBe('2026-03-29T01:00:00.000Z');
    const text = toRRuleString(r, runs[0]!);
    expect(text.startsWith('DTSTART;TZID=Europe/Berlin:20260329T023000')).toBe(true);
    // The stored series still counts that first (moved) run.
    const stored = { recurrence: r, rrule: text, createdAt: anchor };
    expect(iso(scheduleOccurrencesAfter(stored, at('2026-03-29T00:00:00Z'), 5))).toEqual(iso(runs));
  });

  it('parses DTSTART back as floating local time', () => {
    expect(
      parseDtstart('DTSTART;TZID=Asia/Tokyo:20261109T090000\nRRULE:FREQ=DAILY')?.toISOString(),
    ).toBe('2026-11-09T09:00:00.000Z');
    expect(parseDtstart('RRULE:FREQ=DAILY')).toBeNull();
  });
});
