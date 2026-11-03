/**
 * Pure helpers for the Task Center and task detail: filter <-> URL mapping, evidence parsing,
 * localized event descriptions, attempt / cancellation state and step-preview formatting.
 * No React, no I/O — unit-tested in model.test.ts.
 */
import type {
  ErrorCode,
  Evidence,
  TaskDetail,
  TaskEvent,
  TaskListQuery,
  TaskStatus,
  TaskStep,
  ToolId,
} from '@jarvis/contracts';
import { isTerminal, TaskStatus as TaskStatusEnum } from '@jarvis/contracts';
import type { MessageKey } from '@/i18n/catalog';

/* ------------------------------------------------------------------ filters */

export type TaskFilter = TaskListQuery['status'];

/** Display order of the Task Center filter. */
export const TASK_FILTERS: readonly TaskFilter[] = [
  'needs_approval',
  'active',
  'completed',
  'failed',
  'all',
];

export const DEFAULT_FILTER: TaskFilter = 'all';

export const FILTER_LABEL: Record<TaskFilter, MessageKey> = {
  needs_approval: 'tasks.filters.needsApproval',
  active: 'tasks.filters.active',
  completed: 'tasks.filters.completed',
  failed: 'tasks.filters.failed',
  all: 'tasks.filters.all',
};

export const FILTER_EMPTY: Record<TaskFilter, MessageKey> = {
  needs_approval: 'tasks.empty.needsApproval',
  active: 'tasks.empty.active',
  completed: 'tasks.empty.completed',
  failed: 'tasks.empty.failed',
  all: 'tasks.empty.all',
};

/** `?status=` → filter; anything unknown falls back to All. */
export function parseFilter(value: string | null | undefined): TaskFilter {
  return (TASK_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as TaskFilter)
    : DEFAULT_FILTER;
}

/** The Task Center URL for a filter (All is the bare path). */
export function filterHref(filter: TaskFilter): string {
  return filter === DEFAULT_FILTER ? '/tasks' : `/tasks?status=${filter}`;
}

/* ------------------------------------------------------------------ tools */

export const TOOL_LABEL: Record<ToolId, MessageKey> = {
  'web.fetch': 'common.tools.webFetch',
  'text.summarize': 'common.tools.textSummarize',
  'email.send': 'common.tools.emailSend',
  'memory.save': 'common.tools.memorySave',
  'assistant.answer': 'common.tools.assistantAnswer',
};

/* ------------------------------------------------------------------ evidence */

export type EvidenceView =
  | {
      kind: 'smtp_receipt';
      /** SMTP reply code, e.g. "250". */
      code: string | null;
      accepted: number | null;
      messageId: string | null;
      /** The server's reply without the Message-ID part. */
      response: string;
    }
  | {
      kind: 'http_response';
      status: number | null;
      /** A safe http(s) URL to link to, or null. */
      url: string | null;
      contentType: string | null;
      bytes: number | null;
    }
  | { kind: 'content_hash'; algorithm: string; hex: string; value: string }
  | { kind: 'model_output'; model: string; inputTokens: number | null; outputTokens: number | null }
  | { kind: 'record' | 'note'; label: string; value: string };

/** Only http(s) URLs become links (never javascript:, data: …). */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

/**
 * Turns the API's evidence strings into structured views. The formats are produced by the tools
 * (web.fetch: "GET <url> → 200 (text/html, 48213 bytes)"; email.send: "<reply> · Message-ID <id>";
 * content hashes "sha256:<hex>"); anything unexpected degrades to the raw label and value.
 */
export function parseEvidence(e: Evidence): EvidenceView {
  switch (e.kind) {
    case 'smtp_receipt': {
      const code = /\b([2-5]\d\d)\b/.exec(e.label)?.[1] ?? /^\s*([2-5]\d\d)\b/.exec(e.value)?.[1];
      const accepted = /(\d+)\s+accepted/i.exec(e.label)?.[1];
      const id = /Message-ID\s*:?\s*(\S+)/i.exec(e.value)?.[1] ?? null;
      const response = e.value.replace(/\s*·?\s*Message-ID\s*:?\s*\S+\s*$/i, '').trim();
      return {
        kind: 'smtp_receipt',
        code: code ?? null,
        accepted: accepted ? Number(accepted) : null,
        messageId: id,
        response,
      };
    }
    case 'http_response': {
      const status =
        /HTTP\s+(\d{3})/i.exec(e.label)?.[1] ?? /→\s*(\d{3})\b/.exec(e.value)?.[1] ?? null;
      const meta = /\(([^,()]+),\s*(\d+)\s*bytes\)/i.exec(e.value);
      return {
        kind: 'http_response',
        status: status ? Number(status) : null,
        url: safeExternalUrl(URL_RE.exec(e.value)?.[0]),
        contentType: meta?.[1]?.trim() ?? null,
        bytes: meta?.[2] ? Number(meta[2]) : null,
      };
    }
    case 'content_hash': {
      const m = /^([a-z0-9-]+):([0-9a-f]+)$/i.exec(e.value.trim());
      const algo = m?.[1] ?? '';
      const sha = /^sha-?(\d+)$/i.exec(algo);
      return {
        kind: 'content_hash',
        algorithm: sha ? `SHA-${sha[1]}` : algo.toUpperCase(),
        hex: m?.[2] ?? e.value.trim(),
        value: e.value.trim(),
      };
    }
    case 'model_output': {
      const tokens = /(\d+)\s+input\s*\/\s*(\d+)\s+output/i.exec(e.value);
      return {
        kind: 'model_output',
        model: e.label,
        inputTokens: tokens?.[1] ? Number(tokens[1]) : null,
        outputTokens: tokens?.[2] ? Number(tokens[2]) : null,
      };
    }
    case 'record':
    case 'note':
      return { kind: e.kind, label: e.label, value: e.value };
  }
}

/** "5d2f8c1a…0e4b8d2f": enough to compare by eye; the full value stays copyable. */
export function shortHash(hex: string, head = 8, tail = 8): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/* ------------------------------------------------------------------ events */

export interface EventDescription {
  key: MessageKey;
  params?: Record<string, string | number>;
  /** Extra lines from the event (server-written check results or messages). */
  details?: string[];
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

function statusParam(v: unknown): TaskStatus | null {
  const parsed = TaskStatusEnum.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/**
 * The localized description of a timeline event (shapes documented in
 * apps/api/src/modules/events/events.ts). `statusLabel` localizes a task status.
 */
export function describeEvent(
  event: Pick<TaskEvent, 'type' | 'data'>,
  statusLabel: (status: TaskStatus) => string,
  unknownStep: string,
): EventDescription {
  const d = event.data;
  const title = str(d.title) ?? unknownStep;
  switch (event.type) {
    case 'task.created':
      return { key: 'tasks.events.created', tone: 'neutral' };
    case 'task.status_changed': {
      const to = statusParam(d.to);
      if (!to)
        return { key: 'tasks.events.statusChanged', params: { status: '—' }, tone: 'neutral' };
      const tone =
        to === 'COMPLETED'
          ? 'success'
          : to === 'FAILED'
            ? 'danger'
            : to === 'AWAITING_APPROVAL' || to === 'EXPIRED'
              ? 'warning'
              : 'neutral';
      return { key: 'tasks.events.statusChanged', params: { status: statusLabel(to) }, tone };
    }
    case 'plan.ready': {
      const count = typeof d.stepCount === 'number' ? d.stepCount : 0;
      const planner = (d.planner ?? {}) as { mode?: unknown; model?: unknown; provider?: unknown };
      if (planner.mode === 'offline')
        return { key: 'tasks.events.planReadyOffline', params: { count }, tone: 'accent' };
      const model = str(planner.model) ?? str(planner.provider);
      if (planner.mode === 'model' && model)
        return { key: 'tasks.events.planReadyModel', params: { count, model }, tone: 'accent' };
      return { key: 'tasks.events.planReady', params: { count }, tone: 'accent' };
    }
    case 'step.started':
      return { key: 'tasks.events.stepStarted', params: { title }, tone: 'neutral' };
    case 'step.succeeded':
      return { key: 'tasks.events.stepSucceeded', params: { title }, tone: 'success' };
    case 'step.failed': {
      const message = str(d.message);
      return {
        key: 'tasks.events.stepFailed',
        params: { title },
        details: message ? [message] : undefined,
        tone: 'danger',
      };
    }
    case 'step.blocked':
      return { key: 'tasks.events.stepBlocked', params: { title }, tone: 'danger' };
    case 'approval.requested':
      return {
        key: 'tasks.events.approvalRequested',
        details: str(d.summary) ? [str(d.summary)!] : undefined,
        tone: 'warning',
      };
    case 'approval.decided':
      switch (d.decision) {
        case 'approved':
          return { key: 'tasks.events.approvalApproved', tone: 'success' };
        case 'rejected':
          return { key: 'tasks.events.approvalRejected', tone: 'neutral' };
        case 'expired':
          return { key: 'tasks.events.approvalExpired', tone: 'warning' };
        default:
          return { key: 'tasks.events.approvalDecided', tone: 'neutral' };
      }
    case 'verification.passed':
      return {
        key: 'tasks.events.verificationPassed',
        details: strings(d.checks),
        tone: 'success',
      };
    case 'verification.failed': {
      const message = str(d.message);
      return {
        key: 'tasks.events.verificationFailed',
        details: [...(message ? [message] : []), ...strings(d.checks)],
        tone: 'danger',
      };
    }
    case 'task.cancel_requested':
      return { key: 'tasks.events.cancelRequested', tone: 'neutral' };
    case 'task.retried':
      return {
        key: 'tasks.events.retried',
        params: { attempt: typeof d.attempt === 'number' ? d.attempt : 2 },
        tone: 'accent',
      };
    case 'task.answer.delta':
      return { key: 'tasks.events.answerDelta', tone: 'neutral' };
  }
}

/* ------------------------------------------------------------------ task state */

/** Events since the most recent retry (the current attempt). */
function currentAttemptEvents(events: readonly TaskEvent[]): readonly TaskEvent[] {
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === 'task.retried') start = i + 1;
  });
  return events.slice(start);
}

/** The attempt number (1 for the first run; task.retried carries the new attempt). */
export function attemptOf(detail: Pick<TaskDetail, 'events'>): number {
  let attempt = 1;
  for (const e of detail.events) {
    if (e.type === 'task.retried' && typeof e.data.attempt === 'number') attempt = e.data.attempt;
  }
  return attempt;
}

/** A cancellation was requested in this attempt and the task has not stopped yet. */
export function isCancelRequested(detail: Pick<TaskDetail, 'events' | 'status'>): boolean {
  if (isTerminal(detail.status)) return false;
  return currentAttemptEvents(detail.events).some((e) => e.type === 'task.cancel_requested');
}

/** The step whose failure made the task fail (for OUTCOME_UNKNOWN copy and guidance). */
export function failedStep(detail: Pick<TaskDetail, 'steps'>): TaskStep | null {
  return detail.steps.find((s) => s.status === 'FAILED' || s.status === 'BLOCKED') ?? null;
}

export function requiresAcknowledgement(detail: Pick<TaskDetail, 'error'>): boolean {
  return detail.error?.code === 'OUTCOME_UNKNOWN';
}

/** Error codes with specific guidance copy in tasks.guidance. */
const GUIDED: readonly ErrorCode[] = [
  'FETCH_BLOCKED',
  'CONNECTION_REQUIRED',
  'CONNECTION_FAILED',
  'TOOL_TIMEOUT',
  'OUTCOME_UNKNOWN',
  'MODEL_ERROR',
  'MODEL_NOT_CONFIGURED',
  'PLANNER_UNSUPPORTED',
  'BUDGET_EXCEEDED',
  'POLICY_DENIED',
  'VERIFICATION_FAILED',
];

/** What the person can do about an error, in plain language. */
export function guidanceFor(error: { code: ErrorCode; retryable: boolean }): {
  key: MessageKey;
  link: { href: string; key: MessageKey } | null;
} {
  const key: MessageKey = GUIDED.includes(error.code)
    ? (`tasks.guidance.${error.code}` as MessageKey)
    : error.retryable
      ? 'tasks.guidance.retryable'
      : 'tasks.guidance.notRetryable';
  const link =
    error.code === 'CONNECTION_REQUIRED' || error.code === 'CONNECTION_FAILED'
      ? { href: '/connections', key: 'tasks.guidance.openConnections' as const }
      : error.code === 'BUDGET_EXCEEDED' ||
          error.code === 'POLICY_DENIED' ||
          error.code === 'MODEL_NOT_CONFIGURED' ||
          error.code === 'PLANNER_UNSUPPORTED'
        ? { href: '/settings', key: 'tasks.guidance.openSettings' as const }
        : null;
  return { key, link };
}

/** Steps finished (succeeded or skipped). */
export function completedSteps(steps: readonly Pick<TaskStep, 'status'>[]): number {
  return steps.filter((s) => s.status === 'SUCCEEDED' || s.status === 'SKIPPED').length;
}

/** Duration in ms between two timestamps, or null. */
export function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/* ------------------------------------------------------------------ previews */

const REF_ONLY = /^\{\{\s*([A-Za-z][\w-]{0,31}\.[A-Za-z]\w{0,63})\s*\}\}$/;

export type PreviewValue =
  | { type: 'text'; text: string; url: string | null }
  | { type: 'list'; items: string[] }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number }
  | { type: 'reference'; ref: string }
  | { type: 'json'; text: string };

/** One display-safe preview value (the API already redacted secrets). */
export function previewValue(value: unknown): PreviewValue {
  if (typeof value === 'string') {
    const ref = REF_ONLY.exec(value.trim());
    if (ref?.[1]) return { type: 'reference', ref: ref[1] };
    return { type: 'text', text: value, url: safeExternalUrl(value.trim()) };
  }
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return { type: 'number', value };
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number'))
    return { type: 'list', items: value.map(String) };
  return { type: 'json', text: JSON.stringify(value) };
}

export function previewEntries(record: Record<string, unknown> | null): [string, PreviewValue][] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, previewValue(v)]);
}

/** A pending approval of the task, if any. */
export function pendingApproval(detail: Pick<TaskDetail, 'approvals' | 'pendingApprovalId'>) {
  return (
    detail.approvals.find((a) => a.status === 'PENDING' && a.id === detail.pendingApprovalId) ??
    detail.approvals.find((a) => a.status === 'PENDING') ??
    null
  );
}
