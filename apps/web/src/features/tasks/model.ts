/**
 * Pure helpers for the Task Center and task detail: filter <-> URL mapping, evidence parsing,
 * localized event descriptions, attempt / cancellation state and step-preview formatting.
 * No React, no I/O — unit-tested in model.test.ts.
 */
import type {
  Approval,
  ErrorCode,
  Evidence,
  EvidenceCode,
  MemoryKind,
  MissingInfo,
  StepStatus,
  TaskDetail,
  TaskErrorReason,
  TaskEvent,
  TaskListQuery,
  TaskStatus,
  TaskStep,
} from '@jarvis/contracts';
import {
  ErrorCode as ErrorCodeEnum,
  isTerminal,
  MemoryKind as MemoryKindEnum,
  MissingInfo as MissingInfoEnum,
  TaskErrorReason as TaskErrorReasonEnum,
  TaskStatus as TaskStatusEnum,
} from '@jarvis/contracts';
import type { MessageKey } from '@/i18n/catalog';
import type { MessageParams } from '@/i18n/types';

/* ------------------------------------------------------------------ filters */

export type TaskFilter = TaskListQuery['status'];

/**
 * Display order of the Task Center filter. The default (All) comes first, so on a phone the
 * selected option sits at the start of the scrolling row and any overflow is at the end.
 */
export const TASK_FILTERS: readonly TaskFilter[] = [
  'all',
  'needs_approval',
  'active',
  'completed',
  'failed',
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

export { TOOL_LABEL } from '@/i18n/server-message';

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
  /** The offline summarizer's note: how many sentences it quoted from how much text. */
  | {
      kind: 'extractive';
      sentences: number;
      chars: number;
      /** Sentences left out because they addressed AI assistants (null: not recorded). */
      excluded: number | null;
    }
  | { kind: 'memory_record'; memoryId: string; memoryKind: MemoryKind | null }
  /** The model's answer hit the length limit. */
  | { kind: 'truncated' }
  /** document.analyze read an attached file. */
  | {
      kind: 'document';
      attachmentId: string | null;
      pages: number | null;
      chars: number | null;
      truncated: boolean;
    }
  /** schedule.create stored a schedule. */
  | { kind: 'schedule'; scheduleId: string; nextRunAt: string | null }
  /** conversation.recall reused an earlier task's result. */
  | { kind: 'recalled'; taskId: string }
  /** assistant.clarify asked for missing information. */
  | { kind: 'question'; missing: MissingInfo[] }
  /** Phase C: a provider call, a browser capture or a record (rendered from its code + params). */
  | { kind: 'phaseC'; code: PhaseCEvidenceCode; params: Record<string, string | number> }
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

type EvidenceParams = NonNullable<Evidence['params']>;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

/** "sha256" / "SHA-256" → "SHA-256". */
function algorithmName(raw: string): string {
  const sha = /^sha-?(\d+)$/i.exec(raw);
  return sha ? `SHA-${sha[1]}` : raw.toUpperCase();
}

/**
 * Evidence recorded with a code: its facts come as params (contracts EvidenceCode), so nothing
 * is parsed out of the English label / value. Null when a required fact is missing.
 */
function evidenceFromCode(code: EvidenceCode, p: EvidenceParams): EvidenceView | null {
  switch (code) {
    case 'HTTP_RESPONSE':
      return {
        kind: 'http_response',
        status: num(p.status),
        url: safeExternalUrl(text(p.url)),
        contentType: text(p.contentType),
        bytes: num(p.bytes),
      };
    case 'CONTENT_HASH': {
      const hex = text(p.hash);
      if (!hex) return null;
      const algorithm = algorithmName(text(p.algorithm) ?? 'sha256');
      return {
        kind: 'content_hash',
        algorithm,
        hex,
        value: `${algorithm.toLowerCase().replace('-', '')}:${hex}`,
      };
    }
    case 'SMTP_RECEIPT': {
      const replyCode = text(p.replyCode);
      let response = text(p.response) ?? '';
      if (replyCode && response.startsWith(replyCode))
        response = response.slice(replyCode.length).trim();
      return {
        kind: 'smtp_receipt',
        code: replyCode,
        accepted: num(p.accepted),
        messageId: text(p.messageId),
        response,
      };
    }
    case 'MODEL_OUTPUT': {
      const model = text(p.model);
      if (!model) return null;
      return {
        kind: 'model_output',
        model,
        inputTokens: num(p.inputTokens),
        outputTokens: num(p.outputTokens),
      };
    }
    case 'EXTRACTIVE_SUMMARY': {
      const sentences = num(p.sentences);
      const chars = num(p.chars);
      if (sentences === null || chars === null) return null;
      return { kind: 'extractive', sentences, chars, excluded: num(p.excludedSentences) };
    }
    case 'MEMORY_RECORD': {
      const memoryId = text(p.memoryId);
      if (!memoryId) return null;
      const kind = MemoryKindEnum.safeParse(p.kind);
      return { kind: 'memory_record', memoryId, memoryKind: kind.success ? kind.data : null };
    }
    case 'ANSWER_TRUNCATED':
      return { kind: 'truncated' };
    case 'DOCUMENT_EXTRACTED':
      return {
        kind: 'document',
        attachmentId: text(p.attachmentId),
        pages: num(p.pages),
        chars: num(p.chars),
        truncated: num(p.truncated) === 1,
      };
    case 'SCHEDULE_RECORD': {
      const scheduleId = text(p.scheduleId);
      if (!scheduleId) return null;
      return { kind: 'schedule', scheduleId, nextRunAt: text(p.nextRunAt) };
    }
    case 'RECALLED_RESULT': {
      const taskId = text(p.taskId);
      return taskId ? { kind: 'recalled', taskId } : null;
    }
    case 'QUESTION_ASKED':
      return { kind: 'question', missing: parseMissing(p.missing) };
    default:
      return (PHASE_C_EVIDENCE as readonly string[]).includes(code)
        ? { kind: 'phaseC', code: code as PhaseCEvidenceCode, params: p }
        : null;
  }
}

/** Evidence codes of the Phase C tools (contracts EvidenceCode doc: params per code). */
export const PHASE_C_EVIDENCE = [
  'PROVIDER_RESPONSE',
  'MAIL_SEARCH',
  'MAIL_SENT',
  'MAIL_DRAFT',
  'EMAIL_WATCH',
  'CALENDAR_EVENT',
  'FREE_BUSY',
  'SCREENSHOT',
  'PAGE_EXTRACT',
  'ICS_FILE',
  'BOOKING_CONFIRMATION',
  'ORDER_CONFIRMATION',
  'CART_SNAPSHOT',
  'HANDOVER',
] as const satisfies readonly EvidenceCode[];
export type PhaseCEvidenceCode = (typeof PHASE_C_EVIDENCE)[number];

/** "email_content,recipient" (QUESTION_ASKED) → the known MissingInfo values, in order. */
export function parseMissing(raw: unknown): MissingInfo[] {
  const parts = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
  return parts
    .map((part) => MissingInfoEnum.safeParse(typeof part === 'string' ? part.trim() : part))
    .flatMap((r) => (r.success ? [r.data] : []));
}

/**
 * Evidence as a structured view: from its code and params when it has them (current API),
 * otherwise parsed from the evidence strings (evidence recorded before codes existed). The formats are produced by the tools
 * (web.fetch: "GET <url> → 200 (text/html, 48213 bytes)"; email.send: "<reply> · Message-ID <id>";
 * content hashes "sha256:<hex>"); anything unexpected degrades to the raw label and value.
 */
export function parseEvidence(e: Evidence): EvidenceView {
  if (e.code) {
    const view = evidenceFromCode(e.code, e.params ?? {});
    if (view) return view;
  }
  switch (e.kind) {
    case 'smtp_receipt': {
      const code = /\b([2-5]\d\d)\b/.exec(e.label)?.[1] ?? /^\s*([2-5]\d\d)\b/.exec(e.value)?.[1];
      const accepted = /(\d+)\s+accepted/i.exec(e.label)?.[1];
      const id = /Message-ID\s*:?\s*(\S+)/i.exec(e.value)?.[1] ?? null;
      let response = e.value.replace(/\s*·?\s*Message-ID\s*:?\s*\S+\s*$/i, '').trim();
      // "250 Message queued" next to "SMTP 250": the code is shown once.
      if (code && response.startsWith(code)) response = response.slice(code.length).trim();
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
      return {
        kind: 'content_hash',
        algorithm: algorithmName(algo),
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
    case 'note': {
      const extractive =
        /extractive/i.test(e.label) &&
        /^(\d+)\s+key sentences?\s+from\s+(\d+)\s+characters/i.exec(e.value.trim());
      if (extractive)
        return {
          kind: 'extractive',
          sentences: Number(extractive[1]),
          chars: Number(extractive[2]),
          excluded: null,
        };
      return { kind: e.kind, label: e.label, value: e.value };
    }
    case 'record':
      return { kind: e.kind, label: e.label, value: e.value };
    // Phase C evidence without a dedicated view yet: shown as recorded (label and value).
    case 'provider_response':
    case 'browser_capture':
      return { kind: 'record', label: e.label, value: e.value };
  }
}

/** "5d2f8c1a…0e4b8d2f": enough to compare by eye; the full value stays copyable. */
export function shortHash(hex: string, head = 8, tail = 8): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/* ------------------------------------------------------------------ events */

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export interface EventDescription {
  key: MessageKey;
  params?: Record<string, string | number>;
  /** Extra lines from the event that have no code (server-written text without a message). */
  details?: string[];
  /** A step failure: its code / reason / params are localized; the English message is not shown. */
  error?: EventError;
  /** verification.failed: the steps whose results didn't pass. */
  failedStepIds?: string[];
  /** Verification results, localized where the check is known. */
  checks?: CheckLine[];
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}

/**
 * One verification result. `key` + `params` localize it (tasks.checks.*); `text` is the stored
 * line to fall back on. `step` is the title of the step it belongs to, when the line names one.
 */
export interface CheckLine {
  /** The step the check belongs to (structured checks), to name it in the viewer's locale. */
  stepId: string | null;
  step: string | null;
  key: string | null;
  params: MessageParams;
  text: string;
}

type CheckPattern = [RegExp, MessageKey, (m: RegExpExecArray) => MessageParams];

/** The verification lines the tools write today (apps/api/src/modules/agent/tools/*). */
const CHECK_PATTERNS: readonly CheckPattern[] = [
  [/HTTP (\d{3}) from (\S+)/, 'tasks.checks.http', (m) => ({ status: m[1], url: m[2] })],
  [
    /(\d+) characters of readable text extracted/,
    'tasks.checks.textExtracted',
    (m) => ({ count: Number(m[1]) }),
  ],
  [/Content hash recorded/, 'tasks.checks.hashRecorded', () => ({})],
  [/Content hash missing/, 'tasks.checks.hashMissing', () => ({})],
  [
    /Page flagged as containing instructions aimed at AI assistants \(ignored\)/,
    'tasks.checks.injectionFlagged',
    () => ({}),
  ],
  [/Summary of (\d+) characters/, 'tasks.checks.summaryLength', (m) => ({ count: Number(m[1]) })],
  [/Extractive summary \(no AI model used\)/, 'tasks.checks.extractive', () => ({})],
  [/Written by (.+)/, 'tasks.checks.writtenBy', (m) => ({ model: m[1] })],
  [
    /(\d+)\/(\d+) recipients accepted/,
    'tasks.checks.recipientsAccepted',
    (m) => ({ accepted: Number(m[1]), count: Number(m[2]) }),
  ],
  [/No recipients rejected/, 'tasks.checks.noneRejected', () => ({})],
  [/Rejected: (.+)/, 'tasks.checks.rejected', (m) => ({ list: m[1] })],
  [/Server response: (.+)/, 'tasks.checks.serverResponse', (m) => ({ response: m[1] })],
  [/Message-ID (.+)/, 'tasks.checks.messageId', (m) => ({ id: m[1] })],
  [/Answer of (\d+) characters/, 'tasks.checks.answerLength', (m) => ({ count: Number(m[1]) })],
  [/Memory \S+ stored/, 'tasks.checks.memoryStored', () => ({})],
  [/Memory record missing/, 'tasks.checks.memoryMissing', () => ({})],
];

const ANCHORED = CHECK_PATTERNS.map(
  ([re, key, params]) => [new RegExp(`^(?:(.+?): )?${re.source}$`), key, params] as const,
);

/**
 * A verification line as data: "<step title>: <check>" from the server, or a structured
 * `{ key, params, step }` (once the API sends codes). Unknown lines keep their text.
 */
export function parseCheck(raw: unknown): CheckLine | null {
  if (raw && typeof raw === 'object') {
    const o = raw as { key?: unknown; params?: unknown; step?: unknown; text?: unknown };
    if (typeof o.key !== 'string') return null;
    const stepId = (o as { stepId?: unknown }).stepId;
    return {
      stepId: typeof stepId === 'string' ? stepId : null,
      step: str(o.step),
      key: `tasks.checks.${o.key}`,
      params: (o.params && typeof o.params === 'object' ? o.params : {}) as MessageParams,
      text: str(o.text) ?? '',
    };
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  for (const [re, key, params] of ANCHORED) {
    const m = re.exec(text);
    if (m) {
      // Group 1 is the step title; the pattern's own groups follow it.
      const own = [m[0], ...m.slice(2)] as unknown as RegExpExecArray;
      return { stepId: null, step: m[1] ?? null, key, params: params(own), text };
    }
  }
  return { stepId: null, step: null, key: null, params: {}, text };
}

const checkLines = (v: unknown): CheckLine[] =>
  Array.isArray(v) ? v.map(parseCheck).filter((c): c is CheckLine => c !== null) : [];

export interface EventError {
  code: ErrorCode;
  reason?: TaskErrorReason;
  params?: Record<string, string | number>;
}

function errorCodeParam(v: unknown): ErrorCode | null {
  const parsed = ErrorCodeEnum.safeParse(v);
  return parsed.success ? parsed.data : null;
}

function errorParams(v: unknown): Record<string, string | number> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (typeof x === 'string' || typeof x === 'number') out[k] = x;
  return out;
}

function statusParam(v: unknown): TaskStatus | null {
  const parsed = TaskStatusEnum.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/**
 * The localized description of a timeline event (shapes documented in
 * apps/api/src/modules/events/events.ts). `statusLabel` localizes a task status; `message`
 * renders a server sentence (the step's titleMessage, the approval's summaryMessage) in the
 * viewer's locale, or returns null to fall back to the stored text.
 */
export function describeEvent(
  event: Pick<TaskEvent, 'type' | 'data'>,
  statusLabel: (status: TaskStatus) => string,
  unknownStep: string,
  message: (m: unknown) => string | null = () => null,
): EventDescription {
  const d = event.data;
  const title = message(d.titleMessage) ?? str(d.title) ?? unknownStep;
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
      // A known code (and reason) is localized; the server's English message is not shown.
      const code = errorCodeParam(d.code);
      const reason = TaskErrorReasonEnum.safeParse(d.reason);
      return {
        key: 'tasks.events.stepFailed',
        params: { title },
        ...(code
          ? {
              error: {
                code,
                ...(reason.success ? { reason: reason.data } : {}),
                ...(errorParams(d.params) ? { params: errorParams(d.params) } : {}),
              },
            }
          : {}),
        tone: 'danger',
      };
    }
    case 'step.blocked':
      return { key: 'tasks.events.stepBlocked', params: { title }, tone: 'danger' };
    case 'approval.requested': {
      const summary = message(d.summaryMessage) ?? str(d.summary);
      return {
        key: 'tasks.events.approvalRequested',
        details: summary ? [summary] : undefined,
        tone: 'warning',
      };
    }
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
        checks: checkLines(d.checks),
        tone: 'success',
      };
    case 'verification.failed': {
      // `message` is an English developer line; the failed steps are named from stepIds.
      const ids = Array.isArray(d.stepIds)
        ? d.stepIds.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        key: 'tasks.events.verificationFailed',
        ...(ids.length > 0 ? { failedStepIds: ids } : {}),
        checks: checkLines(d.checks),
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

/* ------------------------------------------------------------------ timeline */

export interface TimelineRow {
  event: TaskEvent;
  /** On a step's end row: how long the step ran (its start row is merged into it). */
  durationMs: number | null;
}

const STEP_END: readonly TaskEvent['type'][] = ['step.succeeded', 'step.failed', 'step.blocked'];

/** A status row that only restates the event next to it ("Status: Running" before a step). */
function restatesNeighbour(
  to: TaskStatus | null,
  prev: TaskEvent | undefined,
  next: TaskEvent | undefined,
): boolean {
  const after = (...types: TaskEvent['type'][]) => prev !== undefined && types.includes(prev.type);
  const before = (...types: TaskEvent['type'][]) => next !== undefined && types.includes(next.type);
  switch (to) {
    case 'QUEUED':
      return after('task.created', 'task.retried');
    case 'PLANNING':
      return after('task.created', 'task.retried') || before('plan.ready');
    case 'RUNNING':
      return after('plan.ready', 'approval.decided', 'task.retried') || before('step.started');
    case 'AWAITING_APPROVAL':
      return after('approval.requested') || before('approval.requested');
    case 'VERIFYING':
      return before('verification.passed', 'verification.failed');
    default:
      // Outcomes (completed, failed, cancelled, expired) always stay.
      return false;
  }
}

/**
 * The rows the History shows: answer deltas dropped, each step's start merged into its end row
 * (with the duration), and status rows that restate a neighbouring event left out.
 */
export function timelineRows(events: readonly TaskEvent[]): TimelineRow[] {
  const visible = events.filter((e) => e.type !== 'task.answer.delta');
  const merged = new Set<number>();
  const duration = new Map<number, number>();
  visible.forEach((e, i) => {
    if (e.type !== 'step.started' || typeof e.data.stepId !== 'string') return;
    const stepId = e.data.stepId;
    for (let j = i + 1; j < visible.length; j++) {
      const later = visible[j]!;
      if (later.data.stepId !== stepId) continue;
      if (later.type === 'step.started') return;
      if (STEP_END.includes(later.type)) {
        merged.add(i);
        const ms = durationMs(e.at, later.at);
        if (ms !== null) duration.set(j, ms);
        return;
      }
    }
  });
  return visible.flatMap((event, i) => {
    if (merged.has(i)) return [];
    if (
      event.type === 'task.status_changed' &&
      restatesNeighbour(statusParam(event.data.to), visible[i - 1], visible[i + 1])
    )
      return [];
    return [{ event, durationMs: duration.get(i) ?? null }];
  });
}

/**
 * The one-line History summary, e.g. "Asked · Approved · Sent": what the person did and the
 * outcome, in order (keys under tasks.history.milestones).
 */
export function historyMilestones(
  events: readonly Pick<TaskEvent, 'type' | 'data'>[],
  status: TaskStatus,
): MessageKey[] {
  const out: MessageKey[] = [];
  const push = (key: MessageKey) => {
    if (!out.includes(key)) out.push(key);
  };
  for (const e of events) {
    if (e.type === 'task.created') push('tasks.history.milestones.asked');
    else if (e.type === 'approval.decided') {
      if (e.data.decision === 'approved') push('tasks.history.milestones.approved');
      else if (e.data.decision === 'rejected') push('tasks.history.milestones.declined');
      else if (e.data.decision === 'expired') push('tasks.history.milestones.approvalExpired');
    } else if (e.type === 'step.succeeded' && e.data.toolId === 'email.send')
      push('tasks.history.milestones.sent');
    else if (e.type === 'step.succeeded' && e.data.toolId === 'memory.save')
      push('tasks.history.milestones.saved');
    else if (e.type === 'task.retried') push('tasks.history.milestones.retried');
  }
  switch (status) {
    case 'COMPLETED':
      if (
        !out.includes('tasks.history.milestones.sent') &&
        !out.includes('tasks.history.milestones.saved')
      )
        push('tasks.history.milestones.done');
      break;
    case 'FAILED':
      push('tasks.history.milestones.failed');
      break;
    case 'CANCELLED':
      push('tasks.history.milestones.cancelled');
      break;
    case 'EXPIRED':
      push('tasks.history.milestones.approvalExpired');
      break;
    case 'AWAITING_APPROVAL':
      push('tasks.history.milestones.waiting');
      break;
    default:
      push('tasks.history.milestones.inProgress');
  }
  return out;
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

/** Errors a plain retry can't fix: the request (or the setup) has to change first. */
const ASK_AGAIN: readonly ErrorCode[] = [
  'FETCH_BLOCKED',
  'PLANNER_UNSUPPORTED',
  'MODEL_NOT_CONFIGURED',
];

export type NextAction = 'askAgain' | 'retry' | null;

/**
 * The header action of a finished task: "Ask again" (the request goes back into the composer)
 * when retrying would fail the same way, otherwise Retry when the server allows it.
 */
export function nextAction(detail: Pick<TaskDetail, 'status' | 'error' | 'canRetry'>): NextAction {
  if (detail.status === 'FAILED' && detail.error && ASK_AGAIN.includes(detail.error.code))
    return 'askAgain';
  return detail.canRetry ? 'retry' : null;
}

/** The offline planner can't do this: a capability limit, not a crash. */
export function needsModel(error: { code: ErrorCode } | null | undefined): boolean {
  return error?.code === 'PLANNER_UNSUPPORTED' || error?.code === 'MODEL_NOT_CONFIGURED';
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

/**
 * Steps done: succeeded only. A failed task ends with its remaining steps SKIPPED, which were
 * never run (the API's progress.completed counts the same way).
 */
export function completedSteps(steps: readonly Pick<TaskStep, 'status'>[]): number {
  return steps.filter((s) => s.status === 'SUCCEEDED').length;
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

/* ------------------------------------------------------------------ detail view */

const comparable = (s: string) =>
  s
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();

/** The quoted request adds nothing when it says exactly what the title says. */
export function restatesTitle(request: string, title: string): boolean {
  return comparable(request) === comparable(title);
}

/** A step as the plan shows it: steps that will never run (the task ended) read "Not run". */
export type StepDisplayStatus = StepStatus | 'NOT_RUN';

export function stepDisplayStatus(
  step: Pick<TaskStep, 'status'>,
  taskStatus: TaskStatus,
): StepDisplayStatus {
  if (step.status === 'SKIPPED' || step.status === 'CANCELLED') return 'NOT_RUN';
  if ((step.status === 'PENDING' || step.status === 'AWAITING_APPROVAL') && isTerminal(taskStatus))
    return 'NOT_RUN';
  return step.status;
}

/** The step is still ahead of its policy decision (so "why JARVIS asks first" is current). */
export function isStepAhead(step: Pick<TaskStep, 'status'>, taskStatus: TaskStatus): boolean {
  return (
    (step.status === 'PENDING' || step.status === 'AWAITING_APPROVAL') && !isTerminal(taskStatus)
  );
}

/** The latest decision on a step's approval (approved, declined or expired), if any. */
export function stepDecision(
  approvals: readonly Approval[],
  stepId: string,
): (Approval & { status: 'APPROVED' | 'REJECTED' | 'EXPIRED'; decidedAt: string }) | null {
  let latest: Approval | null = null;
  for (const a of approvals) {
    if (a.stepId !== stepId || !a.decidedAt) continue;
    if (a.status !== 'APPROVED' && a.status !== 'REJECTED' && a.status !== 'EXPIRED') continue;
    if (!latest || a.decidedAt > (latest.decidedAt ?? '')) latest = a;
  }
  return latest as ReturnType<typeof stepDecision>;
}

/** What JARVIS wrote: the last successful summarize step's summary. */
export function writtenSummary(
  steps: readonly Pick<TaskStep, 'toolId' | 'status' | 'output'>[],
): string | null {
  const step = [...steps]
    .reverse()
    .find((s) => s.toolId === 'text.summarize' && s.status === 'SUCCEEDED');
  return str(step?.output?.summary)?.trim() ?? null;
}

export type WrittenKind = 'summary' | 'answer' | 'translation';

/**
 * The text JARVIS wrote as the task's deliverable: the last successful summary (of a page or a
 * document), answer about a document, or translation. Step outputs are previews (cut at about
 * 1,200 characters); the conversation's JARVIS message has the whole text.
 */
export function writtenResult(
  steps: readonly Pick<TaskStep, 'toolId' | 'status' | 'output' | 'inputPreview'>[],
): { text: string; kind: WrittenKind } | null {
  const step = [...steps]
    .reverse()
    .find(
      (s) =>
        s.status === 'SUCCEEDED' &&
        (s.toolId === 'text.summarize' ||
          s.toolId === 'document.analyze' ||
          s.toolId === 'text.translate'),
    );
  if (!step) return null;
  const out = step.output ?? {};
  const text =
    step.toolId === 'text.summarize'
      ? str(out.summary)
      : step.toolId === 'text.translate'
        ? str(out.translation)
        : str(out.result);
  if (!text?.trim()) return null;
  const kind: WrittenKind =
    step.toolId === 'text.translate'
      ? 'translation'
      : step.toolId === 'document.analyze' && step.inputPreview?.mode === 'answer'
        ? 'answer'
        : 'summary';
  return { text: text.trim(), kind };
}

/** What JARVIS saved to memory: the successful memory step's content. */
export function savedMemory(steps: readonly Pick<TaskStep, 'toolId' | 'status' | 'output'>[]) {
  const step = [...steps]
    .reverse()
    .find((s) => s.toolId === 'memory.save' && s.status === 'SUCCEEDED');
  return str(step?.output?.content)?.trim() ?? null;
}

/** Where (and when) the result was emailed: the successful email step's accepted recipients. */
export function emailDelivery(
  detail: Pick<TaskDetail, 'steps' | 'approvals'>,
): { to: string[]; at: string | null } | null {
  const step = [...detail.steps]
    .reverse()
    .find((s) => s.toolId === 'email.send' && s.status === 'SUCCEEDED');
  if (!step) return null;
  const listed = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  const approval = detail.approvals.find((a) => a.stepId === step.id);
  const to = listed(step.output?.accepted);
  const fallback =
    approval?.details.kind === 'email' ? approval.details.to : listed(step.inputPreview.to);
  return { to: to.length > 0 ? to : [...fallback], at: step.completedAt };
}
