import { TaskStatus } from '@jarvis/contracts';
import type { MessageKey } from '@/i18n/catalog';

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
