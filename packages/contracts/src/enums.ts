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
 * Phase C (docs/architecture/phase-c.md §6): the email agent (email.search,
 * email.read_thread, email.draft_reply, email.track_replies; email.send gains
 * `via` for sending through Gmail/Outlook), calendars (calendar.*), booking
 * (booking.*), the isolated browser agent (browser.read, browser.fill) and
 * shopping (shop.*).
 * Phase D (docs/architecture/phase-d.md §6): phone.call — an outbound call
 * that discloses itself as an AI assistant and pursues one approved goal.
 * A ToolId being listed does not mean the tool is
 * registered on this server: GET /v1/skills reports what can run.
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
  // Phase C — email agent (Gmail API v1 / Microsoft Graph mail)
  'email.search',
  'email.read_thread',
  'email.draft_reply',
  'email.track_replies',
  // Phase C — calendars (Google Calendar API v3 / Microsoft Graph calendar)
  'calendar.list',
  'calendar.free_busy',
  'calendar.create_event',
  'calendar.update_event',
  'calendar.cancel_event',
  // Phase C — booking on supported sites (browser recipes)
  'booking.find_slots',
  'booking.book',
  // Phase C — isolated browser agent (supported sites only)
  'browser.read',
  'browser.fill',
  // Phase C — shopping on supported shops
  'shop.search',
  'shop.compare',
  'shop.prepare_cart',
  'shop.checkout',
  // Phase D — outbound phone calls through the telephony gateway (docs/architecture/phase-d.md)
  'phone.call',
]);
export type ToolId = z.infer<typeof ToolId>;

/**
 * Phase C adds the OAuth 2.0 providers: google (Gmail + Google Calendar) and
 * microsoft (Outlook mail + calendar through Microsoft Graph).
 */
export const ConnectionProvider = z.enum(['web', 'smtp', 'google', 'microsoft']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

/** Providers connected with OAuth 2.0 (authorization code + PKCE). */
export const OAuthProvider = z.enum(['google', 'microsoft']);
export type OAuthProvider = z.infer<typeof OAuthProvider>;

/**
 * What JARVIS may do with an OAuth connection. Each capability maps to the
 * least-privilege provider scopes in OAUTH_SCOPES (limits.ts) and is requested
 * only when the user enables it (incremental authorization).
 *   mail.read      search and read messages and threads
 *   mail.compose   create drafts in the user's mailbox (nothing is sent)
 *   mail.send      send mail as the user
 *   calendar.read  read events and free/busy
 *   calendar.write create, change and cancel events (and send invitations)
 */
export const ConnectionCapability = z.enum([
  'mail.read',
  'mail.compose',
  'mail.send',
  'calendar.read',
  'calendar.write',
]);
export type ConnectionCapability = z.infer<typeof ConnectionCapability>;

export const ConnectionStatus = z.enum(['active', 'error', 'expired', 'revoked']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * Why a connection is not active (Connection.statusReason; null while active).
 *   GRANT_INVALID   the provider refused the refresh token (invalid_grant: it
 *                   expired or the user revoked JARVIS's access) → status 'expired'
 *   TOKEN_REJECTED  the provider answered 401 to a freshly refreshed token → 'expired'
 *   SCOPE_MISSING   a permission JARVIS relies on was withdrawn (403 insufficient
 *                   scope); the capability was removed, the connection may stay active
 *   PROVIDER_ERROR  repeated provider failures (5xx) → status 'error'
 * Every 'expired' connection is fixed by reconnecting (POST /v1/connections/oauth/start
 * with its connectionId).
 */
export const ConnectionStatusReason = z.enum([
  'GRANT_INVALID',
  'TOKEN_REJECTED',
  'SCOPE_MISSING',
  'PROVIDER_ERROR',
]);
export type ConnectionStatusReason = z.infer<typeof ConnectionStatusReason>;

export const MemoryKind = z.enum(['preference', 'fact']);
export type MemoryKind = z.infer<typeof MemoryKind>;

/**
 * In-app notification kinds. `data` carries localisation parameters only.
 *   schedule_failed   { scheduleTitle, taskTitle?, errorCode? }  a scheduled run could not be
 *                     created (scheduleTitle only), or its task failed (with the task's title and
 *                     error code); it replaces task_failed for that task (one notification, not two)
 *   schedule_paused   { scheduleTitle, reason: 'failures' | 'budget' }  paused automatically
 *   webhook_disabled  { endpointHost }   disabled after repeated failed deliveries
 * Phase C:
 *   connection_expired    { provider, connectionId, accountIdentifier? }  an OAuth
 *                         connection stopped working (ConnectionStatusReason); offer
 *                         "Reconnect" (always notifies: nothing using it works until then)
 *   email_reply_received  { watchId, provider, subject, fromAddress }  a reply arrived in a
 *                         thread JARVIS tracks (email.track_replies); follows taskCompleted
 */
export const NotificationKind = z.enum([
  'approval_requested',
  'task_completed',
  'task_failed',
  'connection_error',
  'schedule_failed',
  'schedule_paused',
  'webhook_disabled',
  'connection_expired',
  'email_reply_received',
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
 * Phase C (connections, calendar):
 *   PROVIDER_NOT_CONFIGURED { provider }  503: the server has no client id/secret for it
 *   REDIRECT_URI_NOT_ALLOWED              400: not exactly one of the server's redirect URIs
 *   OAUTH_STATE_INVALID                   400: unknown, already used, or started by another session
 *   OAUTH_STATE_EXPIRED                   400: the sign-in took longer than OAUTH_LIMITS.stateTtlMinutes
 *   OAUTH_DENIED { provider }             400: the user declined at the provider (error=access_denied)
 *   OAUTH_EXCHANGE_FAILED { provider }    422 (CONNECTION_FAILED): the provider's token endpoint refused the code
 *   OAUTH_SCOPE_NOT_GRANTED { capabilities }  400: none of the requested capabilities was granted
 *                                         (comma-separated ConnectionCapability values)
 *   OAUTH_ACCOUNT_MISMATCH { provider }   409: reconnecting signed in to a different account
 *   OAUTH_PENDING_LIMIT { max }           429: too many unfinished sign-ins
 *   CONNECTION_NOT_OAUTH                  400: connectionId names an SMTP or web connection
 *   CALENDAR_NOT_CONNECTED                409: no connection grants calendar.read
 *   CALENDAR_UNAVAILABLE { provider }     503: the provider did not answer in time / failed
 *   EVIDENCE_NOT_AVAILABLE                503: the evidence file is in storage this server cannot read
 * Phase D (docs/architecture/phase-d.md §6):
 *   PHONE_NUMBER_INVALID                  400: not a valid, diallable number (E.164 after normalisation)
 *   PHONE_NUMBER_REQUIRED                 409: verifying needs a phone number on the account first
 *   PHONE_ALREADY_VERIFIED                409: this number is verified already
 *   PHONE_VERIFICATION_INVALID { attemptsLeft }  400: the code is wrong (or no verification is running)
 *   PHONE_VERIFICATION_EXPIRED            400: the code is older than CALL_LIMITS.verificationTtlMinutes
 *                                         or was used up (start a new verification)
 *   PHONE_VERIFICATION_LIMIT { max }      429: too many verification calls today
 *   TELEPHONY_NOT_CONFIGURED              503: this server has no telephony provider (Twilio) configured
 *   CALL_DESTINATION_BLOCKED { country }  400: premium-rate, shared-cost or other blocked numbers, or a
 *                                         country this server does not call (CALL_ALLOWED_COUNTRIES)
 *   WEBHOOK_SIGNATURE_INVALID             403: a telephony webhook without a valid provider signature
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
  // Phase C — OAuth connections
  'PROVIDER_NOT_CONFIGURED',
  'REDIRECT_URI_NOT_ALLOWED',
  'OAUTH_STATE_INVALID',
  'OAUTH_STATE_EXPIRED',
  'OAUTH_DENIED',
  'OAUTH_EXCHANGE_FAILED',
  'OAUTH_SCOPE_NOT_GRANTED',
  'OAUTH_ACCOUNT_MISMATCH',
  'OAUTH_PENDING_LIMIT',
  'CONNECTION_NOT_OAUTH',
  // Phase C — calendar, evidence
  'CALENDAR_NOT_CONNECTED',
  'CALENDAR_UNAVAILABLE',
  'EVIDENCE_NOT_AVAILABLE',
  // Phase D — the account's phone number, its verification, telephony webhooks
  'PHONE_NUMBER_INVALID',
  'PHONE_NUMBER_REQUIRED',
  'PHONE_ALREADY_VERIFIED',
  'PHONE_VERIFICATION_INVALID',
  'PHONE_VERIFICATION_EXPIRED',
  'PHONE_VERIFICATION_LIMIT',
  'TELEPHONY_NOT_CONFIGURED',
  'CALL_DESTINATION_BLOCKED',
  'WEBHOOK_SIGNATURE_INVALID',
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
  // Phase C
  /** When: a date/time (window) for an event, a meeting or an appointment. */
  'date_time',
  /** Details a booking form requires that JARVIS does not know (e.g. a phone number). */
  'contact_details',
  /** Which product, variant or quantity. */
  'product',
  /** Which supported site or shop. */
  'site',
  // Phase D
  /** Which number to call — written with its country code (E.164), or the profile number's country is used. */
  'phone_number',
  /** What JARVIS should say or ask on the call. */
  'call_goal',
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
  // Phase C
  /** None of the services the skill can use (Google, Microsoft) is configured on this server. */
  'PROVIDER_NOT_CONFIGURED',
  /** The isolated browser agent is not running on this server (or storage for its evidence is missing). */
  'BROWSER_UNAVAILABLE',
  // Phase D
  /** This server has no telephony provider configured (phone calls are impossible here). */
  'TELEPHONY_NOT_CONFIGURED',
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
  // Phase C (docs/architecture/phase-c.md §5)
  /** deny: the OAuth connection the step needs has expired (reconnect it). */
  'CONNECTION_EXPIRED',
  /** deny: the connection exists but does not grant the capability (e.g. mail.send). */
  'CONNECTION_SCOPE_MISSING',
  /** deny: spending.monthlyPurchaseLimitUsd is 0 (the default): purchases are off. */
  'PURCHASES_DISABLED',
  /** deny: this purchase would take the month's committed purchases above the limit. */
  'PURCHASE_LIMIT',
  /** deny: the purchase is not in USD, the currency of the limit (no verifiable exchange rate). */
  'PURCHASE_CURRENCY',
  /** approval: the step spends money (always asked, never auto-approved). */
  'PURCHASE',
  /** approval: a binding commitment on a site (booking, form submission). */
  'BINDING_COMMITMENT',
  // Phase D (docs/architecture/phase-d.md §5)
  /** deny: the number asked not to be called again (do-not-call list). */
  'DO_NOT_CALL',
  /** deny: now is outside the allowed calling hours in the callee's time zone. */
  'CALL_OUTSIDE_HOURS',
  /** deny: the account placed CALL_MAX_PER_DAY calls today already. */
  'CALL_LIMIT',
  /** deny: premium-rate / shared-cost / unknown-type numbers, or a country this server does not call. */
  'CALL_DESTINATION_BLOCKED',
  /** deny: no telephony provider is configured on this server. */
  'TELEPHONY_NOT_CONFIGURED',
  /** approval: JARVIS speaks for the user to a third party (always asked, never auto-approved). */
  'PHONE_CALL',
  /** approval: the user asked for the call to be recorded (only with the callee's consent). */
  'CALL_RECORDING',
  /** approval: JARVIS may tell the callee personal details of the user (listed in the approval). */
  'CALL_PERSONAL_INFO',
]);
export type PolicyReason = z.infer<typeof PolicyReason>;

/* ------------------------------------------------------------------ */
/* Phase C enums (docs/architecture/phase-c.md)                        */
/* ------------------------------------------------------------------ */

/**
 * A thread JARVIS watches for replies (email.track_replies).
 *   watching  polled every EMAIL_LIMITS.watchPollMinutes until expiresAt
 *   replied   a message from someone else arrived (notification email_reply_received)
 *   stopped   the user stopped it (DELETE /v1/email/watches/:id)
 *   expired   expiresAt passed without a reply
 *   failed    the connection stopped working or the thread disappeared
 */
export const EmailWatchStatus = z.enum(['watching', 'replied', 'stopped', 'expired', 'failed']);
export type EmailWatchStatus = z.infer<typeof EmailWatchStatus>;

/**
 * A browser session of the isolated browser agent (one per tool execution).
 *   queued       waiting for the browser worker
 *   running      a fresh, ephemeral browser context is working on the site
 *   succeeded    the recipe finished and its result was verified
 *   failed       it stopped (stopReason says why); nothing binding was submitted
 *   handover     it stopped at something only the user may do (CAPTCHA, login,
 *                bot protection): the user continues on the site themselves
 *   interrupted  the worker stopped mid-way; for a binding step the outcome is unknown
 */
export const BrowserSessionStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'handover',
  'interrupted',
]);
export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatus>;

/** Why a browser session stopped before succeeding (also a TaskErrorReason of the same name). */
export const BrowserStopReason = z.enum([
  'CAPTCHA_DETECTED',
  'LOGIN_REQUIRED',
  'BOT_PROTECTION',
  'SITE_UNSUPPORTED',
  'NAVIGATION_BLOCKED',
  'PAGE_CHANGED',
  'SITE_ERROR',
  'BROWSER_BUDGET_EXCEEDED',
  'BROWSER_TIMEOUT',
  'BROWSER_CRASHED',
  'CANCELLED',
]);
export type BrowserStopReason = z.infer<typeof BrowserStopReason>;

/**
 * Files kept as evidence (object storage; owner-only download): the browser agent's screenshots,
 * extracted data and ICS files (Phase C), and (Phase D) a call recording — only ever when the
 * user asked for it for that call AND the callee was told and accepted.
 */
export const EvidenceArtifactKind = z.enum(['screenshot', 'extract', 'ics', 'recording']);
export type EvidenceArtifactKind = z.infer<typeof EvidenceArtifactKind>;

/** Media type per EvidenceArtifactKind: image/png, application/json, text/calendar, audio/mpeg. */
export const EvidenceMediaType = z.enum([
  'image/png',
  'application/json',
  'text/calendar',
  'audio/mpeg',
]);
export type EvidenceMediaType = z.infer<typeof EvidenceMediaType>;

/**
 * An order placed by shop.checkout (exactly once per step: unique idempotency key).
 *   submitting  the checkout is being submitted (counts against the monthly limit)
 *   placed      the merchant confirmed it (merchantOrderId + evidence)
 *   failed      definitely not placed (declined, out of stock, price changed before submit)
 *   unknown     interrupted after submission started: check with the merchant before retrying
 *               (counts against the monthly limit until resolved)
 */
export const OrderStatus = z.enum(['submitting', 'placed', 'failed', 'unknown']);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** An appointment booked on a supported site by booking.book (same lifecycle as orders). */
export const BookingStatus = z.enum(['submitting', 'confirmed', 'failed', 'unknown', 'cancelled']);
export type BookingStatus = z.infer<typeof BookingStatus>;

/**
 * Facts about a merchant read from its own pages (never a JARVIS judgement):
 *   https            the shop and its checkout are served over HTTPS
 *   return_policy    a returns / withdrawal policy page is linked
 *   contact_details  a postal address or phone number is published
 *   legal_notice     an imprint / legal notice (Impressum) is published
 *   customer_rating  the page shows a rating (value + count in ReliabilitySignal)
 *   delivery_terms   shipping costs and delivery times are stated
 */
export const ReliabilitySignalCode = z.enum([
  'https',
  'return_policy',
  'contact_details',
  'legal_notice',
  'customer_rating',
  'delivery_terms',
]);
export type ReliabilitySignalCode = z.infer<typeof ReliabilitySignalCode>;

/** Calendar attendee response as the provider reports it. */
export const AttendeeResponse = z.enum(['accepted', 'declined', 'tentative', 'needs_action']);
export type AttendeeResponse = z.infer<typeof AttendeeResponse>;

/* ------------------------------------------------------------------ */
/* Phase D enums (docs/architecture/phase-d.md)                        */
/* ------------------------------------------------------------------ */

/**
 * What a phone call is for (phone.call `purpose`). The offline dialog engine
 * runs a deterministic script for `message`, `availability` and `questions`;
 * `appointment` (agreeing a binding time) needs the model and is HIGH risk.
 *   message       deliver the user's message and record the reply
 *   availability  ask which times are free on a given date; times extracted by rules
 *   questions     ask the user's questions (at most CALL_LIMITS.maxQuestions) and record the answers
 *   appointment   book an appointment within the approved window (date, time, name, reference)
 */
export const CallPurpose = z.enum(['message', 'availability', 'questions', 'appointment']);
export type CallPurpose = z.infer<typeof CallPurpose>;

/**
 * Lifecycle of one call attempt (call_sessions.status).
 *   queued       stored; the provider has not been asked yet
 *   dialing      the create-call request was sent and accepted (provider call id known)
 *   ringing      the provider reports the callee's phone ringing
 *   in_progress  answered: the dialog is running
 *   ended        finished — `result` says how (CallResult)
 *   unknown      the create-call request's outcome is unknown (timeout after sending):
 *                reconciled with the provider before anything is dialled again
 */
export const CallStatus = z.enum([
  'queued',
  'dialing',
  'ringing',
  'in_progress',
  'ended',
  'unknown',
]);
export type CallStatus = z.infer<typeof CallStatus>;

/**
 * How an ended call ended (CallOutcome.result). Only `completed` and
 * `answered` count as a call that took place; every other result fails the
 * step with the TaskErrorReason of the same meaning (CALL_BUSY …).
 *   completed    answered and the approved goal was reached (evidence: the turns)
 *   answered     answered, the conversation ended normally, the goal was not reached
 *   busy · no_answer · failed (the provider could not connect it) · voicemail (a machine
 *   answered: nothing is left unless the approval allowed a message) · hung_up (the callee hung
 *   up before the goal was reached) · declined (the callee did not want to talk to an AI
 *   assistant) · canceled (JARVIS ended it before it connected: task cancelled, limits)
 */
export const CallResult = z.enum([
  'completed',
  'answered',
  'busy',
  'no_answer',
  'failed',
  'voicemail',
  'hung_up',
  'declined',
  'canceled',
]);
export type CallResult = z.infer<typeof CallResult>;

/** Who spoke a call turn. `system` = a line JARVIS played that is not dialog (consent notice, transfer). */
export const CallSpeaker = z.enum(['agent', 'callee', 'system']);
export type CallSpeaker = z.infer<typeof CallSpeaker>;

/** What a call turn is (for display and evidence). */
export const CallTurnKind = z.enum([
  'disclosure',
  'consent_request',
  'consent_reply',
  'question',
  'answer',
  'statement',
  'clarification',
  'refusal',
  'transfer',
  'voicemail',
  'goodbye',
]);
export type CallTurnKind = z.infer<typeof CallTurnKind>;

/**
 * Recording of a call (phone.call `recording`; default off).
 *   off            never recorded; only the turns as text are kept (task data)
 *   if_consented   asked at the start; recorded only after the callee accepted, else not recorded
 *   required       asked at the start; without the callee's consent JARVIS ends the call politely
 *                  (RECORDING_CONSENT_DECLINED)
 */
export const RecordingMode = z.enum(['off', 'if_consented', 'required']);
export type RecordingMode = z.infer<typeof RecordingMode>;

/** The callee's answer to the recording question (evidence RECORDING_CONSENT). */
export const RecordingConsent = z.enum(['not_asked', 'accepted', 'declined']);
export type RecordingConsent = z.infer<typeof RecordingConsent>;

/** Answering-machine detection (the provider's AnsweredBy, simplified). */
export const AnsweredBy = z.enum(['human', 'machine', 'fax', 'unknown']);
export type AnsweredBy = z.infer<typeof AnsweredBy>;

/** What JARVIS does when a machine answers (phone.call `voicemail`). */
export const VoicemailAction = z.enum(['hang_up', 'leave_message']);
export type VoicemailAction = z.infer<typeof VoicemailAction>;

/**
 * Facts noted during a call (CallOutcome.notes), for the result and the timeline.
 *   OPTED_OUT                    the callee asked not to be called again (do-not-call entry made)
 *   RECORDING_CONSENT_ACCEPTED / RECORDING_CONSENT_DECLINED
 *   TRANSFER_REQUESTED           the callee asked for a person
 *   TRANSFER_CONNECTED / TRANSFER_FAILED / TRANSFER_UNAVAILABLE (no verified number, or not approved)
 *   OUTSIDE_PURPOSE_REFUSED      JARVIS refused something outside the approved purpose (e.g. card details)
 *   INJECTION_FLAGGED            the callee's speech contained instructions to AI assistants (ignored)
 *   LOW_CONFIDENCE               speech recognition was unsure; JARVIS asked again
 *   DURATION_LIMIT               the call reached its maximum duration
 *   VOICEMAIL_MESSAGE_LEFT       a machine answered and the approved message was left
 */
export const CallNoteCode = z.enum([
  'OPTED_OUT',
  'RECORDING_CONSENT_ACCEPTED',
  'RECORDING_CONSENT_DECLINED',
  'TRANSFER_REQUESTED',
  'TRANSFER_CONNECTED',
  'TRANSFER_FAILED',
  'TRANSFER_UNAVAILABLE',
  'OUTSIDE_PURPOSE_REFUSED',
  'INJECTION_FLAGGED',
  'LOW_CONFIDENCE',
  'DURATION_LIMIT',
  'VOICEMAIL_MESSAGE_LEFT',
]);
export type CallNoteCode = z.infer<typeof CallNoteCode>;

/** Where a do-not-call entry came from: the callee asked during a call, or the user added it. */
export const DoNotCallSource = z.enum(['callee_request', 'user']);
export type DoNotCallSource = z.infer<typeof DoNotCallSource>;

/** A verification call to the account's own number (POST /v1/me/phone/verification). */
export const PhoneVerificationStatus = z.enum([
  'calling',
  'pending',
  'verified',
  'expired',
  'failed',
]);
export type PhoneVerificationStatus = z.infer<typeof PhoneVerificationStatus>;

/** Voice mode: one request (dictation, Milestone 1) or a continuous conversation (Phase D). */
export const VoiceSessionMode = z.enum(['dictation', 'conversation']);
export type VoiceSessionMode = z.infer<typeof VoiceSessionMode>;

/**
 * How a voice session ended (VoiceSessionEnd.endReason; metadata only).
 *   end_button · escape_key · voice_command ("stop" / "stopp" / "توقف") · idle (no speech for
 *   VOICE_LIMITS.idleEndSeconds) · switched_to_text · navigation (the overlay was left) · error
 */
export const VoiceEndReason = z.enum([
  'end_button',
  'escape_key',
  'voice_command',
  'idle',
  'switched_to_text',
  'navigation',
  'error',
]);
export type VoiceEndReason = z.infer<typeof VoiceEndReason>;
