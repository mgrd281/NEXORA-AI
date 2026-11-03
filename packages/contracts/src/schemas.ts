import { z } from 'zod';
import {
  ApprovalStatus,
  ConnectionProvider,
  ConnectionStatus,
  ErrorCode,
  Locale,
  MemoryKind,
  NotificationKind,
  Platform,
  RiskLevel,
  Role,
  StepStatus,
  TaskSource,
  TaskStatus,
  ThemePreference,
  ToolId,
} from './enums';

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
});
export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = {
  voice: { speakResponses: false, recognitionLocale: 'auto' },
  autonomy: { autoApproveEmailToSelf: false },
  ai: { allowExternalModels: true },
  notifications: { approvalRequested: true, taskCompleted: true, taskFailed: true },
  spending: { monthlyAiBudgetUsd: 20 },
  memory: { enabled: true },
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
 */
export const EvidenceCode = z.enum([
  'HTTP_RESPONSE',
  'CONTENT_HASH',
  'SMTP_RECEIPT',
  'MODEL_OUTPUT',
  'EXTRACTIVE_SUMMARY',
  'MEMORY_RECORD',
  'ANSWER_TRUNCATED',
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
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const CreateTaskRequest = z.object({
  request: z.string().trim().min(1).max(4000),
  source: TaskSource.extract(['text', 'voice']).default('text'),
  /** BCP-47-ish language of the request, if known (voice recognition supplies it). */
  language: Locale.optional(),
  voiceSessionId: Id.optional(),
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

export const StreamEvent = z.object({
  id: z.string(),
  type: z.union([
    TaskEventType,
    z.enum(['notification.created', 'connection.changed', 'heartbeat']),
  ]),
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
