import type { Recurrence } from '@jarvis/contracts';
import { Recurrence as RecurrenceSchema } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  defaultRecurrence,
  describeRecurrence,
  formatInZone,
  formatLocalTime,
  sortMonthDays,
  sortWeekdays,
  weekdayNames,
  withFrequency,
} from '@/features/schedules/recurrence';
import { offsetLabel, serverTimeZoneOptions, zoneDisplayName } from '@/features/settings/timeZones';
import { eventTypeKey, hostOf, isPlausibleWebhookUrl } from '@/features/webhooks/api';
import { LOCALES, type Locale } from '@/i18n/config';
import { createFormatters } from '@/i18n/format';
import { catalogs } from '@/i18n/messages';
import { createTranslator, lookup, stripIsolates } from '@/i18n/translate';
import { WebhookDeliveryEventType } from '@jarvis/contracts';

const ctx = (locale: Locale) => ({
  t: createTranslator(locale, catalogs[locale]),
  f: createFormatters(locale, 'Europe/Berlin'),
});
const say = (r: Partial<Recurrence>, locale: Locale = 'en') =>
  stripIsolates(
    describeRecurrence(
      { frequency: 'daily', interval: 1, time: '09:00', ...r } as Recurrence,
      ctx(locale),
    ),
  );

describe('recurrence sentences (phrased on the client from the fields)', () => {
  it('daily, weekly, workdays and monthly in English', () => {
    expect(say({})).toBe('Every day at 9:00 AM');
    expect(say({ interval: 3 })).toBe('Every 3 days at 9:00 AM');
    expect(say({ frequency: 'weekly', byWeekday: ['WE', 'MO'] })).toBe(
      'Every Monday and Wednesday at 9:00 AM',
    );
    expect(say({ frequency: 'weekly', interval: 2, byWeekday: ['FR'] })).toBe(
      'Every 2 weeks on Friday at 9:00 AM',
    );
    expect(say({ frequency: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'] })).toBe(
      'Monday to Friday at 9:00 AM',
    );
    expect(
      say({ frequency: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] }),
    ).toBe('Every day at 9:00 AM');
    expect(say({ frequency: 'monthly', byMonthDay: [-1, 1], time: '16:30' })).toBe(
      'Monthly on the 1st and the last day at 4:30 PM',
    );
    expect(say({ frequency: 'monthly', byMonthDay: [2, 3, 11, 22] })).toBe(
      'Monthly on the 2nd, the 3rd, the 11th, and the 22nd at 9:00 AM',
    );
  });

  it('ends: until a date or a number of runs', () => {
    expect(say({ until: '2026-12-31' })).toBe('Every day at 9:00 AM, until Dec 31, 2026');
    expect(say({ count: 5 })).toBe('Every day at 9:00 AM, 5 times in total');
    expect(say({ count: 1 })).toBe('Every day at 9:00 AM, once in total');
  });

  it('German uses 24-hour times with “Uhr” and natural word order', () => {
    expect(say({}, 'de')).toBe('Täglich um 9:00 Uhr');
    expect(say({ frequency: 'weekly', byWeekday: ['MO'] }, 'de')).toBe('Jeden Montag um 9:00 Uhr');
    expect(say({ frequency: 'monthly', byMonthDay: [1, -1], time: '16:30' }, 'de')).toBe(
      'Monatlich am 1. und letzten Tag um 16:30 Uhr',
    );
    expect(say({ count: 5 }, 'de')).toBe('Täglich um 9:00 Uhr, insgesamt 5 Mal');
  });

  it('Arabic uses its plural forms (two weeks is its own word)', () => {
    const twoWeeks = say({ frequency: 'weekly', interval: 2, byWeekday: ['MO'] }, 'ar');
    expect(twoWeeks).toContain('كل أسبوعين');
    expect(twoWeeks).toContain('الاثنين');
    expect(say({ frequency: 'monthly', byMonthDay: [-1] }, 'ar')).toContain('آخر يوم من الشهر');
  });

  it('has a sentence for every frequency and interval in every language', () => {
    for (const locale of LOCALES) {
      for (const frequency of ['daily', 'weekly', 'monthly'] as const) {
        for (const interval of [1, 2, 3, 11, 12]) {
          const text = say(
            {
              frequency,
              interval,
              ...(frequency === 'weekly' ? { byWeekday: ['MO', 'TH'] } : {}),
              ...(frequency === 'monthly' ? { byMonthDay: [1, 15] } : {}),
            },
            locale,
          );
          expect(text, `${locale} ${frequency} ${interval}`).not.toMatch(/[{}]|schedules\./);
        }
      }
    }
  });
});

describe('recurrence editing keeps the contract valid', () => {
  const today = new Date(Date.UTC(2026, 10, 4)); // a Wednesday, the 4th

  it('starts daily at 09:00 in the account’s zone', () => {
    const r = defaultRecurrence('Europe/Berlin');
    expect(r).toEqual({
      frequency: 'daily',
      interval: 1,
      time: '09:00',
      timeZone: 'Europe/Berlin',
    });
    expect(RecurrenceSchema.safeParse(r).success).toBe(true);
  });

  it('switching frequency fills in what the new one needs and drops what it can’t have', () => {
    const daily = defaultRecurrence('UTC');
    const weekly = withFrequency(daily, 'weekly', today);
    expect(weekly.byWeekday).toEqual(['WE']);
    expect(weekly.byMonthDay).toBeUndefined();
    const monthly = withFrequency(weekly, 'monthly', today);
    expect(monthly.byMonthDay).toEqual([4]);
    expect(monthly.byWeekday).toBeUndefined();
    const back = withFrequency(monthly, 'daily', today);
    expect(back).toEqual({ ...daily });
    for (const r of [weekly, monthly, back])
      expect(RecurrenceSchema.safeParse(r).success).toBe(true);
  });

  it('keeps chosen days and an end when switching back and forth', () => {
    const r: Recurrence = {
      frequency: 'weekly',
      interval: 2,
      byWeekday: ['FR'],
      time: '17:30',
      timeZone: 'UTC',
      count: 4,
    };
    expect(withFrequency(r, 'weekly', today)).toMatchObject({
      byWeekday: ['FR'],
      count: 4,
      interval: 2,
    });
  });

  it('sorts days into calendar order, the last day of the month at the end', () => {
    expect(sortWeekdays(['SU', 'MO', 'WE', 'MO'])).toEqual(['MO', 'WE', 'SU']);
    expect(sortMonthDays([-1, 15, 1, 15])).toEqual([1, 15, -1]);
  });
});

describe('times and dates in the schedule’s zone', () => {
  it('writes a local time the way the language does', () => {
    expect(formatLocalTime('09:05', 'en-US')).toBe('9:05 AM');
    expect(formatLocalTime('21:30', 'de-DE')).toBe('21:30');
    expect(formatLocalTime('bad', 'en-US')).toBe('bad');
  });

  it('formats an instant as wall-clock time in the given zone', () => {
    const monday9Berlin = '2026-11-09T08:00:00.000Z';
    expect(formatInZone(monday9Berlin, 'Europe/Berlin', 'en-US')).toBe('Mon, Nov 9, 9:00 AM');
    expect(formatInZone(monday9Berlin, 'America/New_York', 'en-US')).toBe('Mon, Nov 9, 3:00 AM');
    // An unknown zone falls back to the device's (never throws).
    expect(formatInZone(monday9Berlin, 'Mars/Olympus', 'en-US')).toMatch(/Nov 9/);
  });

  it('names weekdays Monday first', () => {
    expect(Object.values(weekdayNames('en-US', 'short'))).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(weekdayNames('de-DE').MO).toBe('Montag');
  });
});

describe('time-zone picker options (from the server list)', () => {
  it('labels offsets with a real minus sign and minutes when needed', () => {
    expect(offsetLabel(0)).toBe('GMT');
    expect(offsetLabel(60)).toBe('GMT+1');
    expect(offsetLabel(-210)).toBe('GMT−3:30');
    expect(offsetLabel(345)).toBe('GMT+5:45');
  });

  it('lists exactly the server’s zones, UTC first, keeping the stored one', () => {
    const zones = [
      { id: 'Europe/Berlin', utcOffsetMinutes: 60 },
      { id: 'UTC', utcOffsetMinutes: 0 },
      { id: 'America/Argentina/Buenos_Aires', utcOffsetMinutes: -180 },
    ];
    const options = serverTimeZoneOptions(zones, 'Europe/Berlin');
    expect(options.map((o) => o.value)).toEqual([
      'UTC',
      'America/Argentina/Buenos_Aires',
      'Europe/Berlin',
    ]);
    expect(options[1]!.label).toBe('America / Argentina / Buenos Aires (GMT−3)');
    // A stored zone the list lacks stays selectable (never silently replaced).
    expect(serverTimeZoneOptions(zones, 'Asia/Kolkata').map((o) => o.value)).toContain(
      'Asia/Kolkata',
    );
    expect(zoneDisplayName('Asia/Ho_Chi_Minh')).toBe('Asia / Ho Chi Minh');
  });
});

describe('webhook helpers', () => {
  it('accepts full http(s) URLs only, without credentials or fragments', () => {
    expect(isPlausibleWebhookUrl('https://hooks.example.com/jarvis')).toBe(true);
    expect(isPlausibleWebhookUrl(' https://hooks.example.com ')).toBe(true);
    expect(isPlausibleWebhookUrl('http://localhost:8080/hook')).toBe(true); // the server decides
    for (const bad of [
      'hooks.example.com',
      'ftp://hooks.example.com',
      'https://user:pw@hooks.example.com',
      'https://hooks.example.com/#x',
      '',
    ]) {
      expect(isPlausibleWebhookUrl(bad), bad).toBe(false);
    }
  });

  it('names endpoints by host', () => {
    expect(hostOf('https://hooks.example.com:8443/a?b')).toBe('hooks.example.com:8443');
    expect(hostOf('not a url')).toBe('not a url');
  });

  it('has copy for every delivery event type in every language', () => {
    for (const locale of LOCALES) {
      for (const type of WebhookDeliveryEventType.options) {
        expect(lookup(catalogs[locale], eventTypeKey(type)), `${locale} ${type}`).toBeTruthy();
      }
    }
  });
});
