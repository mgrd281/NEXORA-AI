import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '@jarvis/contracts';
import { isValidTimeZone, mergePreferences } from '../../../src/modules/account/routes';
import { escapeLike } from '../../../src/modules/memory/routes';
import { parseLastEventId } from '../../../src/modules/stream/routes';
import { TASK_STATUS_FILTERS } from '../../../src/modules/tasks/routes';

describe('isValidTimeZone', () => {
  it('accepts IANA zones, UTC and well-formed aliases', () => {
    for (const tz of ['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Asia/Riyadh'])
      expect(isValidTimeZone(tz)).toBe(true);
  });
  it('rejects unknown or malformed zones', () => {
    for (const tz of ['Mars/Olympus', 'Europe/Berlin; drop', '', '../../etc/passwd', 'Not A Zone'])
      expect(isValidTimeZone(tz)).toBe(false);
  });
});

describe('mergePreferences', () => {
  it('overlays only the provided keys of each group', () => {
    const merged = mergePreferences(DEFAULT_PREFERENCES, {
      voice: { speakResponses: true },
      ai: {},
    });
    expect(merged).toEqual({
      ...DEFAULT_PREFERENCES,
      voice: { ...DEFAULT_PREFERENCES.voice, speakResponses: true },
    });
  });
  it('ignores undefined values and unknown groups', () => {
    const merged = mergePreferences(DEFAULT_PREFERENCES, {
      memory: { enabled: undefined },
      ...({ bogus: { x: 1 } } as object),
    });
    expect(merged).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50% off_peak \\ ok')).toBe('50\\% off\\_peak \\\\ ok');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('parseLastEventId', () => {
  const req = (headers: Record<string, string>, query: Record<string, string> = {}) => ({
    headers,
    query,
  });
  it('prefers the header and falls back to the query string', () => {
    expect(parseLastEventId(req({ 'last-event-id': '42' }, { lastEventId: '7' }))).toBe(42);
    expect(parseLastEventId(req({}, { lastEventId: '7' }))).toBe(7);
    expect(parseLastEventId(req({}))).toBeNull();
  });
  it('ignores ids that are not positive integers (e.g. ephemeral ids)', () => {
    expect(parseLastEventId(req({ 'last-event-id': 'eph-1700000000000' }))).toBeNull();
    expect(parseLastEventId(req({ 'last-event-id': '-1' }))).toBeNull();
    expect(parseLastEventId(req({ 'last-event-id': '1'.repeat(20) }))).toBeNull();
  });
});

describe('TASK_STATUS_FILTERS', () => {
  it('maps the list filters to task statuses', () => {
    expect(TASK_STATUS_FILTERS).toEqual({
      active: ['QUEUED', 'PLANNING', 'AWAITING_APPROVAL', 'RUNNING', 'VERIFYING'],
      needs_approval: ['AWAITING_APPROVAL'],
      completed: ['COMPLETED'],
      failed: ['FAILED', 'CANCELLED', 'EXPIRED'],
    });
  });
});
