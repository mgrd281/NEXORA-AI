import { z } from 'zod';
import { AttachmentMediaType, EvidenceMediaType, SkillId } from './enums';
import { ATTACHMENT_LIMITS, ATTACHMENT_UPLOAD_FIELD } from './limits';
import {
  AdminOverview,
  AdminUser,
  Approval,
  ApprovalDecisionRequest,
  AssistantStatus,
  Attachment,
  AuditEvent,
  Booking,
  BookingListQuery,
  CalendarEventList,
  CalendarEventListQuery,
  CallListQuery,
  CallSession,
  CallSummary,
  ConfirmPhoneVerificationRequest,
  Connection,
  ConnectionProviderInfo,
  ConversationDetail,
  ConversationDetailQuery,
  ConversationListQuery,
  ConversationSummary,
  CreateMemoryRequest,
  CreateScheduleRequest,
  CreateSmtpConnectionRequest,
  CreateTaskRequest,
  CreateWebhookRequest,
  DeleteAccountRequest,
  DoNotCallEntry,
  EmailWatch,
  EvidenceArtifact,
  FollowUpRequest,
  HomeSnapshot,
  LoginRequest,
  LoginResponse,
  Me,
  Memory,
  MemoryListQuery,
  Notification,
  OAuthCallbackRequest,
  OAuthCallbackResult,
  OAuthStartRequest,
  OAuthStartResponse,
  Order,
  OrderListQuery,
  Page,
  PageQuery,
  PhoneVerification,
  PhoneVerificationState,
  RetryTaskRequest,
  Schedule,
  ScheduleDetail,
  SchedulePreview,
  SchedulePreviewRequest,
  SessionInfo,
  Skill,
  TaskDetail,
  TaskListQuery,
  TaskSummary,
  TimeZoneInfo,
  UpdateMeRequest,
  UpdateMemoryRequest,
  UpdateScheduleRequest,
  UpdateSkillRequest,
  UpdateWebhookRequest,
  UpcomingEvents,
  UsageSummary,
  VoiceSession,
  VoiceSessionEnd,
  VoiceSessionStart,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from './schemas';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A multipart/form-data request carrying one file (instead of a JSON body). */
export interface UploadSpec {
  /** Name of the file field. */
  field: string;
  maxBytes: number;
  /** Media types accepted (identified from the content by the server). */
  mediaTypes: readonly string[];
}

export interface RouteDef {
  method: HttpMethod;
  /** Fastify-style path, e.g. /v1/tasks/:id */
  path: string;
  summary: string;
  tag: string;
  auth: 'none' | 'user' | 'platform_admin';
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /**
   * The request is multipart/form-data with one file (Phase B). Mutually
   * exclusive with `body`; the handler reads the file part itself.
   */
  upload?: UploadSpec;
  /**
   * The success response is a file (one of these media types), streamed by
   * the handler with Content-Disposition: attachment. `response` is then null
   * and `successStatus` 200.
   */
  download?: { mediaTypes: readonly string[] };
  /** Response body for the success status. `null` = 204 No Content (or a `download`). */
  response: z.ZodType | null;
  successStatus?: 200 | 201 | 202 | 204;
  /** Mutations that accept an Idempotency-Key header. */
  idempotent?: boolean;
}

const IdParams = z.object({ id: z.uuid() });
const SkillParams = z.object({ id: SkillId });
const Ok = z.object({ ok: z.literal(true) });

/**
 * Every HTTP endpoint of API v1. The server registers handlers against this
 * table (and fails to boot if one is missing); OpenAPI is generated from it.
 */
export const routes = {
  // Auth
  login: {
    method: 'POST',
    path: '/v1/auth/login',
    summary: 'Sign in with email and password',
    tag: 'auth',
    auth: 'none',
    body: LoginRequest,
    response: LoginResponse,
  },
  logout: {
    method: 'POST',
    path: '/v1/auth/logout',
    summary: 'Sign out and revoke the current session',
    tag: 'auth',
    auth: 'user',
    response: null,
    successStatus: 204,
  },
  listSessions: {
    method: 'GET',
    path: '/v1/auth/sessions',
    summary: 'List active sessions and devices',
    tag: 'auth',
    auth: 'user',
    response: z.object({ items: z.array(SessionInfo) }),
  },
  revokeSession: {
    method: 'DELETE',
    path: '/v1/auth/sessions/:id',
    summary: 'Revoke a session',
    tag: 'auth',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },

  // Me / account
  getMe: {
    method: 'GET',
    path: '/v1/me',
    summary: 'Current user profile and preferences',
    tag: 'account',
    auth: 'user',
    response: Me,
  },
  updateMe: {
    method: 'PATCH',
    path: '/v1/me',
    summary: 'Update profile and preferences',
    tag: 'account',
    auth: 'user',
    body: UpdateMeRequest,
    response: Me,
  },
  exportAccount: {
    method: 'POST',
    path: '/v1/account/export',
    summary: 'Export all personal data as JSON (GDPR Art. 20)',
    tag: 'account',
    auth: 'user',
    response: z.record(z.string(), z.unknown()),
  },
  deleteAccount: {
    method: 'POST',
    path: '/v1/account/delete',
    summary: 'Permanently delete the account and its data',
    tag: 'account',
    auth: 'user',
    body: DeleteAccountRequest,
    response: null,
    successStatus: 204,
  },

  // Home & system
  getHome: {
    method: 'GET',
    path: '/v1/home',
    summary: 'Home snapshot: approvals, active work, recent results, suggestions',
    tag: 'home',
    auth: 'user',
    response: HomeSnapshot,
  },
  getAssistantStatus: {
    method: 'GET',
    path: '/v1/assistant/status',
    summary: 'Real capability and health status of the assistant',
    tag: 'home',
    auth: 'user',
    response: AssistantStatus,
  },
  getUsage: {
    method: 'GET',
    path: '/v1/usage',
    summary: 'Usage and cost for the current month',
    tag: 'home',
    auth: 'user',
    response: UsageSummary,
  },

  // Tasks
  createTask: {
    method: 'POST',
    path: '/v1/tasks',
    summary: 'Submit a request; JARVIS plans and executes it',
    tag: 'tasks',
    auth: 'user',
    body: CreateTaskRequest,
    response: TaskSummary,
    successStatus: 202,
    idempotent: true,
  },
  listTasks: {
    method: 'GET',
    path: '/v1/tasks',
    summary: 'List tasks',
    tag: 'tasks',
    auth: 'user',
    query: TaskListQuery,
    response: Page(TaskSummary),
  },
  getTask: {
    method: 'GET',
    path: '/v1/tasks/:id',
    summary: 'Task detail with steps, approvals, evidence and history',
    tag: 'tasks',
    auth: 'user',
    params: IdParams,
    response: TaskDetail,
  },
  cancelTask: {
    method: 'POST',
    path: '/v1/tasks/:id/cancel',
    summary: 'Cancel a task',
    tag: 'tasks',
    auth: 'user',
    params: IdParams,
    response: TaskSummary,
  },
  retryTask: {
    method: 'POST',
    path: '/v1/tasks/:id/retry',
    summary: 'Retry a failed or expired task from the failed step',
    tag: 'tasks',
    auth: 'user',
    params: IdParams,
    body: RetryTaskRequest,
    response: TaskSummary,
    successStatus: 202,
    idempotent: true,
  },

  // Approvals
  listApprovals: {
    method: 'GET',
    path: '/v1/approvals',
    summary: 'Pending approvals',
    tag: 'approvals',
    auth: 'user',
    response: z.object({ items: z.array(Approval) }),
  },
  decideApproval: {
    method: 'POST',
    path: '/v1/approvals/:id/decision',
    summary: 'Approve or reject an action',
    tag: 'approvals',
    auth: 'user',
    params: IdParams,
    body: ApprovalDecisionRequest,
    response: Approval,
    idempotent: true,
  },

  // Connections
  listConnections: {
    method: 'GET',
    path: '/v1/connections',
    summary: 'Connected services',
    tag: 'connections',
    auth: 'user',
    response: z.object({ items: z.array(Connection) }),
  },
  connectSmtp: {
    method: 'POST',
    path: '/v1/connections/smtp',
    summary: 'Connect an SMTP mailbox (verified before saving)',
    tag: 'connections',
    auth: 'user',
    body: CreateSmtpConnectionRequest,
    response: Connection,
    successStatus: 201,
  },
  enableWebAccess: {
    method: 'POST',
    path: '/v1/connections/web',
    summary: 'Allow JARVIS to read public web pages',
    tag: 'connections',
    auth: 'user',
    response: Connection,
    successStatus: 201,
  },
  testConnection: {
    method: 'POST',
    path: '/v1/connections/:id/test',
    summary: 'Re-verify a connection',
    tag: 'connections',
    auth: 'user',
    params: IdParams,
    response: Connection,
  },
  deleteConnection: {
    method: 'DELETE',
    path: '/v1/connections/:id',
    summary: 'Disconnect and erase stored credentials',
    tag: 'connections',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },

  // Memory
  listMemories: {
    method: 'GET',
    path: '/v1/memories',
    summary: 'List or search memories',
    tag: 'memory',
    auth: 'user',
    query: MemoryListQuery,
    response: Page(Memory),
  },
  createMemory: {
    method: 'POST',
    path: '/v1/memories',
    summary: 'Save a memory',
    tag: 'memory',
    auth: 'user',
    body: CreateMemoryRequest,
    response: Memory,
    successStatus: 201,
  },
  updateMemory: {
    method: 'PATCH',
    path: '/v1/memories/:id',
    summary: 'Correct a memory',
    tag: 'memory',
    auth: 'user',
    params: IdParams,
    body: UpdateMemoryRequest,
    response: Memory,
  },
  deleteMemory: {
    method: 'DELETE',
    path: '/v1/memories/:id',
    summary: 'Delete a memory',
    tag: 'memory',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },
  deleteAllMemories: {
    method: 'DELETE',
    path: '/v1/memories',
    summary: 'Delete all memories',
    tag: 'memory',
    auth: 'user',
    response: z.object({ deleted: z.number().int() }),
  },

  // Notifications
  listNotifications: {
    method: 'GET',
    path: '/v1/notifications',
    summary: 'Notifications',
    tag: 'notifications',
    auth: 'user',
    query: PageQuery,
    response: Page(Notification),
  },
  markNotificationsRead: {
    method: 'POST',
    path: '/v1/notifications/read',
    summary: 'Mark notifications read',
    tag: 'notifications',
    auth: 'user',
    body: z.object({ ids: z.array(z.uuid()).max(200).optional() }),
    response: Ok,
  },

  // Voice (metadata only — audio never leaves the device in this build)
  startVoiceSession: {
    method: 'POST',
    path: '/v1/voice-sessions',
    summary: 'Record the start of a voice session',
    tag: 'voice',
    auth: 'user',
    body: VoiceSessionStart,
    response: VoiceSession,
    successStatus: 201,
  },
  endVoiceSession: {
    method: 'POST',
    path: '/v1/voice-sessions/:id/end',
    summary: 'Record the end of a voice session',
    tag: 'voice',
    auth: 'user',
    params: IdParams,
    body: VoiceSessionEnd,
    response: VoiceSession,
  },

  // Admin (platform_admin only; aggregates, never content)
  adminOverview: {
    method: 'GET',
    path: '/v1/admin/overview',
    summary: 'System health, reliability and cost aggregates',
    tag: 'admin',
    auth: 'platform_admin',
    response: AdminOverview,
  },
  adminUsers: {
    method: 'GET',
    path: '/v1/admin/users',
    summary: 'Users (no conversation content)',
    tag: 'admin',
    auth: 'platform_admin',
    query: PageQuery,
    response: Page(AdminUser),
  },
  adminAudit: {
    method: 'GET',
    path: '/v1/admin/audit',
    summary: 'Audit log',
    tag: 'admin',
    auth: 'platform_admin',
    query: PageQuery,
    response: Page(AuditEvent),
  },

  /* ---------------------------------------------------------------- */
  /* Phase B (docs/architecture/phase-b.md)                            */
  /* ---------------------------------------------------------------- */

  // Conversations
  listConversations: {
    method: 'GET',
    path: '/v1/conversations',
    summary: 'Conversation history, most recent activity first',
    tag: 'conversations',
    auth: 'user',
    query: ConversationListQuery,
    response: Page(ConversationSummary),
  },
  getConversation: {
    method: 'GET',
    path: '/v1/conversations/:id',
    summary: 'A conversation thread: requests, tasks and JARVIS messages in order',
    tag: 'conversations',
    auth: 'user',
    params: IdParams,
    query: ConversationDetailQuery,
    response: ConversationDetail,
  },
  followUp: {
    method: 'POST',
    path: '/v1/conversations/:id/messages',
    summary: 'Send a follow-up: a new task in this conversation, planned with its earlier turns',
    tag: 'conversations',
    auth: 'user',
    params: IdParams,
    body: FollowUpRequest,
    response: TaskSummary,
    successStatus: 202,
    idempotent: true,
  },
  deleteConversation: {
    method: 'DELETE',
    path: '/v1/conversations/:id',
    summary: 'Delete a conversation with its tasks, messages and files',
    tag: 'conversations',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },

  // Attachments
  uploadAttachment: {
    method: 'POST',
    path: '/v1/attachments',
    summary: 'Upload a file (PDF, DOCX, TXT, MD, CSV) to attach to a request',
    tag: 'attachments',
    auth: 'user',
    upload: {
      field: ATTACHMENT_UPLOAD_FIELD,
      maxBytes: ATTACHMENT_LIMITS.maxBytes,
      mediaTypes: AttachmentMediaType.options,
    },
    response: Attachment,
    successStatus: 201,
  },
  getAttachment: {
    method: 'GET',
    path: '/v1/attachments/:id',
    summary: 'File metadata',
    tag: 'attachments',
    auth: 'user',
    params: IdParams,
    response: Attachment,
  },
  downloadAttachment: {
    method: 'GET',
    path: '/v1/attachments/:id/content',
    summary: 'Download a file (its owner only)',
    tag: 'attachments',
    auth: 'user',
    params: IdParams,
    download: { mediaTypes: AttachmentMediaType.options },
    response: null,
    successStatus: 200,
  },
  deleteAttachment: {
    method: 'DELETE',
    path: '/v1/attachments/:id',
    summary: 'Delete a file (tasks that used it keep their results)',
    tag: 'attachments',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },

  // Skills
  listSkills: {
    method: 'GET',
    path: '/v1/skills',
    summary: 'Skills catalog with real availability for the signed-in user',
    tag: 'skills',
    auth: 'user',
    response: z.object({ items: z.array(Skill) }),
  },
  updateSkill: {
    method: 'PATCH',
    path: '/v1/skills/:id',
    summary: 'Turn a skill on or off (never grants permissions)',
    tag: 'skills',
    auth: 'user',
    params: SkillParams,
    body: UpdateSkillRequest,
    response: Skill,
  },

  // Schedules
  listSchedules: {
    method: 'GET',
    path: '/v1/schedules',
    summary: 'Scheduled requests',
    tag: 'schedules',
    auth: 'user',
    response: z.object({ items: z.array(Schedule) }),
  },
  createSchedule: {
    method: 'POST',
    path: '/v1/schedules',
    summary: 'Schedule a request on a recurrence',
    tag: 'schedules',
    auth: 'user',
    body: CreateScheduleRequest,
    response: Schedule,
    successStatus: 201,
    idempotent: true,
  },
  previewSchedule: {
    method: 'POST',
    path: '/v1/schedules/preview',
    summary: 'The RRULE and next occurrences of a recurrence (nothing is saved)',
    tag: 'schedules',
    auth: 'user',
    body: SchedulePreviewRequest,
    response: SchedulePreview,
  },
  getSchedule: {
    method: 'GET',
    path: '/v1/schedules/:id',
    summary: 'A schedule with its upcoming occurrences and recent runs',
    tag: 'schedules',
    auth: 'user',
    params: IdParams,
    response: ScheduleDetail,
  },
  updateSchedule: {
    method: 'PATCH',
    path: '/v1/schedules/:id',
    summary: 'Change a schedule (the next run is recomputed)',
    tag: 'schedules',
    auth: 'user',
    params: IdParams,
    body: UpdateScheduleRequest,
    response: Schedule,
  },
  deleteSchedule: {
    method: 'DELETE',
    path: '/v1/schedules/:id',
    summary: 'Delete a schedule (tasks it created stay)',
    tag: 'schedules',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },
  pauseSchedule: {
    method: 'POST',
    path: '/v1/schedules/:id/pause',
    summary: 'Pause a schedule',
    tag: 'schedules',
    auth: 'user',
    params: IdParams,
    response: Schedule,
  },
  resumeSchedule: {
    method: 'POST',
    path: '/v1/schedules/:id/resume',
    summary: 'Resume a paused schedule from the next occurrence',
    tag: 'schedules',
    auth: 'user',
    params: IdParams,
    response: Schedule,
  },

  // Webhooks (outbound)
  listWebhooks: {
    method: 'GET',
    path: '/v1/webhooks',
    summary: 'Webhook endpoints',
    tag: 'webhooks',
    auth: 'user',
    response: z.object({ items: z.array(WebhookEndpoint) }),
  },
  createWebhook: {
    method: 'POST',
    path: '/v1/webhooks',
    summary: 'Register a webhook endpoint (the signing secret is returned once)',
    tag: 'webhooks',
    auth: 'user',
    body: CreateWebhookRequest,
    response: WebhookEndpointWithSecret,
    successStatus: 201,
  },
  updateWebhook: {
    method: 'PATCH',
    path: '/v1/webhooks/:id',
    summary: 'Change, disable or re-enable a webhook endpoint',
    tag: 'webhooks',
    auth: 'user',
    params: IdParams,
    body: UpdateWebhookRequest,
    response: WebhookEndpoint,
  },
  deleteWebhook: {
    method: 'DELETE',
    path: '/v1/webhooks/:id',
    summary: 'Delete a webhook endpoint and its delivery log',
    tag: 'webhooks',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },
  rotateWebhookSecret: {
    method: 'POST',
    path: '/v1/webhooks/:id/rotate-secret',
    summary: 'Replace the signing secret (the new one is returned once)',
    tag: 'webhooks',
    auth: 'user',
    params: IdParams,
    response: WebhookEndpointWithSecret,
  },
  testWebhook: {
    method: 'POST',
    path: '/v1/webhooks/:id/test',
    summary: 'Queue a signed webhook.test delivery to the endpoint',
    tag: 'webhooks',
    auth: 'user',
    params: IdParams,
    response: WebhookDelivery,
    successStatus: 202,
  },
  listWebhookDeliveries: {
    method: 'GET',
    path: '/v1/webhooks/:id/deliveries',
    summary: 'Delivery log of an endpoint (newest first)',
    tag: 'webhooks',
    auth: 'user',
    params: IdParams,
    query: PageQuery,
    response: Page(WebhookDelivery),
  },

  // Meta
  listTimeZones: {
    method: 'GET',
    path: '/v1/meta/time-zones',
    summary: 'Time zones the server accepts (known to both the database and the runtime)',
    tag: 'meta',
    auth: 'user',
    response: z.object({ items: z.array(TimeZoneInfo) }),
  },

  /* ---------------------------------------------------------------- */
  /* Phase C (docs/architecture/phase-c.md)                            */
  /* ---------------------------------------------------------------- */

  // Connections (OAuth 2.0: Google, Microsoft)
  listConnectionProviders: {
    method: 'GET',
    path: '/v1/connections/providers',
    summary:
      'Connection providers on this server: configured or not, capabilities and their scopes',
    tag: 'connections',
    auth: 'user',
    response: z.object({ items: z.array(ConnectionProviderInfo) }),
  },
  startOAuthConnection: {
    method: 'POST',
    path: '/v1/connections/oauth/start',
    summary:
      'Start connecting (or reconnecting) a Google or Microsoft account: authorization code with PKCE',
    tag: 'connections',
    auth: 'user',
    body: OAuthStartRequest,
    response: OAuthStartResponse,
  },
  completeOAuthConnection: {
    method: 'POST',
    path: '/v1/connections/oauth/callback',
    summary:
      'Finish connecting: the provider redirect forwarded by the client (same session, single use)',
    tag: 'connections',
    auth: 'user',
    body: OAuthCallbackRequest,
    response: OAuthCallbackResult,
  },

  // Calendar (live from the provider)
  listUpcomingEvents: {
    method: 'GET',
    path: '/v1/calendar/upcoming',
    summary: 'The next events of the connected calendars (upcoming null when none is connected)',
    tag: 'calendar',
    auth: 'user',
    response: z.object({ upcoming: UpcomingEvents.nullable() }),
  },
  listCalendarEvents: {
    method: 'GET',
    path: '/v1/calendar/events',
    summary: 'Events of the connected calendars in a time window',
    tag: 'calendar',
    auth: 'user',
    query: CalendarEventListQuery,
    response: CalendarEventList,
  },

  // Email reply tracking
  listEmailWatches: {
    method: 'GET',
    path: '/v1/email/watches',
    summary: 'Threads JARVIS watches for replies',
    tag: 'email',
    auth: 'user',
    response: z.object({ items: z.array(EmailWatch) }),
  },
  deleteEmailWatch: {
    method: 'DELETE',
    path: '/v1/email/watches/:id',
    summary: 'Stop watching a thread for replies',
    tag: 'email',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },

  // Orders and bookings (records of what the agent did; read-only)
  listOrders: {
    method: 'GET',
    path: '/v1/orders',
    summary: 'Orders JARVIS placed or tried to place, newest first',
    tag: 'commerce',
    auth: 'user',
    query: OrderListQuery,
    response: Page(Order),
  },
  getOrder: {
    method: 'GET',
    path: '/v1/orders/:id',
    summary: 'An order with its evidence',
    tag: 'commerce',
    auth: 'user',
    params: IdParams,
    response: Order,
  },
  listBookings: {
    method: 'GET',
    path: '/v1/bookings',
    summary: 'Appointments JARVIS booked or tried to book, newest first',
    tag: 'commerce',
    auth: 'user',
    query: BookingListQuery,
    response: Page(Booking),
  },
  getBooking: {
    method: 'GET',
    path: '/v1/bookings/:id',
    summary: 'A booking with its evidence',
    tag: 'commerce',
    auth: 'user',
    params: IdParams,
    response: Booking,
  },

  // Evidence files of the browser agent
  getEvidence: {
    method: 'GET',
    path: '/v1/evidence/:id',
    summary: 'Evidence file metadata',
    tag: 'evidence',
    auth: 'user',
    params: IdParams,
    response: EvidenceArtifact,
  },
  downloadEvidence: {
    method: 'GET',
    path: '/v1/evidence/:id/content',
    summary: 'Download an evidence file (screenshot, extracted data, ICS) — its owner only',
    tag: 'evidence',
    auth: 'user',
    params: IdParams,
    download: { mediaTypes: EvidenceMediaType.options },
    response: null,
    successStatus: 200,
  },

  /* ---------------------------------------------------------------- */
  /* Phase D (docs/architecture/phase-d.md). The provider's webhooks    */
  /* (unauthenticated, signature-validated) are a separate table:       */
  /* telephonyWebhookRoutes (telephony-webhooks.ts).                    */
  /* ---------------------------------------------------------------- */

  // Calls JARVIS placed (records of what the agent did; read-only)
  listCalls: {
    method: 'GET',
    path: '/v1/calls',
    summary: 'Phone calls JARVIS placed or tried to place, newest first',
    tag: 'calls',
    auth: 'user',
    query: CallListQuery,
    response: Page(CallSummary),
  },
  getCall: {
    method: 'GET',
    path: '/v1/calls/:id',
    summary: 'A call with its status timeline, every turn, outcome and evidence',
    tag: 'calls',
    auth: 'user',
    params: IdParams,
    response: CallSession,
  },

  // Numbers JARVIS will not call (only hashes are stored)
  listDoNotCall: {
    method: 'GET',
    path: '/v1/do-not-call',
    summary: 'Numbers JARVIS will not call for you (masked), and why',
    tag: 'calls',
    auth: 'user',
    response: z.object({ items: z.array(DoNotCallEntry) }),
  },
  deleteDoNotCall: {
    method: 'DELETE',
    path: '/v1/do-not-call/:id',
    summary: 'Remove a number from the do-not-call list (audited)',
    tag: 'calls',
    auth: 'user',
    params: IdParams,
    response: null,
    successStatus: 204,
  },

  // The account's own phone number: verification by a call that reads a code
  getPhoneVerification: {
    method: 'GET',
    path: '/v1/me/phone/verification',
    summary: 'The verification call in progress (or that just failed), if any',
    tag: 'account',
    auth: 'user',
    response: PhoneVerificationState,
  },
  startPhoneVerification: {
    method: 'POST',
    path: '/v1/me/phone/verification',
    summary: 'Call the account’s phone number and read out a verification code',
    tag: 'account',
    auth: 'user',
    response: PhoneVerification,
    successStatus: 201,
  },
  confirmPhoneVerification: {
    method: 'POST',
    path: '/v1/me/phone/verification/confirm',
    summary: 'Confirm the code from the verification call (the number becomes verified)',
    tag: 'account',
    auth: 'user',
    body: ConfirmPhoneVerificationRequest,
    response: Me,
  },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof routes;

/** Server-Sent Events endpoint (not in the JSON route table). Supports Last-Event-ID. */
export const EVENTS_PATH = '/v1/events';

type Def<N extends RouteName> = (typeof routes)[N];
export type RouteBody<N extends RouteName> =
  Def<N> extends { body: infer B extends z.ZodType } ? z.input<B> : never;
export type RouteQuery<N extends RouteName> =
  Def<N> extends { query: infer Q extends z.ZodType } ? z.input<Q> : never;
export type RouteResponse<N extends RouteName> = Def<N>['response'] extends z.ZodType
  ? z.output<Def<N>['response']>
  : void;

/** Build a concrete URL path from a route and its params. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`Missing path param ${k} for ${path}`);
    return encodeURIComponent(v);
  });
}
