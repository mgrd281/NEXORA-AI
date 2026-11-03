/**
 * Pure Home logic: the time-of-day greeting in the account's time zone, the first name, the
 * status sentence next to the Presence, and which sections to show. Unit-tested in model.test.ts.
 */
import type { Approval, HomeSnapshot, Suggestion, TaskSummary } from '@jarvis/contracts';
import type { PresenceState } from '@/components/presence/model';
import type { MessageKey } from '@/i18n/catalog';

export type DayPeriod = 'morning' | 'afternoon' | 'evening';

/** The hour (0–23) of `date` in `timeZone` (falls back to the runtime's zone). */
export function hourIn(date: Date, timeZone?: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone,
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isFinite(hour) ? hour % 24 : date.getHours();
  } catch {
    return date.getHours();
  }
}

/** 05:00–11:59 morning, 12:00–17:59 afternoon, otherwise evening. */
export function dayPeriod(date: Date, timeZone?: string): DayPeriod {
  const hour = hourIn(date, timeZone);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** The first word of the display name ("Layla Haddad" → "Layla"); null when empty. */
export function firstName(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/u)[0];
  return first ? first : null;
}

export interface StatusSentencePart {
  key: MessageKey;
  params?: Record<string, number>;
}

/**
 * The Home status sentence. Connectivity problems (the shell's Presence says offline,
 * reconnecting, unavailable or listening) win and use the shell's label; then what needs the
 * person (approvals), then live work, then queued work; otherwise Ready — or the offline
 * planner's limits when no AI model is available.
 */
export function homeStatus(input: {
  presence: PresenceState;
  pendingApprovals: number;
  activeTasks: readonly Pick<TaskSummary, 'status'>[];
  plannerOffline: boolean;
}): StatusSentencePart[] | 'shell' {
  if (
    input.presence === 'offline' ||
    input.presence === 'reconnecting' ||
    input.presence === 'listening'
  ) {
    return 'shell';
  }
  const working = input.activeTasks.filter(
    (t) => t.status === 'RUNNING' || t.status === 'PLANNING' || t.status === 'VERIFYING',
  ).length;
  const queued = input.activeTasks.filter((t) => t.status === 'QUEUED').length;
  const parts: StatusSentencePart[] = [];
  if (input.pendingApprovals > 0)
    parts.push({ key: 'home.status.approvals', params: { count: input.pendingApprovals } });
  if (working > 0) parts.push({ key: 'home.status.working', params: { count: working } });
  else if (queued > 0) parts.push({ key: 'home.status.queued', params: { count: queued } });
  if (parts.length === 0)
    parts.push({ key: input.plannerOffline ? 'home.status.offlinePlanner' : 'home.status.ready' });
  return parts;
}

/**
 * Tasks for "In progress": active tasks, except those already listed under "Needs you" (their
 * pending approval is shown there).
 */
export function inProgressTasks(
  home: Pick<HomeSnapshot, 'activeTasks' | 'pendingApprovals'>,
): TaskSummary[] {
  const approvalTasks = new Set(home.pendingApprovals.map((a: Approval) => a.taskId));
  return home.activeTasks.filter(
    (t) => !(t.status === 'AWAITING_APPROVAL' && approvalTasks.has(t.id)),
  );
}

/** First run: nothing has ever been asked (no approvals, active or recent tasks). */
export function isFirstRun(
  home: Pick<HomeSnapshot, 'activeTasks' | 'pendingApprovals' | 'recentTasks'>,
): boolean {
  return (
    home.pendingApprovals.length === 0 &&
    home.activeTasks.length === 0 &&
    home.recentTasks.length === 0
  );
}

/** Suggestion keys the client has copy for (home.suggest.*); unknown ones are not shown. */
export const SUGGESTION_KEYS = [
  'suggest.enableWeb',
  'suggest.connectEmail',
  'suggest.configureModel',
  'suggest.summarizeAndEmail',
  'suggest.remember',
] as const;

export type KnownSuggestion = Suggestion & { messageKey: (typeof SUGGESTION_KEYS)[number] };

export function knownSuggestions(suggestions: readonly Suggestion[]): KnownSuggestion[] {
  return suggestions.filter((s): s is KnownSuggestion =>
    (SUGGESTION_KEYS as readonly string[]).includes(s.messageKey),
  );
}

/** Only in-app routes are followed from a suggestion's href. */
export function safeInternalHref(href: string | null): string | null {
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  return href;
}
