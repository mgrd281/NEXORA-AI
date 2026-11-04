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

export interface ConnectionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  provider: 'web' | 'smtp';
  label: string;
  account_identifier: string | null;
  permissions: Generated<string[]>;
  status: 'active' | 'error' | 'expired' | 'revoked';
  config: JsonDefault<Record<string, unknown>>;
  secret_ciphertext: Buffer | null;
  secret_key_id: string | null;
  last_verified_at: NullableTimestamp;
  last_error: string | null;
  expires_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  | 'webhook_disabled';

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
  outcome: 'submitted' | 'cancelled' | 'error' | 'no_speech' | null;
  transcript_chars: number | null;
  error_code: string | null;
  task_id: string | null;
  started_at: Generated<Date>;
  ended_at: NullableTimestamp;
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
  | 'webhook.deliver';

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
export type NewTask = Insertable<TasksTable>;
export type NewStep = Insertable<TaskStepsTable>;
export type TaskUpdate = Updateable<TasksTable>;
