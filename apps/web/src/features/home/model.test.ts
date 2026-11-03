import type { Approval, Suggestion, TaskSummary } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  dayPeriod,
  firstName,
  homeStatus,
  hourIn,
  inProgressTasks,
  isFirstRun,
  knownSuggestions,
  safeInternalHref,
} from './model';

describe('greeting', () => {
  it('uses the hour in the account time zone, not the browser', () => {
    // 07:30 UTC is 08:30 in Berlin (winter), 23:30 the day before in Los Angeles.
    const d = new Date('2026-11-03T07:30:00Z');
    expect(hourIn(d, 'Europe/Berlin')).toBe(8);
    expect(hourIn(d, 'America/Los_Angeles')).toBe(23);
    expect(dayPeriod(d, 'Europe/Berlin')).toBe('morning');
    expect(dayPeriod(d, 'America/Los_Angeles')).toBe('evening');
    expect(dayPeriod(d, 'Asia/Riyadh')).toBe('morning');
  });

  it('splits the day at 05, 12 and 18', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 3, h, 0));
    expect(dayPeriod(at(4), 'UTC')).toBe('evening');
    expect(dayPeriod(at(5), 'UTC')).toBe('morning');
    expect(dayPeriod(at(11), 'UTC')).toBe('morning');
    expect(dayPeriod(at(12), 'UTC')).toBe('afternoon');
    expect(dayPeriod(at(17), 'UTC')).toBe('afternoon');
    expect(dayPeriod(at(18), 'UTC')).toBe('evening');
    expect(dayPeriod(at(0), 'UTC')).toBe('evening');
  });

  it('survives an invalid time zone', () => {
    expect(() => dayPeriod(new Date(), 'Not/AZone')).not.toThrow();
  });

  it('takes the first name', () => {
    expect(firstName('Layla Haddad')).toBe('Layla');
    expect(firstName('  ليلى   حداد ')).toBe('ليلى');
    expect(firstName('')).toBeNull();
    expect(firstName(undefined)).toBeNull();
  });
});

const task = (
  status: TaskSummary['status'],
  id = status,
): Pick<TaskSummary, 'status'> & { id: string } => ({
  status,
  id,
});

describe('status sentence', () => {
  const base = {
    presence: 'idle' as const,
    pendingApprovals: 0,
    activeTasks: [],
    plannerOffline: false,
  };

  it('says Ready, or the offline planner limits', () => {
    expect(homeStatus(base)).toEqual([{ key: 'home.status.ready' }]);
    expect(homeStatus({ ...base, plannerOffline: true })).toEqual([
      { key: 'home.status.offlinePlanner' },
    ]);
  });

  it('puts approvals first, then work in progress', () => {
    expect(
      homeStatus({
        ...base,
        pendingApprovals: 2,
        activeTasks: [task('RUNNING'), task('PLANNING'), task('AWAITING_APPROVAL'), task('QUEUED')],
      }),
    ).toEqual([
      { key: 'home.status.approvals', params: { count: 2 } },
      { key: 'home.status.working', params: { count: 2 } },
    ]);
  });

  it('mentions queued work only when nothing is running', () => {
    expect(homeStatus({ ...base, activeTasks: [task('QUEUED')] })).toEqual([
      { key: 'home.status.queued', params: { count: 1 } },
    ]);
  });

  it('defers to the shell for connectivity and listening', () => {
    for (const presence of ['offline', 'reconnecting', 'listening'] as const) {
      expect(homeStatus({ ...base, presence, pendingApprovals: 1 })).toBe('shell');
    }
  });
});

describe('sections', () => {
  const approval = { taskId: 't1' } as Approval;
  const t = (id: string, status: TaskSummary['status']) => ({ id, status }) as TaskSummary;

  it('does not repeat a task that is already under "Needs you"', () => {
    const active = [t('t1', 'AWAITING_APPROVAL'), t('t2', 'RUNNING'), t('t3', 'AWAITING_APPROVAL')];
    expect(
      inProgressTasks({ activeTasks: active, pendingApprovals: [approval] }).map((x) => x.id),
    ).toEqual(['t2', 't3']);
  });

  it('detects the first run', () => {
    expect(isFirstRun({ activeTasks: [], pendingApprovals: [], recentTasks: [] })).toBe(true);
    expect(
      isFirstRun({ activeTasks: [], pendingApprovals: [], recentTasks: [t('x', 'FAILED')] }),
    ).toBe(false);
  });

  it('keeps only suggestions with copy and only in-app links', () => {
    const s = (messageKey: string): Suggestion => ({
      id: messageKey,
      kind: 'command',
      messageKey,
      command: null,
      href: null,
    });
    expect(
      knownSuggestions([s('suggest.remember'), s('suggest.unknownThing')]).map((x) => x.id),
    ).toEqual(['suggest.remember']);
    expect(safeInternalHref('/connections')).toBe('/connections');
    expect(safeInternalHref('/settings#assistant')).toBe('/settings#assistant');
    expect(safeInternalHref('//evil.example')).toBeNull();
    expect(safeInternalHref('https://evil.example')).toBeNull();
    expect(safeInternalHref('/\\evil.example')).toBeNull();
    expect(safeInternalHref(null)).toBeNull();
  });
});
