import { TaskStatus } from '@jarvis/contracts';
import type { MessageKey } from '@/i18n/catalog';
import adminSource from '@/i18n/messages/en/admin';

/** Share of executions that succeeded, or null when a tool has not run. */
export function successRate(succeeded: number, executions: number): number | null {
  if (executions <= 0) return null;
  return Math.min(1, Math.max(0, succeeded / executions));
}

/** First 8 characters of a UUID-like id, for dense tables (the full id goes in the title). */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

const TOOL_KEYS: Record<string, MessageKey> = {
  'web.fetch': 'common.tools.webFetch',
  'text.summarize': 'common.tools.textSummarize',
  'email.send': 'common.tools.emailSend',
  'memory.save': 'common.tools.memorySave',
  'assistant.answer': 'common.tools.assistantAnswer',
};

/** The localized name of a tool, or null for a tool this client does not know. */
export function toolLabelKey(toolId: string): MessageKey | null {
  return TOOL_KEYS[toolId] ?? null;
}

export interface StatusCount {
  status: string;
  known: boolean;
  count: number;
}

/**
 * Task counts in the order of the task lifecycle (unknown statuses last), without zero rows.
 */
export function orderedStatusCounts(byStatus: Record<string, number>): StatusCount[] {
  const known = TaskStatus.options as readonly string[];
  const rows = Object.entries(byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count, known: known.includes(status) }));
  return rows.sort((a, b) => {
    const ia = a.known ? known.indexOf(a.status) : known.length;
    const ib = b.known ? known.indexOf(b.status) : known.length;
    return ia - ib || a.status.localeCompare(b.status);
  });
}

/** A tool whose success rate is below this gets a visible warning, not just a colour. */
export const LOW_SUCCESS_RATE = 0.9;

/** True for a rate that needs the warning badge. */
export function isLowRate(rate: number | null): boolean {
  return rate !== null && rate < LOW_SUCCESS_RATE;
}

const AUDIT_EVENTS: Record<string, Record<string, string>> = adminSource.audit.events;
const AUDIT_TARGETS: Record<string, string> = adminSource.audit.targets;

/**
 * The localized sentence for an audit action ('auth.login' → 'admin.audit.events.auth.login'),
 * or null for an action this client has no wording for (it is then shown as its raw key).
 */
export function auditEventKey(action: string): MessageKey | null {
  const dot = action.indexOf('.');
  if (dot <= 0) return null;
  const domain = action.slice(0, dot);
  const verb = action.slice(dot + 1);
  return Object.hasOwn(AUDIT_EVENTS, domain) && Object.hasOwn(AUDIT_EVENTS[domain]!, verb)
    ? (`admin.audit.events.${domain}.${verb}` as MessageKey)
    : null;
}

/** The localized name of an audit target type ('task_step' → 'Task step'), or null. */
export function auditTargetKey(targetType: string): MessageKey | null {
  return Object.hasOwn(AUDIT_TARGETS, targetType)
    ? (`admin.audit.targets.${targetType}` as MessageKey)
    : null;
}

/** Admin page views (admin.users_viewed, admin.audit_viewed …): audited, but routine. */
export function isAdminView(action: string): boolean {
  return /^admin\.[a-z_]+_viewed$/.test(action);
}

export type AuditRow<E extends AuditEventLike = AuditEventLike> =
  | { kind: 'event'; key: string; event: E }
  /** A run of consecutive admin page views by one actor; `event` is the newest of them. */
  | { kind: 'adminViews'; key: string; event: E; count: number };

interface AuditEventLike {
  id: string;
  action: string;
  actorId: string | null;
}

/**
 * Audit events (newest first) as table rows. With `collapseAdminViews`, consecutive admin page
 * views by the same actor become one row with a count, so they don't bury the actions that
 * matter; a run of one stays an ordinary row.
 */
export function groupAuditEvents<E extends AuditEventLike>(
  events: readonly E[],
  collapseAdminViews: boolean,
): AuditRow<E>[] {
  const rows: AuditRow<E>[] = [];
  for (const event of events) {
    if (!collapseAdminViews || !isAdminView(event.action)) {
      rows.push({ kind: 'event', key: event.id, event });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last && last.kind === 'adminViews' && last.event.actorId === event.actorId) {
      last.count += 1;
    } else {
      rows.push({ kind: 'adminViews', key: event.id, event, count: 1 });
    }
  }
  return rows.map((row) =>
    row.kind === 'adminViews' && row.count === 1
      ? { kind: 'event', key: row.key, event: row.event }
      : row,
  );
}
