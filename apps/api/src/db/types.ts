/**
 * Kysely table types for db/migrations. Keep in sync with the SQL — the
 * integration test `schema.int.test.ts` fails if a column here is missing in the DB.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Json<T = unknown> = ColumnType<T, T | string, T | string>;
type JsonDefault<T = unknown> = ColumnType<T, T | string | undefined, T | string>;

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  status: Generated<'active' | 'suspended'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  locale: Generated<'en' | 'de' | 'ar'>;
  time_zone: Generated<string>;
  theme: Generated<'system' | 'light' | 'dark'>;
  preferences: JsonDefault<Record<string, unknown>>;
  status: Generated<'active' | 'disabled'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_active_at: NullableTimestamp;
  /** 0008: the account's own number (E.164; plain, like email — see the migration). */
  phone_number: string | null;
  /** 0008: set when a verification call confirmed phone_number (CHECK: only with a number). */
  phone_verified_at: NullableTimestamp;
}

export interface UserRolesTable {
  tenant_id: string;
  user_id: string;
  role: 'owner' | 'member' | 'platform_admin';
  created_at: Generated<Date>;
}

export interface DevicesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  name: string | null;
  platform: 'web' | 'ios' | 'android' | 'macos';
  push_token_ciphertext: Buffer | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  revoked_at: NullableTimestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  device_id: string | null;
  token_hash: Buffer;
  platform: 'web' | 'ios' | 'android' | 'macos';
  device_name: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  last_used_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface ConversationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  title: Generated<string>;
  /** ServerMessage of the title when the server wrote it (0004). */
  title_message: Json<ServerMessageJson | null> | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type TaskStatusValue =
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';
export type RiskValue = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface TaskErrorJson {
  code: string;
  message: string;
  retryable: boolean;
  reason?: string;
  params?: Record<string, string | number>;
}

export interface EvidenceJson {
  kind: string;
  label: string;
  value: string;
  at: string;
  code?: string;
  params?: Record<string, string | number>;
}

/** A server sentence as {key, params} (contracts ServerMessage). */
export interface ServerMessageJson {
  key: string;
  params: Record<string, unknown>;
}

export type TaskOutcomeValue = 'answer' | 'action' | 'question';

/** contracts AssistantQuestion, as stored on tasks.question. */
export interface AssistantQuestionJson {
  text: string;
  message: ServerMessageJson | null;
  missing: string[];
}

export interface TasksTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  title: string;
  title_message: Json<ServerMessageJson | null> | null;
  request: string;
  objective: string | null;
  objective_message: Json<ServerMessageJson | null> | null;
  status: Generated<TaskStatusValue>;
  risk_level: Generated<RiskValue>;
  source: 'text' | 'voice' | 'schedule' | 'api';
  language: string | null;
  planner: Json<{
    mode: 'model' | 'offline';
    provider: string | null;
    model: string | null;
  } | null>;
  answer: string | null;
  result_summary: string | null;
  result_summary_message: Json<ServerMessageJson | null> | null;
  evidence: JsonDefault<EvidenceJson[]>;
  error: Json<TaskErrorJson | null>;
  estimated_cost_micro: Generated<number>;
  actual_cost_micro: Generated<number>;
  attempt: Generated<number>;
  cancel_requested_at: NullableTimestamp;
  version: Generated<number>;
  idempotency_key: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  /** Set when the task COMPLETED (0004). */
  outcome: TaskOutcomeValue | null;
  /** Present exactly when outcome = 'question' (0004). */
  question: Json<AssistantQuestionJson | null> | null;
  /** The schedule whose run created this task (0004). */
  schedule_id: string | null;
}

export type MessageKindValue = 'request' | 'answer' | 'question' | 'result';

export interface MessagesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  task_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  language: string | null;
  created_at: Generated<Date>;
  /** 'request' for user messages; answer | question | result for JARVIS's (0004). */
  kind: Generated<MessageKindValue>;
  /** ServerMessage of `content` when the server composed it (0004). */
  content_message: Json<ServerMessageJson | null> | null;
}

export type StepStatusValue =
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'BLOCKED';

export interface PolicyJson {
  decision: 'allow' | 'require_approval' | 'deny';
  reasons: string[];
}

export interface TaskStepsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string;
  position: number;
  step_key: string;
  title: string;
  title_message: Json<ServerMessageJson | null> | null;
  tool_id: string;
  input: Json<Record<string, unknown>>;
  resolved_input: Json<Record<string, unknown> | null> | null;
  input_preview: JsonDefault<Record<string, unknown>>;
  output: Json<Record<string, unknown> | null> | null;
  output_preview: Json<Record<string, unknown> | null> | null;
  status: Generated<StepStatusValue>;
  risk_level: RiskValue;
  requires_approval: Generated<boolean>;
  policy: JsonDefault<PolicyJson>;
  evidence: JsonDefault<EvidenceJson[]>;
  attempts: Generated<number>;
  error: Json<TaskErrorJson | null> | null;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ToolExecutionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string;
  step_id: string;
  tool_id: string;
  tool_version: string;
  idempotency_key: string;
  status: 'started' | 'succeeded' | 'failed' | 'unknown';
  input_hash: string;
  output: Json<Record<string, unknown> | null> | null;
  error: Json<TaskErrorJson | null> | null;
  evidence: JsonDefault<EvidenceJson[]>;
  cost_micro: Generated<number>;
  started_at: Generated<Date>;
  finished_at: NullableTimestamp;
  duration_ms: number | null;
}

export interface ApprovalsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string;
  step_id: string;
  tool_id: string;
  status: Generated<'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'SUPERSEDED'>;
  risk_level: RiskValue;
  summary: string;
  summary_message: Json<ServerMessageJson | null> | null;
  details: Json<Record<string, unknown>>;
  action_hash: string;
  reasons: Generated<string[]>;
  expires_at: Timestamp;
  decided_at: NullableTimestamp;
  decision_note: string | null;
  decision_channel: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TaskEventsTable {
  id: Generated<number>;
  tenant_id: string;
  user_id: string;
  task_id: string | null;
  type: string;
  data: JsonDefault<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export type ConnectionProviderValue = 'web' | 'smtp' | 'google' | 'microsoft';
export type OAuthProviderValue = 'google' | 'microsoft';
export type ConnectionCapabilityValue =
  'mail.read' | 'mail.compose' | 'mail.send' | 'calendar.read' | 'calendar.write';
export type ConnectionStatusReasonValue =
  'GRANT_INVALID' | 'TOKEN_REJECTED' | 'SCOPE_MISSING' | 'PROVIDER_ERROR';

export interface ConnectionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  provider: ConnectionProviderValue;
  label: string;
  account_identifier: string | null;
  permissions: Generated<string[]>;
  status: 'active' | 'error' | 'expired' | 'revoked';
  config: JsonDefault<Record<string, unknown>>;
  /**
   * SMTP: the password envelope (AAD `${user_id}:smtp`). OAuth (0005): one
   * SecretBox envelope of the token set (AAD oauth:<user_id>:<provider>:<id>);
   * deleting the row queues it for revocation (Google).
   */
  secret_ciphertext: Buffer | null;
  secret_key_id: string | null;
  last_verified_at: NullableTimestamp;
  last_error: string | null;
  expires_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** OAuth only (0005): what JARVIS may use (every scope of each granted). */
  capabilities: Generated<ConnectionCapabilityValue[]>;
  /** OAuth only (0005): the scopes the provider reported as granted. */
  granted_scopes: Generated<string[]>;
  /** Why it is not active (0005; SCOPE_MISSING may stay on an active connection). */
  status_reason: ConnectionStatusReasonValue | null;
  /** OAuth only (0005): Google `sub` / Microsoft object id; required while active. */
  provider_account_id: string | null;
  /** OAuth only (0005): expiry of the current access token (refresh before it). */
  token_expires_at: NullableTimestamp;
  token_refreshed_at: NullableTimestamp;
}

export interface MemoriesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  kind: 'preference' | 'fact';
  content: string;
  source: 'user' | 'assistant';
  source_task_id: string | null;
  search: ColumnType<string, never, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type NotificationKindValue =
  | 'approval_requested'
  | 'task_completed'
  | 'task_failed'
  | 'connection_error'
  | 'schedule_failed'
  | 'schedule_paused'
  | 'webhook_disabled'
  // Phase C (0005)
  | 'connection_expired'
  | 'email_reply_received';

export interface NotificationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  kind: NotificationKindValue;
  task_id: string | null;
  data: JsonDefault<Record<string, string>>;
  read_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface VoiceSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  locale: string;
  engine: 'browser_speech' | 'ios_speech' | 'android_speech';
  /** 0008: + 'ended' (a conversation the user ended). */
  outcome: 'submitted' | 'cancelled' | 'error' | 'no_speech' | 'ended' | null;
  transcript_chars: number | null;
  error_code: string | null;
  task_id: string | null;
  started_at: Generated<Date>;
  ended_at: NullableTimestamp;
  // Phase D (0008): conversation mode and its counters (metadata only).
  mode: Generated<'dictation' | 'conversation'>;
  conversation_id: string | null;
  turn_count: number | null;
  barge_in_count: number | null;
  reconnect_count: number | null;
  end_reason:
    | 'end_button'
    | 'escape_key'
    | 'voice_command'
    | 'idle'
    | 'switched_to_text'
    | 'navigation'
    | 'error'
    | null;
}

export interface UsageEventsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string | null;
  kind: 'model_tokens' | 'tool_call';
  provider: string | null;
  model: string | null;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  quantity: Generated<number>;
  created_at: Generated<Date>;
}

export interface CostRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string | null;
  usage_event_id: string | null;
  category: 'model' | 'tool' | 'telephony';
  amount_micro: number;
  currency: Generated<string>;
  created_at: Generated<Date>;
}

export interface AuditEventsTable {
  id: Generated<number>;
  tenant_id: string | null;
  actor_type: 'user' | 'system' | 'agent' | 'admin';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: JsonDefault<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export type JobKind =
  | 'task.plan'
  | 'task.execute'
  | 'approval.expire'
  // Phase B (0004)
  | 'schedule.run'
  | 'retention.sweep'
  | 'webhook.deliver'
  // Phase C (0005). browser.* jobs are leased only by the browser worker.
  | 'email.watch_poll'
  | 'browser.session'
  // Phase D (0008): the call watchdog and the recording download, run by the agent worker.
  | 'call.timeout'
  | 'call.recording_fetch';

export interface JobsTable {
  id: Generated<number>;
  kind: JobKind;
  tenant_id: string;
  user_id: string;
  task_id: string | null;
  payload: JsonDefault<Record<string, unknown>>;
  status: Generated<'queued' | 'running' | 'succeeded' | 'failed' | 'dead'>;
  dedupe_key: string | null;
  run_at: Generated<Date>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  locked_by: string | null;
  locked_until: NullableTimestamp;
  last_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WorkerHeartbeatsTable {
  worker_id: string;
  hostname: string | null;
  version: string | null;
  started_at: Generated<Date>;
  last_heartbeat_at: Generated<Date>;
  /** 'agent' (src/worker.ts) or 'browser' (src/browser-worker.ts) (0005). */
  kind: Generated<'agent' | 'browser'>;
}

export interface FeatureFlagsTable {
  key: string;
  description: string;
  enabled: boolean;
  rules: JsonDefault<Record<string, unknown>>;
  updated_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  user_id: string;
  tenant_id: string;
  route: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: Json<unknown> | null;
  /** When the current claim was taken (a takeover renews it). */
  created_at: Generated<Date>;
  /** Random per claim (0003); null only on rows written before it. */
  claim_token: string | null;
}

/* ------------------------------------------------------------------ */
/* Phase B (0004)                                                      */
/* ------------------------------------------------------------------ */

export type AttachmentMediaTypeValue =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv';

export type StorageDriverValue = 'local' | 's3';

export interface AttachmentsTable {
  /** Generate it before the insert: storage_key must be built from it (CHECK). */
  id: string;
  tenant_id: string;
  user_id: string;
  /** Null until a request uses the file. */
  conversation_id: string | null;
  filename: string;
  media_type: AttachmentMediaTypeValue;
  size_bytes: number;
  sha256: string;
  storage_driver: StorageDriverValue;
  /** Exactly tenants/<tenant_id>/users/<user_id>/attachments/<id> (CHECK). */
  storage_key: string;
  page_count: number | null;
  text_chars: number | null;
  extracted_at: NullableTimestamp;
  /** Set exactly while unattached (CHECK). */
  expires_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TaskAttachmentsTable {
  task_id: string;
  attachment_id: string;
  tenant_id: string;
  user_id: string;
  position: number;
  created_at: Generated<Date>;
}

/** contracts Recurrence as stored (normalised: interval present). */
export interface RecurrenceJson {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
  byMonthDay?: number[];
  time: string;
  timeZone: string;
  until?: string;
  count?: number;
}

export type ScheduleStatusValue = 'active' | 'paused' | 'completed';

export interface ScheduledTasksTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  title: string;
  request: string;
  /** DTSTART;TZID=…\nRRULE:… derived from `recurrence`. */
  rrule: string;
  /** Equals recurrence.timeZone (CHECK). */
  time_zone: string;
  /** Set exactly while status = 'active' (CHECK). */
  next_run_at: NullableTimestamp;
  last_run_at: NullableTimestamp;
  /** Generated: status = 'active'. Read-only. */
  enabled: ColumnType<boolean, never, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  recurrence: Json<RecurrenceJson>;
  status: Generated<ScheduleStatusValue>;
  /** Set exactly while status = 'paused' (CHECK). */
  paused_reason: 'user' | 'failures' | 'budget' | null;
  language: 'en' | 'de' | 'ar' | null;
  conversation_id: string | null;
  created_by: Generated<'user' | 'agent'>;
  created_by_task_id: string | null;
  last_task_id: string | null;
  run_count: Generated<number>;
  consecutive_failures: Generated<number>;
  last_failure_at: NullableTimestamp;
}

export interface ScheduleRunsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  schedule_id: string;
  /** Unique per schedule: each occurrence runs at most once. */
  occurrence_at: Timestamp;
  status: 'created' | 'skipped' | 'failed';
  /** Null exactly when status = 'created' (CHECK). */
  reason: 'BUDGET_EXHAUSTED' | 'SCHEDULE_PAUSED' | 'CREATE_FAILED' | null;
  task_id: string | null;
  created_at: Generated<Date>;
}

export type WebhookEventTypeValue =
  | 'task.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.expired'
  | 'approval.requested'
  | 'approval.decided'
  | 'schedule.triggered'
  | 'schedule.failed';

export type WebhookFailureReasonValue =
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'CONNECT_FAILED'
  | 'TLS_CERTIFICATE'
  | 'HOST_NOT_FOUND'
  | 'PRIVATE_ADDRESS'
  | 'REDIRECT'
  | 'ENDPOINT_DISABLED'
  | 'ENDPOINT_DELETED'
  | 'INTERNAL';

export interface WebhookEndpointsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  url: string;
  description: string | null;
  event_types: WebhookEventTypeValue[];
  status: Generated<'active' | 'disabled'>;
  /** Set exactly while status = 'disabled' (CHECK). */
  disabled_reason: 'user' | 'failures' | null;
  /** SecretBox envelope; AAD webhook:<user_id>:<id>. */
  secret_ciphertext: Buffer;
  secret_key_id: string;
  secret_hint: string;
  consecutive_failures: Generated<number>;
  last_delivery_at: NullableTimestamp;
  last_success_at: NullableTimestamp;
  last_failure_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WebhookDeliveriesTable {
  /** The webhook-id header is 'msg_' + id. */
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  endpoint_id: string;
  event_type: WebhookEventTypeValue | 'webhook.test';
  /** Unique per endpoint (exactly-once enqueue), e.g. 'task.completed:<task id>'. */
  event_key: string;
  /** contracts WebhookPayload — ids, enums and times only. */
  payload: Json<Record<string, unknown>>;
  status: Generated<'pending' | 'succeeded' | 'failed'>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  next_attempt_at: NullableTimestamp;
  last_attempt_at: NullableTimestamp;
  response_status: number | null;
  failure_reason: WebhookFailureReasonValue | null;
  duration_ms: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** Null exactly while status = 'pending' (CHECK). */
  completed_at: NullableTimestamp;
}

/* ------------------------------------------------------------------ */
/* Phase C (0005)                                                      */
/* ------------------------------------------------------------------ */

export interface OAuthStatesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  /** Only this session can complete it. */
  session_id: string;
  provider: OAuthProviderValue;
  capabilities: ConnectionCapabilityValue[];
  requested_scopes: string[];
  /** SHA-256 of the state parameter (32 bytes). */
  state_hash: Buffer;
  /** PKCE verifier, SecretBox envelope (AAD oauth-state:<user_id>:<id>). */
  code_verifier_ciphertext: Buffer;
  code_verifier_key_id: string;
  redirect_uri: string;
  connection_id: string | null;
  return_to: string | null;
  created_at: Generated<Date>;
  /** ≤ created_at + 15 minutes (CHECK); contracts OAUTH_LIMITS.stateTtlMinutes. */
  expires_at: Timestamp;
  /** Single use: set by `UPDATE … WHERE consumed_at IS NULL`. */
  consumed_at: NullableTimestamp;
}

export type EmailWatchStatusValue = 'watching' | 'replied' | 'stopped' | 'expired' | 'failed';

export interface EmailWatchesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  connection_id: string;
  provider: OAuthProviderValue;
  thread_id: string;
  subject: string;
  task_id: string | null;
  /** Unique (one watch per email.track_replies step). */
  step_id: string | null;
  status: Generated<EmailWatchStatusValue>;
  last_seen_message_id: string | null;
  last_seen_at: NullableTimestamp;
  last_checked_at: NullableTimestamp;
  /** Set exactly while status = 'watching' (CHECK). */
  next_check_at: NullableTimestamp;
  consecutive_failures: Generated<number>;
  reply_message_id: string | null;
  reply_from_name: string | null;
  reply_from_address: string | null;
  /** Set exactly while status = 'replied' (CHECK). */
  reply_at: NullableTimestamp;
  expires_at: Timestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type BrowserSessionStatusValue =
  'queued' | 'running' | 'succeeded' | 'failed' | 'handover' | 'interrupted';

export type BrowserStopReasonValue =
  | 'CAPTCHA_DETECTED'
  | 'LOGIN_REQUIRED'
  | 'BOT_PROTECTION'
  | 'SITE_UNSUPPORTED'
  | 'NAVIGATION_BLOCKED'
  | 'PAGE_CHANGED'
  | 'SITE_ERROR'
  | 'BROWSER_BUDGET_EXCEEDED'
  | 'BROWSER_TIMEOUT'
  | 'BROWSER_CRASHED'
  | 'CANCELLED';

/** Created in 0001 (unused); its lifecycle columns since 0005. */
export interface BrowserSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string;
  step_id: string;
  status: BrowserSessionStatusValue;
  /** Always 'ephemeral' (CHECK). */
  isolation_profile: Generated<'ephemeral'>;
  site_id: string;
  operation: string;
  /** Unique per user: one session per tool execution attempt. */
  idempotency_key: string;
  request: Json<Record<string, unknown>>;
  /** Present once succeeded (CHECK). */
  result: Json<Record<string, unknown> | null> | null;
  /** Set exactly for failed / handover (and optionally interrupted) (CHECK). */
  stop_reason: BrowserStopReasonValue | null;
  /** Set exactly while status = 'handover' (CHECK). */
  handover_url: string | null;
  navigations: Generated<number>;
  requests: Generated<number>;
  blocked_requests: Generated<number>;
  worker_id: string | null;
  cancel_requested_at: NullableTimestamp;
  started_at: NullableTimestamp;
  /** Null exactly while queued / running (CHECK). */
  ended_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type EvidenceArtifactKindValue = 'screenshot' | 'extract' | 'ics' | 'recording';
export type EvidenceMediaTypeValue =
  | 'image/png'
  | 'application/json'
  | 'text/calendar'
  | 'audio/mpeg';

export interface EvidenceArtifactsTable {
  /** Generate it before the insert: storage_key must be built from it (CHECK). */
  id: string;
  tenant_id: string;
  user_id: string;
  task_id: string;
  /** Browser evidence; null for a call recording (0008: exactly one of the two, CHECK). */
  browser_session_id: string | null;
  /** 0008: the call a recording belongs to (kind 'recording' ⇔ set). */
  call_session_id: string | null;
  kind: EvidenceArtifactKindValue;
  /** Fixed per kind (CHECK). */
  media_type: EvidenceMediaTypeValue;
  size_bytes: number;
  sha256: string;
  storage_driver: StorageDriverValue;
  /** Exactly tenants/<tenant_id>/users/<user_id>/evidence/<id> (CHECK). */
  storage_key: string;
  page_url: string | null;
  created_at: Generated<Date>;
}

export type OrderStatusValue = 'submitting' | 'placed' | 'failed' | 'unknown';

/** contracts CartLine as stored in orders.items. */
export interface CartLineJson {
  title: string;
  quantity: number;
  unitPrice: { amountMicro: number; currency: string };
  lineTotal: { amountMicro: number; currency: string };
  productUrl: string;
}

export interface OrdersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string | null;
  step_id: string | null;
  site_id: string;
  merchant_name: string;
  merchant_host: string;
  /** Unique per user; sent to the merchant (exactly once on both sides). */
  idempotency_key: string;
  status: Generated<OrderStatusValue>;
  items: Json<CartLineJson[]>;
  currency: string;
  subtotal_micro: number;
  shipping_micro: number;
  tax_micro: number | null;
  total_micro: number;
  /** Set exactly while placed, with placed_at (CHECK). */
  merchant_order_id: string | null;
  placed_at: NullableTimestamp;
  /** A TaskErrorReason; set exactly while failed / unknown (CHECK). */
  failure_reason: string | null;
  approval_id: string | null;
  action_hash: string;
  cart_artifact_id: string | null;
  confirmation_artifact_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type BookingStatusValue = 'submitting' | 'confirmed' | 'failed' | 'unknown' | 'cancelled';

export interface BookingsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string | null;
  step_id: string | null;
  site_id: string;
  site_name: string;
  site_host: string;
  service: string;
  /** Unique per user (exactly once). */
  idempotency_key: string;
  status: Generated<BookingStatusValue>;
  slot_start: Timestamp;
  slot_end: NullableTimestamp;
  time_zone: string;
  /** Required while confirmed (CHECK). */
  reference: string | null;
  price_micro: number | null;
  price_currency: string | null;
  binding: boolean;
  calendar_event_id: string | null;
  failure_reason: string | null;
  approval_id: string | null;
  action_hash: string;
  slots_artifact_id: string | null;
  confirmation_artifact_id: string | null;
  ics_artifact_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** View (security_invoker): orders that are, or may be, committed. Read-only. */
export interface CommittedPurchasesView {
  user_id: ColumnType<string, never, never>;
  currency: ColumnType<string, never, never>;
  total_micro: ColumnType<number, never, never>;
  created_at: ColumnType<Date, never, never>;
  /** Orders: submitting | placed | unknown; paid bookings (0006): submitting | confirmed | unknown. */
  status: ColumnType<'submitting' | 'placed' | 'confirmed' | 'unknown', never, never>;
  /** 0006: what committed the money. */
  kind: ColumnType<'order' | 'booking', never, never>;
  /** 0006: the task step that committed it (null once the task is deleted). */
  step_id: ColumnType<string | null, never, never>;
}

/* ------------------------------------------------------------------ */
/* Phase D (0008): calls, turns, do-not-call, phone verification       */
/* ------------------------------------------------------------------ */

export type CallStatusValue = 'queued' | 'dialing' | 'ringing' | 'in_progress' | 'ended' | 'unknown';
export type CallResultValue =
  | 'completed'
  | 'answered'
  | 'busy'
  | 'no_answer'
  | 'failed'
  | 'voicemail'
  | 'hung_up'
  | 'declined'
  | 'canceled';
export type CallPurposeValue = 'message' | 'availability' | 'questions' | 'appointment';

/** contracts CallStatusEvent, as stored in call_sessions.status_timeline. */
export interface CallStatusEventJson {
  status: CallStatusValue;
  providerStatus: string | null;
  sequence: number | null;
  at: string;
}

/** Rebuilt in 0008 (the 0001 placeholder was never written): one row per call attempt. */
export interface CallSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  task_id: string;
  step_id: string;
  attempt: number;
  /** 'call:<step id>:a<attempt>' — unique per user; inserted before the provider is asked. */
  idempotency_key: string;
  provider: Generated<'twilio'>;
  /** Unique; null until the provider accepted the call (CHECK by status). */
  provider_call_sid: string | null;
  /** SHA-256 of the per-call webhook URL token (unique). */
  webhook_token_hash: Buffer;
  callee_number: string;
  /** HMAC-SHA256 (lib/phone.ts phoneNumberHash). */
  callee_number_hash: Buffer;
  callee_country: string | null;
  callee_name: string | null;
  callee_time_zone: string;
  caller_id: string;
  language: 'en' | 'de' | 'ar';
  purpose: CallPurposeValue;
  dialog_mode: 'scripted' | 'model';
  /** contracts PhoneCallInput (resolved, approved, with its script). */
  request: Json<Record<string, unknown>>;
  status: Generated<CallStatusValue>;
  /** Set exactly when ended (CHECK). */
  result: CallResultValue | null;
  failure_reason: string | null;
  /** contracts CallOutcome; set exactly when ended (CHECK). */
  outcome: Json<Record<string, unknown> | null> | null;
  answered_by: 'human' | 'machine' | 'fax' | 'unknown' | null;
  ai_disclosed_at: NullableTimestamp;
  recording_mode: Generated<'off' | 'if_consented' | 'required'>;
  recording_consent: Generated<'not_asked' | 'accepted' | 'declined'>;
  recording_consent_at: NullableTimestamp;
  /** Only with recording_consent 'accepted' (CHECK). */
  recording_sid: string | null;
  transfer_status: Generated<'none' | 'requested' | 'connected' | 'failed' | 'unavailable'>;
  transfer_at: NullableTimestamp;
  status_timeline: JsonDefault<CallStatusEventJson[]>;
  last_status_sequence: number | null;
  turn_count: Generated<number>;
  max_duration_seconds: number;
  duration_seconds: number | null;
  cost_estimate_micro: number | null;
  price_micro: number | null;
  price_currency: string | null;
  approval_id: string | null;
  action_hash: string;
  dialed_at: NullableTimestamp;
  answered_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type CallTurnKindValue =
  | 'disclosure'
  | 'consent_request'
  | 'consent_reply'
  | 'question'
  | 'answer'
  | 'statement'
  | 'clarification'
  | 'refusal'
  | 'transfer'
  | 'voicemail'
  | 'goodbye';

export interface CallTurnsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  call_session_id: string;
  /** Unique per call. */
  sequence: number;
  speaker: 'agent' | 'callee' | 'system';
  kind: CallTurnKindValue;
  text: string;
  language: 'en' | 'de' | 'ar';
  /** Callee turns only (CHECK). */
  confidence: number | null;
  flagged: Generated<boolean>;
  injection_signals: Generated<string[]>;
  created_at: Generated<Date>;
}

export interface DoNotCallTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  /** HMAC-SHA256 of the E.164 number; unique per user. */
  number_hash: Buffer;
  number_masked: string;
  /** SecretBox envelope of the number (AAD dnc:<user id>:<id>), for key rotation only. */
  number_ciphertext: Buffer;
  number_key_id: string;
  country: string | null;
  source: 'callee_request' | 'user';
  call_session_id: string | null;
  created_at: Generated<Date>;
}

export interface PhoneVerificationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  phone_number: string;
  /** SecretBox envelope of the code (AAD phone-verification:<user id>:<id>). */
  code_ciphertext: Buffer;
  code_key_id: string;
  status: Generated<'calling' | 'pending' | 'verified' | 'expired' | 'failed'>;
  attempts: Generated<number>;
  provider_call_sid: string | null;
  webhook_token_hash: Buffer;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** At most created_at + 15 minutes (CHECK). */
  expires_at: Timestamp;
  /** Set exactly when verified (CHECK). */
  verified_at: NullableTimestamp;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  tenant_id: string;
  plan: Generated<string>;
  status: Generated<'trialing' | 'active' | 'past_due' | 'cancelled'>;
  current_period_start: NullableTimestamp;
  current_period_end: NullableTimestamp;
  provider: string | null;
  provider_ref: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  user_roles: UserRolesTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  conversations: ConversationsTable;
  tasks: TasksTable;
  messages: MessagesTable;
  task_steps: TaskStepsTable;
  tool_executions: ToolExecutionsTable;
  approvals: ApprovalsTable;
  task_events: TaskEventsTable;
  connections: ConnectionsTable;
  memories: MemoriesTable;
  notifications: NotificationsTable;
  voice_sessions: VoiceSessionsTable;
  usage_events: UsageEventsTable;
  cost_records: CostRecordsTable;
  audit_events: AuditEventsTable;
  jobs: JobsTable;
  worker_heartbeats: WorkerHeartbeatsTable;
  feature_flags: FeatureFlagsTable;
  idempotency_keys: IdempotencyKeysTable;
  subscriptions: SubscriptionsTable;
  // Phase B (0004). storage_deletions is not listed: only SECURITY DEFINER
  // functions reach it (storage_deletions_claim / _complete / _failed).
  attachments: AttachmentsTable;
  task_attachments: TaskAttachmentsTable;
  scheduled_tasks: ScheduledTasksTable;
  schedule_runs: ScheduleRunsTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  // Phase C (0005). oauth_revocations is not listed: only SECURITY DEFINER
  // functions reach it (oauth_revocations_claim / _complete / _failed, and 0007
  // oauth_revocations_cancel for the caller's own pending rows of one account).
  oauth_states: OAuthStatesTable;
  email_watches: EmailWatchesTable;
  browser_sessions: BrowserSessionsTable;
  evidence_artifacts: EvidenceArtifactsTable;
  orders: OrdersTable;
  bookings: BookingsTable;
  committed_purchases: CommittedPurchasesView;
  // Phase D (0008). Webhooks reach the owner's context through telephony_webhook_target().
  call_sessions: CallSessionsTable;
  call_turns: CallTurnsTable;
  do_not_call: DoNotCallTable;
  phone_verifications: PhoneVerificationsTable;
}

export type TaskRow = Selectable<TasksTable>;
export type StepRow = Selectable<TaskStepsTable>;
export type ApprovalRow = Selectable<ApprovalsTable>;
export type ConnectionRow = Selectable<ConnectionsTable>;
export type ToolExecutionRow = Selectable<ToolExecutionsTable>;
export type MemoryRow = Selectable<MemoriesTable>;
export type UserRow = Selectable<UsersTable>;
export type JobRow = Selectable<JobsTable>;
export type AttachmentRow = Selectable<AttachmentsTable>;
export type ScheduleRow = Selectable<ScheduledTasksTable>;
export type ScheduleRunRow = Selectable<ScheduleRunsTable>;
export type WebhookEndpointRow = Selectable<WebhookEndpointsTable>;
export type WebhookDeliveryRow = Selectable<WebhookDeliveriesTable>;
export type MessageRow = Selectable<MessagesTable>;
export type ConversationRow = Selectable<ConversationsTable>;
export type OAuthStateRow = Selectable<OAuthStatesTable>;
export type EmailWatchRow = Selectable<EmailWatchesTable>;
export type BrowserSessionRow = Selectable<BrowserSessionsTable>;
export type EvidenceArtifactRow = Selectable<EvidenceArtifactsTable>;
export type OrderRow = Selectable<OrdersTable>;
export type BookingRow = Selectable<BookingsTable>;
export type CallSessionRow = Selectable<CallSessionsTable>;
export type CallTurnRow = Selectable<CallTurnsTable>;
export type DoNotCallRow = Selectable<DoNotCallTable>;
export type PhoneVerificationRow = Selectable<PhoneVerificationsTable>;
export type VoiceSessionRow = Selectable<VoiceSessionsTable>;
export type NewTask = Insertable<TasksTable>;
export type NewStep = Insertable<TaskStepsTable>;
export type TaskUpdate = Updateable<TasksTable>;
