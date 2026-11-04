import { z } from 'zod';
import {
  ApprovalStatus,
  AttachmentMediaType,
  ConnectionProvider,
  ConnectionStatus,
  ErrorCode,
  Locale,
  MemoryKind,
  MessageKind,
  MissingInfo,
  NotificationKind,
  Platform,
  RiskLevel,
  Role,
  ScheduleFrequency,
  SchedulePauseReason,
  ScheduleRunReason,
  ScheduleRunStatus,
  ScheduleStatus,
  SkillId,
  SkillStatus,
  SkillUnavailableReason,
  StepStatus,
  TaskOutcome,
  TaskSource,
  TaskStatus,
  ThemePreference,
  ToolId,
  WebhookDeliveryEventType,
  WebhookDeliveryStatus,
  WebhookDisabledReason,
  WebhookEndpointStatus,
  WebhookEventType,
  WebhookFailureReason,
  Weekday,
} from './enums';
import {
  ATTACHMENT_LIMITS,
  MEMORY_RETENTION_DAYS,
  SCHEDULE_LIMITS,
  TASK_HISTORY_RETENTION_DAYS,
} from './limits';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const Id = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
/** Money is transported as integer micro-dollars to avoid float drift. */
export const MicroUsd = z.number().int().nonnegative();

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

/**
 * Automatic deletion (Phase B). null = keep until the user deletes it. A daily
 * sweep deletes memories not updated for `memoryDays`, and finished tasks
 * (with their steps, approvals, events, messages and attachments) older than
 * `taskHistoryDays`.
 */
export const RetentionPreferences = z.object({
  memoryDays: z.literal(MEMORY_RETENTION_DAYS).nullable(),
  taskHistoryDays: z.literal(TASK_HISTORY_RETENTION_DAYS).nullable(),
});
export type RetentionPreferences = z.infer<typeof RetentionPreferences>;

/**
 * Skills the user switched off (Phase B). Written only through
 * PATCH /v1/skills/:id; the Policy Engine denies the tools of a disabled skill
 * (SKILL_DISABLED). personal-memory is not listed here: it mirrors
 * `memory.enabled`.
 */
export const SkillPreferences = z.object({
  disabled: z.array(SkillId).max(SkillId.options.length),
});
export type SkillPreferences = z.infer<typeof SkillPreferences>;

export const Preferences = z.object({
  voice: z.object({
    /** Read final results aloud after a voice request. */
    speakResponses: z.boolean(),
    /** 'auto' follows the interface language. */
    recognitionLocale: z.enum(['auto', 'en-US', 'de-DE', 'ar-SA']),
  }),
  autonomy: z.object({
    /** MEDIUM-risk emails addressed only to the account's own address run without asking. */
    autoApproveEmailToSelf: z.boolean(),
  }),
  ai: z.object({
    /** When false, requests are never sent to external model providers. */
    allowExternalModels: z.boolean(),
  }),
  notifications: z.object({
    approvalRequested: z.boolean(),
    taskCompleted: z.boolean(),
    taskFailed: z.boolean(),
  }),
  spending: z.object({
    /** Monthly ceiling for AI model costs, in USD. 0 blocks paid model usage. */
    monthlyAiBudgetUsd: z.number().min(0).max(10_000),
  }),
  memory: z.object({
    /** When false, JARVIS neither reads nor writes long-term memory. */
    enabled: z.boolean(),
  }),
  // Phase B groups default when absent (stored preferences and older fixtures).
  retention: RetentionPreferences.default({ memoryDays: null, taskHistoryDays: null }),
  skills: SkillPreferences.default({ disabled: [] }),
});
export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = {
  voice: { speakResponses: false, recognitionLocale: 'auto' },
  autonomy: { autoApproveEmailToSelf: false },
  ai: { allowExternalModels: true },
  notifications: { approvalRequested: true, taskCompleted: true, taskFailed: true },
  spending: { monthlyAiBudgetUsd: 20 },
  memory: { enabled: true },
  retention: { memoryDays: null, taskHistoryDays: null },
  skills: { disabled: [] },
};

export const Me = z.object({
  id: Id,
  email: z.email(),
  displayName: z.string(),
  locale: Locale,
  timeZone: z.string(),
  theme: ThemePreference,
  roles: z.array(Role),
  tenant: z.object({ id: Id, name: z.string() }),
  preferences: Preferences,
  createdAt: Timestamp,
});
export type Me = z.infer<typeof Me>;

export const UpdateMeRequest = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    locale: Locale,
    timeZone: z.string().min(1).max(64),
    theme: ThemePreference,
    preferences: z
      .object({
        voice: Preferences.shape.voice.partial(),
        autonomy: Preferences.shape.autonomy.partial(),
        ai: Preferences.shape.ai.partial(),
        notifications: Preferences.shape.notifications.partial(),
        spending: Preferences.shape.spending.partial(),
        memory: Preferences.shape.memory.partial(),
        retention: RetentionPreferences.partial(),
        // `skills` is written through PATCH /v1/skills/:id only.
      })
      .partial(),
  })
  .partial();
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

export const LoginRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  deviceName: z.string().trim().max(80).optional(),
  platform: Platform.default('web'),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  user: Me,
  session: z.object({ id: Id, expiresAt: Timestamp }),
  /** Only returned to native clients (platform !== 'web'); web uses an httpOnly cookie. */
  token: z.string().optional(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const SessionInfo = z.object({
  id: Id,
  deviceName: z.string().nullable(),
  platform: Platform,
  userAgent: z.string().nullable(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
  expiresAt: Timestamp,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const DeleteAccountRequest = z.object({
  password: z.string().min(1).max(256),
  confirmation: z.literal('DELETE'),
});

/* ------------------------------------------------------------------ */
/* Server-written sentences (localised by clients)                     */
/* ------------------------------------------------------------------ */

/**
 * Keys of the sentences the server composes (offline plan and step titles,
 * approval summaries, result lines). Clients render them in the viewer's
 * locale from `{ key, params }`; the server keeps en/de/ar templates of the
 * same keys (apps/api/src/modules/agent/i18n.ts) for its plain-text fallback.
 *
 * Parameters per key:
 *   plan.summarize, plan.summarizeEmail, step.fetch      { host }
 *   plan.remember, plan.emailSelf                         { text }   (the user's own words)
 *   objective.summarize                                   { url }
 *   objective.summarizeEmail                              { url, email }
 *   objective.emailSelf                                   { email }
 *   objective.remember, step.summarize, step.emailSummary, step.remember,
 *   step.emailNote, result.cancelled, result.expired      {}
 *   approval.email, result.emailSent                      { subject, recipients }
 *   approval.generic                                      { title, tool }
 *   approval.recipientsMany                               { count }
 *   result.memorySaved                                    { text }
 *   result.declined                                       { action }
 * Phase B:
 *   plan.emailResult, plan.rememberResult                 { title }  (the earlier task's title)
 *   plan.summarizeDocument, objective.summarizeDocument,
 *   step.summarizeDocument, result.documentSummarized     { name }   (the file name)
 *   plan.schedule, objective.schedule, approval.schedule,
 *   result.scheduleCreated                                { title }  (the schedule's title)
 *   objective.emailResult                                 { email }
 *   approval.memory                                       { text }
 *   plan.clarify, objective.clarify, objective.rememberResult, step.recall,
 *   step.emailResult, step.schedule, step.clarify, question.*   {}
 * A parameter is a string, a number or a nested message (e.g. `recipients`
 * is a nested approval.recipientsMany for more than two recipients, `title`
 * a nested step title, `action` the declined approval's summary).
 */
export const ServerMessageKey = z.enum([
  'plan.summarize',
  'plan.summarizeEmail',
  'plan.remember',
  'plan.emailSelf',
  'objective.summarize',
  'objective.summarizeEmail',
  'objective.remember',
  'objective.emailSelf',
  'step.fetch',
  'step.summarize',
  'step.emailSummary',
  'step.remember',
  'step.emailNote',
  'approval.email',
  'approval.generic',
  'approval.recipientsMany',
  'result.emailSent',
  'result.memorySaved',
  'result.declined',
  'result.cancelled',
  'result.expired',
  // Phase B: follow-ups, documents, schedules, clarifying questions
  'plan.emailResult',
  'plan.rememberResult',
  'plan.summarizeDocument',
  'plan.schedule',
  'plan.clarify',
  'objective.emailResult',
  'objective.rememberResult',
  'objective.summarizeDocument',
  'objective.schedule',
  'objective.clarify',
  'step.recall',
  'step.emailResult',
  'step.summarizeDocument',
  'step.schedule',
  'step.clarify',
  'approval.schedule',
  'approval.memory',
  'result.scheduleCreated',
  'result.documentSummarized',
  'question.emailContent',
  'question.recipient',
  'question.url',
  'question.document',
  'question.scheduleTime',
  'question.targetLanguage',
  'question.previousResult',
  'question.details',
]);
export type ServerMessageKey = z.infer<typeof ServerMessageKey>;

export type ServerMessageParam = string | number | ServerMessage;
export interface ServerMessage {
  key: ServerMessageKey;
  params: Record<string, ServerMessageParam>;
}
export const ServerMessage: z.ZodType<ServerMessage> = z.object({
  key: ServerMessageKey,
  get params() {
    return z.record(z.string(), z.union([z.string(), z.number(), ServerMessage]));
  },
});

/* ------------------------------------------------------------------ */
/* Phase B building blocks (attachments, recurrence, questions)        */
/* ------------------------------------------------------------------ */

/**
 * A file the user uploaded (POST /v1/attachments). Only its owner can read or
 * download it (RLS). Uploads are unattached until a request names them in
 * `attachmentIds`; then they belong to that request's conversation (follow-ups
 * in the same conversation may use them again) and are deleted with it, with
 * the task history retention, or by DELETE /v1/attachments/:id.
 */
export const Attachment = z.object({
  id: Id,
  /** As uploaded (sanitised: no path, no control characters). User content: display isolated. */
  filename: z.string(),
  /** Identified from the content, not the extension. */
  mediaType: AttachmentMediaType,
  sizeBytes: z.number().int().positive(),
  /** Hex SHA-256 of the stored bytes. */
  sha256: z.string(),
  /** Null until a request uses the file. */
  conversationId: Id.nullable(),
  /** Known once document.analyze has read it (PDF pages; 1 for other types). */
  pageCount: z.number().int().nonnegative().nullable(),
  /** Characters of extracted text, once read. */
  textChars: z.number().int().nonnegative().nullable(),
  /** API path that streams the file to its owner (same auth as every route). */
  downloadPath: z.string(),
  /** When an unattached upload is deleted; null once attached. */
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Attachment = z.infer<typeof Attachment>;

/** Local wall-clock time "HH:MM" (24 h). */
export const LocalTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (00:00–23:59)');

/**
 * When a schedule runs: an RFC 5545 RRULE subset the server turns into the
 * stored RRULE (Schedule.rrule) and evaluates in `timeZone` (DST-correct).
 *   daily   — every `interval` days at `time`
 *   weekly  — every `interval` weeks on `byWeekday` at `time`
 *   monthly — every `interval` months on `byMonthDay` (1–31, −1 = last day;
 *             a day a month lacks is skipped, as RFC 5545 specifies) at `time`
 * `until` (last local date, inclusive) and `count` (total runs) are optional
 * and exclusive. A local time that does not exist on a DST change day runs
 * at the first valid time after it; one that exists twice runs once.
 */
export const Recurrence = z
  .object({
    frequency: ScheduleFrequency,
    interval: z.number().int().min(1).max(12).default(1),
    byWeekday: z.array(Weekday).min(1).max(7).optional(),
    byMonthDay: z
      .array(
        z
          .number()
          .int()
          .min(-1)
          .max(31)
          .refine((d) => d !== 0, 'day 0 does not exist'),
      )
      .min(1)
      .max(31)
      .optional(),
    time: LocalTime,
    /** IANA zone the server accepts (GET /v1/meta/time-zones). */
    timeZone: z.string().min(1).max(64),
    until: z.iso.date().optional(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (r.frequency === 'weekly' && !r.byWeekday?.length)
      issue('byWeekday', 'weekly schedules need at least one weekday');
    if (r.frequency !== 'weekly' && r.byWeekday !== undefined)
      issue('byWeekday', 'only weekly schedules have weekdays');
    if (r.frequency === 'monthly' && !r.byMonthDay?.length)
      issue('byMonthDay', 'monthly schedules need at least one day of the month');
    if (r.frequency !== 'monthly' && r.byMonthDay !== undefined)
      issue('byMonthDay', 'only monthly schedules have days of the month');
    if (r.byWeekday && new Set(r.byWeekday).size !== r.byWeekday.length)
      issue('byWeekday', 'weekdays must be unique');
    if (r.byMonthDay && new Set(r.byMonthDay).size !== r.byMonthDay.length)
      issue('byMonthDay', 'days must be unique');
    if (r.until !== undefined && r.count !== undefined)
      issue('count', 'until and count cannot both be set');
  });
export type Recurrence = z.infer<typeof Recurrence>;

/**
 * A clarifying question (TaskSummary.question when outcome is 'question').
 * JARVIS asks instead of inventing missing information; the user answers with
 * a follow-up in the same conversation.
 */
export const AssistantQuestion = z.object({
  /** In the request's language (model-written, or the server sentence rendered). */
  text: z.string(),
  /** Set when the server composed the question (offline planner): render it in the viewer's locale. */
  message: ServerMessage.nullable(),
  /** What is missing; clients may offer a matching input (e.g. attach a file for 'document'). */
  missing: z.array(MissingInfo).min(1),
});
export type AssistantQuestion = z.infer<typeof AssistantQuestion>;

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Machine-readable detail of a TaskError (the `code` says what kind of
 * failure; the reason says which one). Clients localise `code` + `reason` +
 * `params`; `message` is an English developer fallback.
 */
export const TaskErrorReason = z.enum([
  // web.fetch / SSRF guard
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'EMBEDDED_CREDENTIALS',
  'MISSING_HOST',
  'PRIVATE_ADDRESS', // { host }
  'FETCH_TIMEOUT', // { host, seconds }
  'HOST_NOT_FOUND', // { host }
  'CONNECT_FAILED', // { host }
  'TLS_CERTIFICATE', // { host }
  'FETCH_FAILED', // { host }
  'UNSUPPORTED_ENCODING', // { encoding }
  'PAGE_TOO_LARGE', // { limitMb }
  'TOO_MANY_REDIRECTS', // { max }
  'HTTP_ERROR', // { host, status }
  'UNSUPPORTED_CONTENT_TYPE', // { contentType }
  'MISSING_CONTENT_TYPE',
  'NO_READABLE_TEXT',
  // email.send
  'EMAIL_NOT_CONNECTED',
  'SMTP_AUTH',
  'SMTP_REFUSED', // { responseCode }
  'SMTP_CONNECT',
  'SMTP_UNUSABLE',
  'SEND_INTERRUPTED',
  'SEND_TIMEOUT',
  // runtime
  'STEP_INTERRUPTED', // { step }
  'STEP_TIMEOUT', // { step }
  'STEP_CRASHED', // { step }
  'INVALID_STEP_INPUT', // { step }
  'UNKNOWN_TOOL', // { tool }
  'VERIFICATION_FAILED', // { steps }
  // planner
  'OFFLINE_UNSUPPORTED',
  'MEMORY_TOO_LONG', // { max }
  'INVALID_PLAN',
  'NO_TOOLS',
  'PLANNING_FAILED',
  // policy (same names as the policy reason codes)
  'CONNECTION_MISSING', // { step }
  'MEMORY_DISABLED',
  'RISK_CRITICAL',
  'BUDGET_ZERO',
  'BUDGET_EXHAUSTED',
  'EXTERNAL_MODELS_DISABLED',
  'MODEL_UNAVAILABLE',
  'POLICY_DENIED', // { step }
  // Phase B — document.analyze
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_UNREADABLE',
  'ATTACHMENT_ENCRYPTED',
  'DOCUMENT_NO_TEXT',
  'DOCUMENT_TOO_MANY_PAGES', // { max }
  'STORAGE_UNAVAILABLE',
  // text.translate
  'UNSUPPORTED_LANGUAGE', // { language }
  // conversation.recall
  'NOTHING_TO_RECALL',
  // schedule.create
  'SCHEDULE_LIMIT_REACHED', // { max }
  'INVALID_RECURRENCE',
  // policy (same names as the policy reason codes)
  'SKILL_DISABLED', // { skill }
  'UNTRUSTED_MEMORY',
]);
export type TaskErrorReason = z.infer<typeof TaskErrorReason>;

export const TaskError = z.object({
  code: ErrorCode,
  /** English developer fallback. Clients show copy for code / reason / params instead. */
  message: z.string(),
  /** Whether a retry is safe without risking a duplicate side effect. */
  retryable: z.boolean(),
  reason: TaskErrorReason.optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type TaskError = z.infer<typeof TaskError>;

/**
 * What a piece of evidence records, with its facts as parameters, so clients
 * can label it in the viewer's locale. `label` / `value` stay as the
 * protocol-level, English fallback.
 *   HTTP_RESPONSE      { method, url, status, contentType, bytes }
 *   CONTENT_HASH       { algorithm, hash }
 *   SMTP_RECEIPT       { replyCode, accepted, total, response, messageId }
 *   MODEL_OUTPUT       { model, inputTokens, outputTokens }
 *   EXTRACTIVE_SUMMARY { sentences, chars, excludedSentences }
 *   MEMORY_RECORD      { memoryId, kind }
 *   ANSWER_TRUNCATED   {}
 * Phase B:
 *   DOCUMENT_EXTRACTED { attachmentId, mediaType, pages, chars, truncated (0|1) }
 *   SCHEDULE_RECORD    { scheduleId, nextRunAt }
 *   RECALLED_RESULT    { taskId }
 *   QUESTION_ASKED     { missing }  (comma-separated MissingInfo values)
 */
export const EvidenceCode = z.enum([
  'HTTP_RESPONSE',
  'CONTENT_HASH',
  'SMTP_RECEIPT',
  'MODEL_OUTPUT',
  'EXTRACTIVE_SUMMARY',
  'MEMORY_RECORD',
  'ANSWER_TRUNCATED',
  'DOCUMENT_EXTRACTED',
  'SCHEDULE_RECORD',
  'RECALLED_RESULT',
  'QUESTION_ASKED',
]);
export type EvidenceCode = z.infer<typeof EvidenceCode>;

export const Evidence = z.object({
  kind: z.enum(['http_response', 'smtp_receipt', 'record', 'content_hash', 'model_output', 'note']),
  label: z.string(),
  value: z.string(),
  at: Timestamp,
  /** Absent on evidence recorded before codes existed. */
  code: EvidenceCode.optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * One verification result, as carried in `verification.passed` /
 * `verification.failed` event data (`checks`). Clients localise `key` +
 * `params`; `text` is the English fallback and `step` the step's title.
 *   http { status, url } · textExtracted { count } · hashRecorded · hashMissing
 *   injectionFlagged · summaryLength { count } · extractive · writtenBy { model }
 *   recipientsAccepted { accepted, count } · noneRejected · rejected { list }
 *   serverResponse { response } · messageId { id } · answerLength { count }
 *   memoryStored { id } · memoryMissing
 * Phase B: documentRead { pages, chars } · translationLength { count }
 *   translationLanguage { language } · numbersPreserved { count } · scheduleStored { id }
 *   nextRunComputed { at } · resultRecalled { taskId } · questionAsked
 */
export const VerificationCheckKey = z.enum([
  'http',
  'textExtracted',
  'hashRecorded',
  'hashMissing',
  'injectionFlagged',
  'summaryLength',
  'extractive',
  'writtenBy',
  'recipientsAccepted',
  'noneRejected',
  'rejected',
  'serverResponse',
  'messageId',
  'answerLength',
  'memoryStored',
  'memoryMissing',
  'documentRead',
  'translationLength',
  'translationLanguage',
  'numbersPreserved',
  'scheduleStored',
  'nextRunComputed',
  'resultRecalled',
  'questionAsked',
]);
export type VerificationCheckKey = z.infer<typeof VerificationCheckKey>;

export const VerificationCheck = z.object({
  stepId: Id,
  /** The step's title as stored (see TaskStep.titleMessage for its localisable form). */
  step: z.string(),
  key: VerificationCheckKey,
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  text: z.string(),
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const PolicyDecision = z.object({
  decision: z.enum(['allow', 'require_approval', 'deny']),
  /** Machine-readable reason codes, e.g. RISK_MEDIUM, RECIPIENT_EXTERNAL, CONNECTION_MISSING. */
  reasons: z.array(z.string()),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const TaskStep = z.object({
  id: Id,
  position: z.number().int().nonnegative(),
  title: z.string(),
  /** Set when the server wrote the title (offline planner): render it in the viewer's locale. */
  titleMessage: ServerMessage.nullable().optional(),
  toolId: ToolId,
  riskLevel: RiskLevel,
  status: StepStatus,
  requiresApproval: z.boolean(),
  policy: PolicyDecision,
  /** Redacted, display-safe view of the resolved input. */
  inputPreview: z.record(z.string(), z.unknown()),
  /** Redacted, display-safe output. */
  output: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(Evidence),
  attempts: z.number().int().nonnegative(),
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  error: TaskError.nullable(),
});
export type TaskStep = z.infer<typeof TaskStep>;

/**
 * Facts about content flagged as a suspected prompt injection that this
 * action consumes (attached when the policy adds UNTRUSTED_CONTENT). Never
 * contains the flagged text itself.
 */
export const UntrustedSource = z.object({
  /** Host of the page the content came from, when it came from web.fetch. */
  host: z.string().nullable(),
  /** Sentences left out of the extractive summary because they addressed AI assistants; null when not applicable. */
  excludedSentences: z.number().int().nonnegative().nullable(),
  /** Detector signal ids, e.g. ignore_previous_instructions, exfiltration_request. */
  signals: z.array(z.string()),
});
export type UntrustedSource = z.infer<typeof UntrustedSource>;

export const ApprovalDetails = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    from: z.string(),
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    untrusted: UntrustedSource.optional(),
  }),
  z.object({
    kind: z.literal('generic'),
    toolId: ToolId,
    fields: z.array(z.object({ label: z.string(), value: z.string() })),
    untrusted: UntrustedSource.optional(),
  }),
  /** schedule.create: future runs, each planned and checked by the policy when it happens. */
  z.object({
    kind: z.literal('schedule'),
    title: z.string(),
    /** The request each run will carry out, exactly as stored. */
    request: z.string(),
    recurrence: Recurrence,
    rrule: z.string(),
    /** The first runs (SCHEDULE_LIMITS.upcomingShown), as instants: format in recurrence.timeZone. */
    nextOccurrences: z.array(Timestamp),
    untrusted: UntrustedSource.optional(),
  }),
  /** memory.save of text that came from an earlier result (MEMORY_FROM_CONTENT): exactly what is kept. */
  z.object({
    kind: z.literal('memory'),
    content: z.string(),
    memoryKind: MemoryKind,
    /** The task whose result the text came from. */
    sourceTaskId: Id.nullable(),
    untrusted: UntrustedSource.optional(),
  }),
]);
export type ApprovalDetails = z.infer<typeof ApprovalDetails>;

export const Approval = z.object({
  id: Id,
  taskId: Id,
  taskTitle: z.string(),
  taskTitleMessage: ServerMessage.nullable().optional(),
  stepId: Id,
  toolId: ToolId,
  status: ApprovalStatus,
  riskLevel: RiskLevel,
  /** Exactly what will happen, in one sentence (request language; see summaryMessage). */
  summary: z.string(),
  /** `summary` as a message key + params, to render in the viewer's locale. */
  summaryMessage: ServerMessage.nullable().optional(),
  details: ApprovalDetails,
  /** Hash binding the approval to the exact action shown; required when deciding. */
  actionHash: z.string(),
  reasons: z.array(z.string()),
  expiresAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: Timestamp,
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalDecisionRequest = z.object({
  decision: z.enum(['approve', 'reject']),
  actionHash: z.string().min(16).max(128),
  note: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const PlannerInfo = z.object({
  /** 'model' = an external LLM planned the task; 'offline' = deterministic rules engine. */
  mode: z.enum(['model', 'offline']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
});
export type PlannerInfo = z.infer<typeof PlannerInfo>;

export const TaskSummary = z.object({
  id: Id,
  /** In the request's language (or the request itself until planned); see titleMessage. */
  title: z.string(),
  /** Set when the server wrote the title (offline planner): render it in the viewer's locale. */
  titleMessage: ServerMessage.nullable().optional(),
  request: z.string(),
  status: TaskStatus,
  riskLevel: RiskLevel,
  source: TaskSource,
  /** `completed` counts succeeded steps only. */
  progress: z.object({ completed: z.number().int(), total: z.number().int() }),
  pendingApprovalId: Id.nullable(),
  /** The pending approval, with whether it acts on content flagged as a prompt injection. */
  pendingApproval: z.object({ id: Id, untrustedSource: z.boolean() }).nullable().optional(),
  /** In the request's language; see resultSummaryMessage. */
  resultSummary: z.string().nullable(),
  /**
   * Set when the result line is a server sentence (not page or model text):
   * render it in the viewer's locale instead of `resultSummary`.
   */
  resultSummaryMessage: ServerMessage.nullable().optional(),
  error: TaskError.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  // Phase B. Always sent by this API; optional only for older servers and fixtures.
  conversationId: Id.optional(),
  /** What the completed task produced; null until COMPLETED. */
  outcome: TaskOutcome.nullable().optional(),
  /** Set when outcome is 'question' (also shown as resultSummary / resultSummaryMessage). */
  question: AssistantQuestion.nullable().optional(),
  /** The schedule that created this task (source 'schedule'). */
  scheduleId: Id.nullable().optional(),
  /** Files attached to the request. */
  attachmentCount: z.number().int().nonnegative().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskEventType = z.enum([
  'task.created',
  'task.status_changed',
  'plan.ready',
  'step.started',
  'step.succeeded',
  'step.failed',
  'step.blocked',
  'approval.requested',
  'approval.decided',
  'verification.passed',
  'verification.failed',
  'task.answer.delta',
  'task.cancel_requested',
  'task.retried',
]);
export type TaskEventType = z.infer<typeof TaskEventType>;

export const TaskEvent = z.object({
  /** Monotonic id; doubles as the SSE `id:` for resumable streams. */
  id: z.string(),
  taskId: Id,
  type: TaskEventType,
  at: Timestamp,
  data: z.record(z.string(), z.unknown()),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

export const TaskDetail = TaskSummary.extend({
  objective: z.string().nullable(),
  objectiveMessage: ServerMessage.nullable().optional(),
  conversationId: Id,
  planner: PlannerInfo.nullable(),
  answer: z.string().nullable(),
  steps: z.array(TaskStep),
  approvals: z.array(Approval),
  events: z.array(TaskEvent),
  cost: z.object({ estimatedMicroUsd: MicroUsd, actualMicroUsd: MicroUsd }),
  evidence: z.array(Evidence),
  canCancel: z.boolean(),
  canRetry: z.boolean(),
  startedAt: Timestamp.nullable(),
  /** Files attached to the request (Phase B; always sent by this API). */
  attachments: z.array(Attachment).optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const CreateTaskRequest = z.object({
  request: z.string().trim().min(1).max(4000),
  source: TaskSource.extract(['text', 'voice']).default('text'),
  /** BCP-47-ish language of the request, if known (voice recognition supplies it). */
  language: Locale.optional(),
  voiceSessionId: Id.optional(),
  /**
   * Uploaded files the request is about (Phase B): the caller's own uploads,
   * unattached and unexpired (a follow-up may also name files already in its
   * conversation). Unique, at most ATTACHMENT_LIMITS.maxPerRequest. Absent = none.
   */
  attachmentIds: z
    .array(Id)
    .max(ATTACHMENT_LIMITS.maxPerRequest)
    .refine((ids) => new Set(ids).size === ids.length, 'attachment ids must be unique')
    .optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const TaskListQuery = PageQuery.extend({
  status: z.enum(['active', 'needs_approval', 'completed', 'failed', 'all']).default('all'),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

export const RetryTaskRequest = z.object({
  /** Required when the previous attempt ended with OUTCOME_UNKNOWN. */
  acknowledgeUnknownOutcome: z.boolean().default(false),
});

/* ------------------------------------------------------------------ */
/* Realtime stream (SSE: GET /v1/events)                               */
/* ------------------------------------------------------------------ */

/**
 * Stream events that are not part of a task's timeline (task_events rows with
 * these types are never listed in TaskDetail.events). Phase B data shapes:
 *   conversation.message     { conversationId, messageId, taskId, role, kind }
 *   conversation.changed     { conversationId, change: 'title' | 'deleted' }
 *   schedule.changed         { scheduleId, change: 'created' | 'updated' | 'paused' | 'resumed'
 *                              | 'completed' | 'deleted' | 'run', status, nextRunAt }
 *   webhook.delivery_failed  { endpointId, deliveryId, eventType, reason, attempts, final }
 *   webhook.endpoint_changed { endpointId, status, disabledReason }
 */
export const AccountEventType = z.enum([
  'notification.created',
  'connection.changed',
  'heartbeat',
  'conversation.message',
  'conversation.changed',
  'schedule.changed',
  'webhook.delivery_failed',
  'webhook.endpoint_changed',
]);
export type AccountEventType = z.infer<typeof AccountEventType>;

export const StreamEvent = z.object({
  id: z.string(),
  type: z.union([TaskEventType, AccountEventType]),
  taskId: Id.nullable(),
  at: Timestamp,
  data: z.record(z.string(), z.unknown()),
});
export type StreamEvent = z.infer<typeof StreamEvent>;

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export const Connection = z.object({
  id: Id,
  provider: ConnectionProvider,
  label: z.string(),
  /** e.g. the sender address for SMTP; never a secret. */
  accountIdentifier: z.string().nullable(),
  status: ConnectionStatus,
  permissions: z.array(z.string()),
  lastVerifiedAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Connection = z.infer<typeof Connection>;

export const CreateSmtpConnectionRequest = z.object({
  label: z.string().trim().min(1).max(60).default('Email'),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** 'tls' = implicit TLS (465); 'starttls' = upgrade (587); 'none' only allowed for localhost in development. */
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().max(254).optional(),
  password: z.string().max(512).optional(),
  fromAddress: z.email(),
  fromName: z.string().trim().max(80).optional(),
});
export type CreateSmtpConnectionRequest = z.infer<typeof CreateSmtpConnectionRequest>;

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export const Memory = z.object({
  id: Id,
  kind: MemoryKind,
  content: z.string(),
  source: z.enum(['user', 'assistant']),
  sourceTaskId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Memory = z.infer<typeof Memory>;

export const CreateMemoryRequest = z.object({
  kind: MemoryKind.default('fact'),
  content: z.string().trim().min(1).max(1000),
});
export const UpdateMemoryRequest = z.object({
  kind: MemoryKind.optional(),
  content: z.string().trim().min(1).max(1000).optional(),
});
export const MemoryListQuery = PageQuery.extend({ q: z.string().trim().max(200).optional() });

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export const Notification = z.object({
  id: Id,
  kind: NotificationKind,
  taskId: Id.nullable(),
  /** Parameters for client-side localisation (e.g. taskTitle). */
  data: z.record(z.string(), z.string()),
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

/* ------------------------------------------------------------------ */
/* System status, home, usage                                          */
/* ------------------------------------------------------------------ */

export const AssistantStatus = z.object({
  planner: z.object({
    mode: z.enum(['model', 'offline']),
    provider: z.string().nullable(),
    /** Why the assistant is offline, e.g. NO_API_KEY or USER_DISABLED_EXTERNAL_MODELS. */
    reason: z.string().nullable(),
  }),
  worker: z.object({ healthy: z.boolean(), lastHeartbeatAt: Timestamp.nullable() }),
  capabilities: z.object({
    webFetch: z.boolean(),
    email: z.boolean(),
    memory: z.boolean(),
    generalQuestions: z.boolean(),
    // Phase B. Always sent by this API; optional only for older servers and fixtures.
    /** File uploads work (storage configured and the document-analysis skill enabled). */
    attachments: z.boolean().optional(),
    /** Translation can run now (needs a model). */
    translation: z.boolean().optional(),
    /** Schedules can be created (task-scheduling skill enabled). */
    schedules: z.boolean().optional(),
  }),
  version: z.string(),
});
export type AssistantStatus = z.infer<typeof AssistantStatus>;

export const Suggestion = z.object({
  id: z.string(),
  kind: z.enum(['command', 'connect', 'review']),
  /** i18n key; clients own the copy. */
  messageKey: z.string(),
  /** For 'command': text placed in the command bar (user still submits it). */
  command: z.string().nullable(),
  /** For 'connect' / 'review': in-app route. */
  href: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const HomeSnapshot = z.object({
  assistant: AssistantStatus,
  pendingApprovals: z.array(Approval),
  activeTasks: z.array(TaskSummary),
  recentTasks: z.array(TaskSummary),
  unreadNotifications: z.number().int(),
  suggestions: z.array(Suggestion),
});
export type HomeSnapshot = z.infer<typeof HomeSnapshot>;

export const UsageSummary = z.object({
  periodStart: Timestamp,
  periodEnd: Timestamp,
  aiMicroUsd: MicroUsd,
  toolMicroUsd: MicroUsd,
  totalMicroUsd: MicroUsd,
  budgetMicroUsd: MicroUsd,
  tasks: z.object({
    completed: z.number().int(),
    failed: z.number().int(),
    total: z.number().int(),
  }),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

export const VoiceSessionStart = z.object({
  locale: z.string().max(16),
  engine: z.enum(['browser_speech', 'ios_speech', 'android_speech']),
});
export const VoiceSessionEnd = z.object({
  outcome: z.enum(['submitted', 'cancelled', 'error', 'no_speech']),
  transcriptChars: z.number().int().min(0).max(10_000),
  errorCode: z.string().max(64).optional(),
});
export const VoiceSession = z.object({
  id: Id,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});

/* ------------------------------------------------------------------ */
/* Admin (aggregates only — never user content)                        */
/* ------------------------------------------------------------------ */

export const AdminOverview = z.object({
  generatedAt: Timestamp,
  health: z.object({
    database: z.boolean(),
    worker: z.object({ healthy: z.boolean(), lastHeartbeatAt: Timestamp.nullable() }),
    planner: AssistantStatus.shape.planner,
    /** Queued jobs that are due now; same as queueReady (kept for older clients). */
    queueDepth: z.number().int(),
    // The three below are always sent by this API; optional only for older fixtures.
    /** Queued jobs that are due now (the backlog the worker has to work through). */
    queueReady: z.number().int().optional(),
    /** Queued jobs that are due later (e.g. approval expiry timers): not backlog. */
    queueScheduled: z.number().int().optional(),
    /** How long the oldest due job has waited, or null when nothing is due. */
    oldestReadyAgeMs: z.number().int().nullable().optional(),
  }),
  users: z.object({ total: z.number().int(), active7d: z.number().int() }),
  tenants: z.object({ total: z.number().int() }),
  tasksByStatus: z.record(z.string(), z.number().int()),
  toolReliability: z.array(
    z.object({
      toolId: z.string(),
      executions: z.number().int(),
      succeeded: z.number().int(),
      failed: z.number().int(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
    }),
  ),
  cost30dMicroUsd: MicroUsd,
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const AdminUser = z.object({
  id: Id,
  email: z.string(),
  tenantName: z.string(),
  roles: z.array(Role),
  status: z.enum(['active', 'disabled', 'deleted']),
  createdAt: Timestamp,
  lastActiveAt: Timestamp.nullable(),
  taskCount: z.number().int(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AuditEvent = z.object({
  id: z.string(),
  at: Timestamp,
  tenantId: Id.nullable(),
  actorType: z.enum(['user', 'system', 'agent', 'admin']),
  actorId: Id.nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/* ------------------------------------------------------------------ */
/* Conversations (Phase B)                                             */
/* ------------------------------------------------------------------ */

/**
 * A message of a conversation: the user's request of a task, or what JARVIS
 * said when the task completed (its answer, clarifying question or result
 * line). At most one assistant message per task.
 */
export const ConversationMessage = z.object({
  id: Id,
  role: z.enum(['user', 'assistant']),
  kind: MessageKind,
  /** User text, model text, or the server sentence rendered in the request language. */
  text: z.string(),
  /** Set when the server composed the text: render it in the viewer's locale. */
  textMessage: ServerMessage.nullable(),
  language: Locale.nullable(),
  taskId: Id.nullable(),
  /** Files attached to a request (user messages); [] otherwise. */
  attachments: z.array(Attachment),
  createdAt: Timestamp,
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

/**
 * One entry of a conversation thread. Per task, in this order: the user's
 * request, the task (live status, approvals, result), and — once it completed —
 * JARVIS's message. Tasks appear in the order they were created.
 */
export const ConversationTurn = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), message: ConversationMessage }),
  z.object({ type: z.literal('task'), task: TaskSummary }),
  z.object({ type: z.literal('assistant_message'), message: ConversationMessage }),
]);
export type ConversationTurn = z.infer<typeof ConversationTurn>;

export const ConversationSummary = z.object({
  id: Id,
  /** In the first request's language; see titleMessage. */
  title: z.string(),
  titleMessage: ServerMessage.nullable(),
  /** Tasks in the conversation. */
  taskCount: z.number().int().nonnegative(),
  /** The newest task. */
  lastTask: TaskSummary.nullable(),
  /** A task of the conversation is QUEUED, PLANNING, AWAITING_APPROVAL, RUNNING or VERIFYING. */
  hasActiveTask: z.boolean(),
  /** Set for the conversation that collects a schedule's runs. */
  scheduleId: Id.nullable(),
  createdAt: Timestamp,
  /** Last activity (a new task, message or title). */
  updatedAt: Timestamp,
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationDetail = ConversationSummary.extend({
  /** The newest `limit` tasks' turns, oldest first. */
  turns: z.array(ConversationTurn),
  /** Pass as `before` to load the turns of earlier tasks; null when there are none. */
  earlierCursor: z.string().nullable(),
  /** A follow-up can be sent now: every task of the conversation has finished. */
  canFollowUp: z.boolean(),
  /** The task that has to finish (or be cancelled / decided) before a follow-up; null when none. */
  activeTaskId: Id.nullable(),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const ConversationListQuery = PageQuery.extend({
  /** Matches titles and requests (word match or literal substring). */
  q: z.string().trim().max(200).optional(),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

export const ConversationDetailQuery = z.object({
  before: z.string().max(200).optional(),
  /** Tasks (with their messages) per page. */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ConversationDetailQuery = z.infer<typeof ConversationDetailQuery>;

/**
 * A follow-up in an existing conversation: creates a NEW task in it. The
 * planner sees the conversation's earlier requests and results as context
 * (bounded, results marked as untrusted data). Answering a clarifying
 * question is a follow-up.
 */
export const FollowUpRequest = CreateTaskRequest.extend({});
export type FollowUpRequest = z.infer<typeof FollowUpRequest>;

/* ------------------------------------------------------------------ */
/* Skills (Phase B)                                                    */
/* ------------------------------------------------------------------ */

/**
 * A skill of the backend registry with its real availability for the
 * signed-in user. Names and descriptions are client copy keyed by `id`.
 * Skills never grant permissions: the Policy Engine decides every step.
 */
export const Skill = z.object({
  id: SkillId,
  /** Semver of the skill definition in the registry. */
  version: z.string(),
  status: SkillStatus,
  /** The user's switch (personal-memory mirrors preferences.memory.enabled). */
  enabled: z.boolean(),
  /** Whether the user may switch it (false for planned and core skills such as workflow-planning). */
  canToggle: z.boolean(),
  /** It can run for this user now. */
  available: z.boolean(),
  unavailableReason: SkillUnavailableReason.nullable(),
  /** Implemented tools the skill owns (disabling the skill denies them). */
  tools: z.array(ToolId),
  /** Tool ids that are planned, not built. */
  plannedTools: z.array(z.string()),
  /** Declarative scopes, e.g. web:read, email:send. Informational: never grants anything. */
  permissions: z.array(z.string()),
  /** Highest risk any of its tools can have. */
  maxRisk: RiskLevel,
  requiredConnections: z.array(ConnectionProvider),
  modelUse: z.enum(['none', 'optional', 'required']),
  /** Projected model cost per run above which the policy asks first (SKILL_COST_LIMIT); null = budget rules only. */
  maxCostPerRunMicroUsd: MicroUsd.nullable(),
  /** Repository path of the skill specification. */
  docsPath: z.string(),
});
export type Skill = z.infer<typeof Skill>;

export const UpdateSkillRequest = z.object({ enabled: z.boolean() });
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequest>;

/* ------------------------------------------------------------------ */
/* Schedules (Phase B)                                                 */
/* ------------------------------------------------------------------ */

/**
 * A request JARVIS runs on a recurrence. Every run is a normal task (source
 * 'schedule') in the schedule's conversation, planned and checked by the
 * policy when it runs; a schedule never pre-approves anything.
 */
export const Schedule = z.object({
  id: Id,
  title: z.string(),
  /** What each run asks JARVIS to do (user text). */
  request: z.string(),
  language: Locale.nullable(),
  /** Normalised (defaults applied). */
  recurrence: Recurrence,
  /** The RFC 5545 rule the server derived (DTSTART;TZID=…, RRULE:…); informational. */
  rrule: z.string(),
  status: ScheduleStatus,
  pausedReason: SchedulePauseReason.nullable(),
  /** Next occurrence; null when paused or completed. */
  nextRunAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  lastTaskId: Id.nullable(),
  /** The conversation that collects the runs (created with the first run). */
  conversationId: Id.nullable(),
  runCount: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** 'agent': created by schedule.create from a request the user approved. */
  createdBy: z.enum(['user', 'agent']),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleRun = z.object({
  id: Id,
  /** The occurrence this run is for (each occurrence runs at most once). */
  occurrenceAt: Timestamp,
  status: ScheduleRunStatus,
  reason: ScheduleRunReason.nullable(),
  /** The task created for it (null when skipped/failed, or deleted by retention). */
  task: TaskSummary.nullable(),
  createdAt: Timestamp,
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const ScheduleDetail = Schedule.extend({
  /** The next occurrences (SCHEDULE_LIMITS.upcomingShown); [] when paused or completed. */
  upcoming: z.array(Timestamp),
  /** Newest first (SCHEDULE_LIMITS.runsShown). */
  runs: z.array(ScheduleRun),
});
export type ScheduleDetail = z.infer<typeof ScheduleDetail>;

export const CreateScheduleRequest = z.object({
  title: z.string().trim().min(1).max(120),
  request: z.string().trim().min(1).max(4000),
  recurrence: Recurrence,
  /** Language of the request; detected when absent. */
  language: Locale.optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const UpdateScheduleRequest = z
  .object({
    title: z.string().trim().min(1).max(120),
    request: z.string().trim().min(1).max(4000),
    recurrence: Recurrence,
  })
  .partial();
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequest>;

export const SchedulePreviewRequest = z.object({
  recurrence: Recurrence,
  count: z.number().int().min(1).max(SCHEDULE_LIMITS.maxPreview).default(5),
});
export type SchedulePreviewRequest = z.infer<typeof SchedulePreviewRequest>;

export const SchedulePreview = z.object({
  rrule: z.string(),
  /** Instants of the next occurrences from now (fewer when until/count end the series). */
  occurrences: z.array(Timestamp),
  /** The zone as the server stores it (canonical spelling). */
  timeZone: z.string(),
});
export type SchedulePreview = z.infer<typeof SchedulePreview>;

/* ------------------------------------------------------------------ */
/* Webhooks (Phase B) — outbound, Standard Webhooks                    */
/* ------------------------------------------------------------------ */

export const WebhookEndpoint = z.object({
  id: Id,
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(WebhookEventType),
  status: WebhookEndpointStatus,
  disabledReason: WebhookDisabledReason.nullable(),
  /** Identifies the secret without revealing it, e.g. "whsec_…x7Qa". */
  secretHint: z.string(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastDeliveryAt: Timestamp.nullable(),
  lastSuccessAt: Timestamp.nullable(),
  lastFailureAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

/** Returned once, on create and on rotate: the secret is never shown again. */
export const WebhookEndpointWithSecret = z.object({
  endpoint: WebhookEndpoint,
  /** whsec_ + base64 key; sign/verify with Standard Webhooks (HMAC-SHA256, v1). */
  secret: z.string(),
});
export type WebhookEndpointWithSecret = z.infer<typeof WebhookEndpointWithSecret>;

export const CreateWebhookRequest = z.object({
  /** https:// (http only for hosts a development server allow-lists). Public addresses only. */
  url: z.url({ protocol: /^https?$/ }).max(2048),
  description: z.string().trim().max(200).optional(),
  eventTypes: z
    .array(WebhookEventType)
    .min(1)
    .max(WebhookEventType.options.length)
    .refine((t) => new Set(t).size === t.length, 'event types must be unique'),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const UpdateWebhookRequest = z
  .object({
    url: CreateWebhookRequest.shape.url,
    description: z.string().trim().max(200).nullable(),
    eventTypes: CreateWebhookRequest.shape.eventTypes,
    /** false disables (reason 'user'); true re-enables and resets the failure count. */
    enabled: z.boolean(),
  })
  .partial();
export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequest>;

export const WebhookDelivery = z.object({
  id: Id,
  endpointId: Id,
  eventType: WebhookDeliveryEventType,
  /** The webhook-id header value (msg_…), identical on every attempt. */
  webhookId: z.string(),
  status: WebhookDeliveryStatus,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: Timestamp.nullable(),
  lastAttemptAt: Timestamp.nullable(),
  /** HTTP status of the last attempt, when there was a response. */
  responseStatus: z.number().int().nullable(),
  failureReason: WebhookFailureReason.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/** `data` of task.* events. Ids, enums and times only — never titles, requests or results. */
export const WebhookTaskData = z.object({
  taskId: Id,
  conversationId: Id,
  scheduleId: Id.nullable(),
  status: TaskStatus,
  outcome: TaskOutcome.nullable(),
  riskLevel: RiskLevel,
  source: TaskSource,
  toolIds: z.array(ToolId),
  error: z
    .object({ code: ErrorCode, reason: z.string().nullable(), retryable: z.boolean() })
    .nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});

/** `data` of approval.* events (no summary or details: they contain message content). */
export const WebhookApprovalData = z.object({
  approvalId: Id,
  taskId: Id,
  stepId: Id,
  toolId: ToolId,
  riskLevel: RiskLevel,
  status: ApprovalStatus,
  expiresAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});

/** `data` of schedule.* events. */
export const WebhookScheduleData = z.object({
  scheduleId: Id,
  occurrenceAt: Timestamp,
  taskId: Id.nullable(),
  status: ScheduleStatus,
  consecutiveFailures: z.number().int().nonnegative(),
  reason: ScheduleRunReason.nullable(),
});

/**
 * The JSON body of every delivery (Standard Webhooks). Headers:
 *   webhook-id         msg_<delivery id>  (same on every attempt: dedupe on it)
 *   webhook-timestamp  Unix seconds of this attempt
 *   webhook-signature  "v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>"
 *                      key = base64-decoded secret without the whsec_ prefix
 * Reject timestamps outside WEBHOOK_LIMITS.toleranceSeconds (replay window).
 */
export const WebhookPayload = z.union([
  z.object({
    type: WebhookEventType.extract([
      'task.created',
      'task.completed',
      'task.failed',
      'task.cancelled',
      'task.expired',
    ]),
    timestamp: Timestamp,
    data: WebhookTaskData,
  }),
  z.object({
    type: WebhookEventType.extract(['approval.requested', 'approval.decided']),
    timestamp: Timestamp,
    data: WebhookApprovalData,
  }),
  z.object({
    type: WebhookEventType.extract(['schedule.triggered', 'schedule.failed']),
    timestamp: Timestamp,
    data: WebhookScheduleData,
  }),
  z.object({
    type: z.literal('webhook.test'),
    timestamp: Timestamp,
    data: z.object({ endpointId: Id, test: z.literal(true) }),
  }),
]);
export type WebhookPayload = z.infer<typeof WebhookPayload>;

/* ------------------------------------------------------------------ */
/* Meta (Phase B)                                                      */
/* ------------------------------------------------------------------ */

/** A time zone the server accepts: known to both Postgres and Node (Intl). */
export const TimeZoneInfo = z.object({
  /** As the server stores it (Postgres's spelling). */
  id: z.string(),
  /** Offset from UTC right now, in minutes (changes with DST). */
  utcOffsetMinutes: z.number().int(),
});
export type TimeZoneInfo = z.infer<typeof TimeZoneInfo>;
