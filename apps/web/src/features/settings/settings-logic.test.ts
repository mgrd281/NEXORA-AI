import { DEFAULT_PREFERENCES, type Me } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { formatBudgetInput, parseBudget, usageLevel } from './budget';
import { exportFileName } from './exportFile';
import { applyPatch } from './patch';
import { timeZoneOptions, utcOffsetLabel, zoneDisplayName } from './timeZones';
import { summarizeUserAgent } from './userAgent';

const ME: Me = {
  id: '1c7e9b4f-3d62-4e8b-8f21-6a4d3b2c8e02',
  email: 'layla.haddad@example.com',
  displayName: 'Layla Haddad',
  locale: 'en',
  timeZone: 'Europe/Berlin',
  theme: 'system',
  roles: ['owner'],
  tenant: { id: '0b6f8a3e-2c51-4d7a-9e10-5f3c2a1b7d01', name: 'Haddad' },
  preferences: DEFAULT_PREFERENCES,
  createdAt: '2026-10-01T09:00:00.000Z',
};

describe('summarizeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      { browser: 'Chrome', os: 'macOS', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0',
      { browser: 'Edge', os: 'Windows', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS', kind: 'phone' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      { browser: 'Firefox', os: 'Linux', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android', kind: 'phone' },
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
      { browser: 'Chrome', os: 'iPadOS', kind: 'tablet' },
    ],
  ])('names %s', (ua, expected) => {
    expect(summarizeUserAgent(ua)).toEqual(expected);
  });

  it('never guesses for unknown or missing agents', () => {
    expect(summarizeUserAgent(null)).toEqual({ browser: null, os: null, kind: 'unknown' });
    expect(summarizeUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null, kind: 'unknown' });
    expect(summarizeUserAgent('JarvisApp/1.0 CFNetwork/1490 Darwin/24.0.0').browser).toBeNull();
  });
});

describe('budget input', () => {
  it('formats the saved budget the way it is typed in each language', () => {
    expect(formatBudgetInput(20, 'en')).toBe('20');
    expect(formatBudgetInput(12.5, 'en')).toBe('12.5');
    expect(formatBudgetInput(12.5, 'de')).toBe('12,5');
    expect(formatBudgetInput(0.75, 'ar')).toBe('0.75');
  });

  it('parses amounts with the locale separators, an optional $ or USD', () => {
    expect(parseBudget('20', 'en')).toBe(20);
    expect(parseBudget(' $12.50 ', 'en')).toBe(12.5);
    expect(parseBudget('1,000', 'en')).toBe(1000);
    expect(parseBudget('12,50', 'de')).toBe(12.5);
    expect(parseBudget('1.000', 'de')).toBe(1000);
    expect(parseBudget('15 USD', 'ar')).toBe(15);
    expect(parseBudget('0', 'en')).toBe(0);
  });

  it('rejects anything outside 0–10,000 or with more than two decimals', () => {
    for (const bad of ['', 'abc', '-1', '10000.01', '20000', '1.234', '1e3', '12.5.0']) {
      expect(parseBudget(bad, 'en'), bad).toBeNull();
    }
    // A decimal point typed in German (not a valid thousands group) is read as the decimal mark.
    expect(parseBudget('12.50', 'de')).toBe(12.5);
    expect(parseBudget('12,5', 'en')).toBe(12.5);
    expect(parseBudget('1,000.50', 'en')).toBe(1000.5);
    expect(parseBudget('1.2.3', 'de')).toBeNull();
  });

  it('grades usage against the budget', () => {
    expect(usageLevel(0, 0)).toBe('none');
    expect(usageLevel(1_000_000, 20_000_000)).toBe('ok');
    expect(usageLevel(16_000_000, 20_000_000)).toBe('warn');
    expect(usageLevel(20_000_000, 20_000_000)).toBe('full');
  });
});

describe('time zones', () => {
  it('always offers UTC first and keeps the current zone even if Intl does not list it', () => {
    const options = timeZoneOptions('Asia/Calcutta', 'en-US', [
      'Europe/Berlin',
      'America/New_York',
    ]);
    expect(options[0]?.value).toBe('UTC');
    expect(options.map((o) => o.value)).toContain('Asia/Calcutta');
    expect(options.map((o) => o.value)).toEqual([
      'UTC',
      'America/New_York',
      'Asia/Calcutta',
      'Europe/Berlin',
    ]);
  });

  it('labels zones with readable names and their current offset', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    expect(zoneDisplayName('America/Argentina/Buenos_Aires')).toBe(
      'America / Argentina / Buenos Aires',
    );
    expect(utcOffsetLabel('Europe/Berlin', 'en-US', winter)).toBe('GMT+1');
    const [, berlin] = timeZoneOptions('Europe/Berlin', 'en-US', ['Europe/Berlin'], winter);
    expect(berlin?.label).toBe('Europe / Berlin (GMT+1)');
  });
});

describe('applyPatch', () => {
  it('previews a pending save without touching other preferences', () => {
    const next = applyPatch(ME, { preferences: { notifications: { taskFailed: false } } });
    expect(next.preferences.notifications).toEqual({
      approvalRequested: true,
      taskCompleted: true,
      taskFailed: false,
    });
    expect(next.preferences.voice).toBe(ME.preferences.voice);
    expect(ME.preferences.notifications.taskFailed).toBe(true);
    expect(applyPatch(ME, { theme: 'dark' }).theme).toBe('dark');
  });
});

describe('exportFileName', () => {
  it('uses the local calendar day', () => {
    expect(exportFileName(new Date(2026, 10, 3, 23, 30))).toBe('jarvis-export-2026-11-03.json');
  });
});
