import { z } from 'zod';

export const Locale = z.enum(['en', 'de', 'ar']);
export type Locale = z.infer<typeof Locale>;
export const RTL_LOCALES: readonly Locale[] = ['ar'];

export const ThemePreference = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof ThemePreference>;

export const Platform = z.enum(['web', 'ios', 'android', 'macos']);
export type Platform = z.infer<typeof Platform>;

export const Role = z.enum(['owner', 'member', 'platform_admin']);
export type Role = z.infer<typeof Role>;

/** Risk classification enforced by the deterministic Policy Engine (never by the model). */
export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevel>;
export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export const TaskStatus = z.enum([
  'QUEUED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const StepStatus = z.enum([
  'PENDING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'BLOCKED',
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const ApprovalStatus = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'SUPERSEDED',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const TaskSource = z.enum(['text', 'voice', 'schedule', 'api']);
export type TaskSource = z.infer<typeof TaskSource>;

/**
 * Tools of this build. The backend tool registry is authoritative; clients
 * tolerate ids they do not know (a newer server).
 * Phase B (docs/architecture/phase-b.md §3): document.analyze, text.translate,
 * schedule.create, conversation.recall (reuse an earlier turn's result in the
 * same conversation), assistant.clarify (ask the user for missing information).
 */
export const ToolId = z.enum([
  'web.fetch',
  'text.summarize',
  'email.send',
  'memory.save',
  'assistant.answer',
  'document.analyze',
  'text.translate',
  'schedule.create',
  'conversation.recall',
  'assistant.clarify',
]);
export type ToolId = z.infer<typeof ToolId>;

export const ConnectionProvider = z.enum(['web', 'smtp']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

export const ConnectionStatus = z.enum(['active', 'error', 'expired', 'revoked']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const MemoryKind = z.enum(['preference', 'fact']);
export type MemoryKind = z.infer<typeof MemoryKind>;

/**
 * In-app notification kinds. `data` carries localisation parameters only.
 *   schedule_failed   { scheduleTitle, taskTitle?, errorCode? }  a scheduled run could not be
 *                     created (scheduleTitle only), or its task failed (with the task's title and
 *                     error code); it replaces task_failed for that task (one notification, not two)
 *   schedule_paused   { scheduleTitle, reason: 'failures' | 'budget' }  paused automatically
 *   webhook_disabled  { endpointHost }   disabled after repeated failed deliveries
 */
export const NotificationKind = z.enum([
  'approval_requested',
  'task_completed',
  'task_failed',
  'connection_error',
  'schedule_failed',
  'schedule_paused',
  'webhook_disabled',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'IDEMPOTENCY_MISMATCH',
  'INVALID_STATE',
  'APPROVAL_EXPIRED',
  'APPROVAL_MISMATCH',
  'CONNECTION_REQUIRED',
  'CONNECTION_FAILED',
  'MODEL_NOT_CONFIGURED',
  'MODEL_ERROR',
  'PLANNER_UNSUPPORTED',
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
  'TOOL_FAILED',
  'TOOL_TIMEOUT',
  'OUTCOME_UNKNOWN',
  'VERIFICATION_FAILED',
  'FETCH_BLOCKED',
  // Phase B (HTTP only; see ApiErrorReason for the specific cause in error.details.reason)
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * The specific cause of an HTTP error, sent as `error.details.reason` (with
 * parameters in `error.details`) so clients explain it in the viewer's locale.
 * `error.message` stays an English developer fallback.
 *   FILE_TOO_LARGE { limitBytes } · UNSUPPORTED_FILE_TYPE · FILE_CONTENT_MISMATCH
 *   FILE_EMPTY · TOO_MANY_ATTACHMENTS { max } · ATTACHMENT_NOT_FOUND
 *   ATTACHMENT_EXPIRED · ATTACHMENT_IN_OTHER_CONVERSATION · STORAGE_NOT_CONFIGURED
 *   STORAGE_UNAVAILABLE · CONVERSATION_BUSY { taskId } · CONVERSATION_ACTIVE_TASK { taskId }
 *   SCHEDULE_LIMIT_REACHED { max } · INVALID_RECURRENCE · RECURRENCE_HAS_NO_OCCURRENCES
 *   UNKNOWN_TIME_ZONE · SCHEDULE_COMPLETED · WEBHOOK_LIMIT_REACHED { max }
 *   WEBHOOK_URL_INVALID · WEBHOOK_URL_INSECURE · WEBHOOK_URL_BLOCKED { host }
 *   WEBHOOK_DISABLED · SKILL_NOT_TOGGLEABLE · SKILL_PLANNED
 */
export const ApiErrorReason = z.enum([
  // attachments
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
  'FILE_CONTENT_MISMATCH',
  'FILE_EMPTY',
  'TOO_MANY_ATTACHMENTS',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_EXPIRED',
  'ATTACHMENT_IN_OTHER_CONVERSATION',
  'STORAGE_NOT_CONFIGURED',
  'STORAGE_UNAVAILABLE',
  // conversations
  'CONVERSATION_BUSY',
  'CONVERSATION_ACTIVE_TASK',
  // schedules
  'SCHEDULE_LIMIT_REACHED',
  'INVALID_RECURRENCE',
  'RECURRENCE_HAS_NO_OCCURRENCES',
  'UNKNOWN_TIME_ZONE',
  'SCHEDULE_COMPLETED',
  // webhooks
  'WEBHOOK_LIMIT_REACHED',
  'WEBHOOK_URL_INVALID',
  'WEBHOOK_URL_INSECURE',
  'WEBHOOK_URL_BLOCKED',
  'WEBHOOK_DISABLED',
  // skills
  'SKILL_NOT_TOGGLEABLE',
  'SKILL_PLANNED',
]);
export type ApiErrorReason = z.infer<typeof ApiErrorReason>;

/* ------------------------------------------------------------------ */
/* Phase B enums                                                       */
/* ------------------------------------------------------------------ */

/**
 * What a COMPLETED task produced (null while it is not completed):
 *   answer   — text for the user (assistant.answer, document.analyze, text.translate)
 *   action   — something was done (email sent, memory saved, schedule created)
 *   question — JARVIS needs information first (assistant.clarify); answering is a follow-up
 */
export const TaskOutcome = z.enum(['answer', 'action', 'question']);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** What a clarifying question asks for (clients may offer a matching input, e.g. attach a file). */
export const MissingInfo = z.enum([
  'email_content',
  'recipient',
  'url',
  'document',
  'schedule_time',
  'target_language',
  'previous_result',
  'details',
]);
export type MissingInfo = z.infer<typeof MissingInfo>;

/** Kind of a conversation message: the user's request, or what JARVIS said about a task. */
export const MessageKind = z.enum(['request', 'answer', 'question', 'result']);
export type MessageKind = z.infer<typeof MessageKind>;

/** File types JARVIS accepts, identified by content sniffing (the extension must agree). */
export const AttachmentMediaType = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
]);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaType>;

/** The 12 skills of docs/skills (ids are the file names). */
export const SkillId = z.enum([
  'web-research',
  'email-management',
  'calendar-management',
  'appointment-booking',
  'phone-calling',
  'shopping-assistant',
  'document-analysis',
  'task-scheduling',
  'personal-memory',
  'device-automation',
  'translation',
  'workflow-planning',
]);
export type SkillId = z.infer<typeof SkillId>;

/**
 * Per user: implemented (built; see `available` for whether it can run now),
 * needs_connection (built, but needs a connection the user has not set up),
 * planned (not built yet — never runnable).
 */
export const SkillStatus = z.enum(['implemented', 'needs_connection', 'planned']);
export type SkillStatus = z.infer<typeof SkillStatus>;

/** Why a skill cannot run for this user right now. */
export const SkillUnavailableReason = z.enum([
  'PLANNED',
  'DISABLED_BY_USER',
  'CONNECTION_REQUIRED',
  'MODEL_REQUIRED',
  'MEMORY_DISABLED',
  'STORAGE_NOT_CONFIGURED',
]);
export type SkillUnavailableReason = z.infer<typeof SkillUnavailableReason>;

export const ScheduleFrequency = z.enum(['daily', 'weekly', 'monthly']);
export type ScheduleFrequency = z.infer<typeof ScheduleFrequency>;

/** RFC 5545 weekday codes. */
export const Weekday = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type Weekday = z.infer<typeof Weekday>;

/** active (runs at nextRunAt) · paused (see pausedReason) · completed (until/count reached). */
export const ScheduleStatus = z.enum(['active', 'paused', 'completed']);
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

/** user (paused by the user) · failures (3 consecutive failed runs) · budget (AI budget used up). */
export const SchedulePauseReason = z.enum(['user', 'failures', 'budget']);
export type SchedulePauseReason = z.infer<typeof SchedulePauseReason>;

/** created (a task was created for the occurrence) · skipped · failed (no task could be created). */
export const ScheduleRunStatus = z.enum(['created', 'skipped', 'failed']);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatus>;

/**
 * Why a run created no task (schedule_runs.reason; also WebhookScheduleData.reason). A
 * schedule.failed webhook for a pause after repeated failed runs carries reason null, with
 * status 'paused' and consecutiveFailures ≥ SCHEDULE_LIMITS.failuresBeforePause.
 */
export const ScheduleRunReason = z.enum(['BUDGET_EXHAUSTED', 'SCHEDULE_PAUSED', 'CREATE_FAILED']);
export type ScheduleRunReason = z.infer<typeof ScheduleRunReason>;

/** Events an endpoint can subscribe to (payloads: ids, types and metadata only — never content). */
export const WebhookEventType = z.enum([
  'task.created',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.expired',
  'approval.requested',
  'approval.decided',
  'schedule.triggered',
  'schedule.failed',
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/** Event types of deliveries: the subscribable ones plus the test event sent on request. */
export const WebhookDeliveryEventType = z.enum([
  'task.created',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.expired',
  'approval.requested',
  'approval.decided',
  'schedule.triggered',
  'schedule.failed',
  'webhook.test',
]);
export type WebhookDeliveryEventType = z.infer<typeof WebhookDeliveryEventType>;

export const WebhookEndpointStatus = z.enum(['active', 'disabled']);
export type WebhookEndpointStatus = z.infer<typeof WebhookEndpointStatus>;

/** user (switched off) · failures (WEBHOOK_DISABLE_AFTER_FAILURES consecutive failed deliveries). */
export const WebhookDisabledReason = z.enum(['user', 'failures']);
export type WebhookDisabledReason = z.infer<typeof WebhookDisabledReason>;

/** pending (queued or waiting for a retry) · succeeded (2xx) · failed (all attempts used, or abandoned). */
export const WebhookDeliveryStatus = z.enum(['pending', 'succeeded', 'failed']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookFailureReason = z.enum([
  'HTTP_ERROR',
  'TIMEOUT',
  'CONNECT_FAILED',
  'TLS_CERTIFICATE',
  'HOST_NOT_FOUND',
  'PRIVATE_ADDRESS',
  'REDIRECT',
  'ENDPOINT_DISABLED',
  'ENDPOINT_DELETED',
  'INTERNAL',
]);
export type WebhookFailureReason = z.infer<typeof WebhookFailureReason>;

/**
 * Policy reason codes (PolicyDecision.reasons, Approval.reasons). The field
 * stays `string[]` so clients tolerate codes from a newer server; this list is
 * what the current server emits, for client copy.
 */
export const PolicyReason = z.enum([
  'CONNECTION_MISSING',
  'MEMORY_DISABLED',
  'RISK_CRITICAL',
  'BUDGET_ZERO',
  'BUDGET_EXHAUSTED',
  'EXTERNAL_MODELS_DISABLED',
  'MODEL_UNAVAILABLE',
  'RISK_LOW',
  'RISK_MEDIUM',
  'RISK_HIGH',
  'RECIPIENT_SELF',
  'RECIPIENT_EXTERNAL',
  'MANY_RECIPIENTS',
  'BUDGET_NEAR_LIMIT',
  'UNTRUSTED_CONTENT',
  'AUTO_APPROVED_SELF',
  // Phase B
  'SKILL_DISABLED',
  'SKILL_COST_LIMIT',
  'MEMORY_FROM_CONTENT',
  'UNTRUSTED_MEMORY',
  'FUTURE_RUNS',
]);
export type PolicyReason = z.infer<typeof PolicyReason>;
