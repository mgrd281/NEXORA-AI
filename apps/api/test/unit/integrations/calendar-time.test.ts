/** Time zones and free-slot proposals (computed in the zone, DST-correct; only from provider answers). */
import { describe, expect, it } from 'vitest';
import {
  conflicts,
  freeBusyResult,
  mergeBusy,
  proposeSlots,
} from '../../../src/modules/integrations/calendar';
import {
  localDateTime,
  windowsToIana,
  zonedToUtc,
} from '../../../src/modules/integrations/timezones';
import { resolveTime } from '../../../src/modules/agent/tools/integrations/common';

describe('zonedToUtc', () => {
  it('converts wall times in the zone, across DST changes', () => {
    // Berlin: CET (+01:00) in winter, CEST (+02:00) in summer.
    expect(zonedToUtc(2026, 1, 15, 9, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
    expect(zonedToUtc(2026, 7, 15, 9, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    );
    // The day clocks go forward (29 March 2026): 08:00 is already summer time.
    expect(zonedToUtc(2026, 3, 29, 8, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T06:00:00.000Z',
    );
    // 02:30 does not exist that night: resolved after the gap.
    expect(zonedToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin').getTime()).toBeGreaterThanOrEqual(
      Date.parse('2026-03-29T01:00:00Z'),
    );
    // Fall back (25 October 2026): 02:30 happens twice → the earlier one.
    expect(zonedToUtc(2026, 10, 25, 2, 30, 'Europe/Berlin').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(zonedToUtc(2026, 11, 5, 10, 0, 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-05T04:30:00.000Z',
    );
    expect(localDateTime(new Date('2026-07-15T07:00:00Z'), 'Europe/Berlin')).toBe(
      '2026-07-15T09:00:00',
    );
  });

  it('maps Windows zone ids (Graph) to IANA with the CLDR table', () => {
    expect(windowsToIana('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(windowsToIana('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(windowsToIana('Arab Standard Time')).toBe('Asia/Riyadh');
    expect(windowsToIana('Europe/Paris')).toBe('Europe/Paris');
    expect(windowsToIana('Not A Zone')).toBeNull();
    expect(windowsToIana(null)).toBeNull();
  });

  it('resolves local times of tool inputs in the step’s zone', () => {
    expect(resolveTime('2026-07-15T09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    );
    expect(resolveTime('2026-07-15T09:00:00+00:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-15T09:00:00.000Z',
    );
    expect(resolveTime('2026-07-15', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-14T22:00:00.000Z',
    );
  });
});

describe('proposeSlots', () => {
  const tz = 'Europe/Berlin';
  const now = new Date('2026-01-01T00:00:00Z');
  // Monday 12 January 2026.
  const day = { from: new Date('2026-01-11T23:00:00Z'), to: new Date('2026-01-12T23:00:00Z') };

  it('proposes non-overlapping times within working hours of the zone, around busy times', () => {
    const busy = [
      { start: Date.parse('2026-01-12T07:00:00Z'), end: Date.parse('2026-01-12T09:00:00Z') }, // 08–10 local
    ];
    const slots = proposeSlots({ ...day, durationMinutes: 30, timeZone: tz, busy, now });
    expect(slots[0]).toEqual({
      start: '2026-01-12T09:00:00.000Z',
      end: '2026-01-12T09:30:00.000Z',
    });
    expect(slots).toHaveLength(5);
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.start >= slots[i - 1]!.end).toBe(true);
  });

  it('skips weekends, never proposes the past, honours the working day end', () => {
    const weekend = {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-12T00:00:00Z'),
    };
    expect(proposeSlots({ ...weekend, durationMinutes: 30, timeZone: tz, busy: [], now })).toEqual(
      [],
    );
    const late = proposeSlots({
      ...day,
      durationMinutes: 60,
      timeZone: tz,
      busy: [],
      now: new Date('2026-01-12T16:20:00Z'),
    });
    // 17:20 local → next step 17:30 + 60 min would pass 18:00: nothing left today.
    expect(late).toEqual([]);
  });

  it('computes working hours in the zone on a DST change day', () => {
    // Monday 30 March 2026, the day after the change: 08:00 CEST = 06:00 UTC.
    const slots = proposeSlots({
      from: new Date('2026-03-29T22:00:00Z'),
      to: new Date('2026-03-30T22:00:00Z'),
      durationMinutes: 30,
      timeZone: tz,
      busy: [],
      now,
      max: 1,
    });
    expect(slots[0]!.start).toBe('2026-03-30T06:00:00.000Z');
  });

  it('only uses accessible calendars and says which were not shared', () => {
    const calendars = [
      {
        email: 'me@x.test',
        accessible: true,
        busy: [{ start: '2026-01-12T07:00:00.000Z', end: '2026-01-12T08:00:00.000Z' }],
      },
      { email: 'hidden@x.test', accessible: false, busy: [] },
    ];
    expect(mergeBusy(calendars)).toHaveLength(1);
    const result = freeBusyResult({ ...day, timeZone: tz, durationMinutes: 30, calendars, now });
    expect(result.calendars.find((c) => c.email === 'hidden@x.test')!.accessible).toBe(false);
    expect(result.slots[0]!.start).toBe('2026-01-12T08:00:00.000Z');
    expect(
      conflicts(calendars, new Date('2026-01-12T07:30:00Z'), new Date('2026-01-12T08:30:00Z')),
    ).toBe(1);
    expect(
      conflicts(calendars, new Date('2026-01-12T08:00:00Z'), new Date('2026-01-12T08:30:00Z')),
    ).toBe(0);
  });
});
