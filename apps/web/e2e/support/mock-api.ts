/**
 * Contract-validated mock of the JARVIS API for visual and component tests.
 *
 *   const api = await mockApi(page, { locale: 'ar' });
 *   await signInWithMock(context);           // sets the session/locale/theme cookies
 *   await page.goto('/');
 *   expect(api.errors).toEqual([]);          // no invalid request bodies, no unmocked routes
 *
 * Every fixture is parsed with its contract schema when loaded, every request body is parsed
 * with the route's body schema, and every response is parsed with the route's response schema
 * before it is served — mocks cannot drift from packages/contracts. The SSE stream
 * (/api/v1/events) is held open without events, so the app looks connected.
 *
 * This is only for visual/component tests. End-to-end tests run against the real API.
 */
import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import {
  CALL_LIMITS,
  E164PhoneNumber,
  AdminOverview,
  Approval,
  ATTACHMENT_EXTENSIONS,
  Attachment,
  AssistantStatus,
  Booking,
  CallSession,
  Connection,
  DoNotCallEntry,
  PhoneVerification,
  ConnectionProviderInfo,
  EmailWatch,
  EvidenceArtifact,
  Order,
  ConversationMessage,
  EVENTS_PATH,
  HomeSnapshot,
  isTerminal,
  Me,
  Memory,
  Notification,
  routes,
  Schedule,
  ScheduleRun,
  SCHEDULE_LIMITS,
  SessionInfo,
  Skill,
  TaskDetail,
  TaskSummary,
  TimeZoneInfo,
  UsageSummary,
  WEBHOOK_LIMITS,
  WebhookDelivery,
  WebhookEndpoint,
  type AttachmentMediaType,
  type Recurrence,
  type RouteName,
} from '@jarvis/contracts';
import { z } from 'zod';
import { buildFixtures, type FixtureOptions, type Fixtures } from './fixtures';
import { evidenceBytes, FIXTURE_HOST } from './phase-c';
import {
  conversationList,
  conversationOf,
  derivedId,
  nextOccurrences,
  rruleFor,
  skillsFor,
  tasksOf,
} from './phase-b';

export interface MockRequest {
  name: RouteName;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  request: Request;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  /** A file response (download routes) instead of JSON. */
  raw?: { body: Buffer | string; contentType: string; headers?: Record<string, string> };
  /** Delay before responding (ms), e.g. to capture loading states. */
  delayMs?: number;
}

export type MockHandler = (
  req: MockRequest,
  state: Fixtures,
) => MockResponse | Promise<MockResponse>;

export interface MockApiOptions extends FixtureOptions {
  /** Replace or extend the fixture data before validation. */
  fixtures?: (f: Fixtures) => Fixtures;
  /** Per-route handlers that take precedence over the defaults. */
  overrides?: Partial<Record<RouteName, MockHandler>>;
}

export interface MockApi {
  state: Fixtures;
  /** Problems seen while serving (invalid request bodies, unmocked routes, bad responses). */
  errors: string[];
  /** Route names in the order they were called. */
  calls: RouteName[];
}

const FixtureSchema = z.object({
  me: Me,
  assistantStatus: AssistantStatus,
  tasks: z.array(TaskSummary),
  taskDetails: z.record(z.string(), TaskDetail),
  approvals: z.array(Approval),
  notifications: z.array(Notification),
  connections: z.array(Connection),
  memories: z.array(Memory),
  usage: UsageSummary,
  sessions: z.array(SessionInfo),
  adminOverview: AdminOverview,
  home: HomeSnapshot,
  attachments: z.array(Attachment),
  messages: z.array(ConversationMessage),
  skills: z.array(Skill),
  schedules: z.array(Schedule),
  scheduleRuns: z.record(z.string(), z.array(ScheduleRun)),
  webhooks: z.array(WebhookEndpoint),
  webhookDeliveries: z.record(z.string(), z.array(WebhookDelivery)),
  timeZones: z.array(TimeZoneInfo),
  // Phase C
  providers: z.array(ConnectionProviderInfo),
  emailWatches: z.array(EmailWatch),
  orders: z.array(Order),
  bookings: z.array(Booking),
  evidenceArtifacts: z.array(EvidenceArtifact),
  evidenceFiles: z.record(z.string(), z.string()),
  // Phase D
  calls: z.array(CallSession),
  doNotCall: z.array(DoNotCallEntry),
  phoneVerification: PhoneVerification.nullable(),
});

/**
 * Every task belongs to a conversation, and a detail's conversation is its summary's. A summary
 * without one (older fixtures) is a conversation of its own, as every new request is.
 */
function normalizeConversations(f: Fixtures): Fixtures {
  const tasks = f.tasks.map((t) => {
    const conversationId = t.conversationId ?? derivedId(t.id, 9);
    return { ...t, conversationId };
  });
  const taskDetails = { ...f.taskDetails };
  for (const t of tasks) {
    const d = taskDetails[t.id];
    if (d && d.conversationId !== t.conversationId)
      taskDetails[t.id] = { ...d, conversationId: t.conversationId };
  }
  return { ...f, tasks, taskDetails };
}

/** Builds fixtures and validates them against the contracts (throws on drift). */
export function loadFixtures(options: MockApiOptions = {}): Fixtures {
  const base = buildFixtures(options);
  const fixtures = normalizeConversations(options.fixtures ? options.fixtures(base) : base);
  const parsed = FixtureSchema.safeParse(fixtures);
  if (!parsed.success) {
    throw new Error(`Mock fixtures do not match the contracts:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as Fixtures;
}

const ROUTE_TABLE = (Object.keys(routes) as RouteName[]).map((name) => {
  const def = routes[name];
  const keys: string[] = [];
  const pattern = def.path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { name, method: def.method as string, regex: new RegExp(`^${pattern}$`), keys };
});

function matchRoute(method: string, path: string) {
  for (const r of ROUTE_TABLE) {
    if (r.method !== method) continue;
    const m = r.regex.exec(path);
    if (m) {
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
      return { name: r.name, params };
    }
  }
  return null;
}

const notFound = (what: string): MockResponse => ({
  status: 404,
  body: { error: { code: 'NOT_FOUND', message: `${what} not found`, requestId: 'mock' } },
});

function page<T>(items: T[]) {
  return { items, nextCursor: null };
}

const apiError = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): MockResponse => ({
  status,
  body: { error: { code, message, requestId: 'mock', ...(details ? { details } : {}) } },
});

/** POST /v1/tasks and follow-ups: a queued task in `conversationId` with its files linked. */
function newTask(req: MockRequest, s: Fixtures, conversationId: string): MockResponse {
  const body = req.body as {
    request: string;
    source: 'text' | 'voice';
    attachmentIds?: string[];
  };
  const nowIso = new Date().toISOString();
  const files = (body.attachmentIds ?? []).map((id) => s.attachments.find((a) => a.id === id));
  if (files.some((a) => !a)) {
    return apiError(400, 'VALIDATION_FAILED', 'Attachment not found', {
      reason: 'ATTACHMENT_NOT_FOUND',
    });
  }
  const attached = (files as Fixtures['attachments']).map((a) => ({
    ...a,
    conversationId,
    expiresAt: null,
  }));
  s.attachments = s.attachments.map((a) => attached.find((x) => x.id === a.id) ?? a);
  const id = crypto.randomUUID();
  const task: Fixtures['tasks'][number] = {
    id,
    title: body.request.slice(0, 80),
    titleMessage: null,
    request: body.request,
    status: 'QUEUED',
    riskLevel: 'LOW',
    source: body.source,
    progress: { completed: 0, total: 0 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: null,
    resultSummaryMessage: null,
    error: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: null,
    conversationId,
    outcome: null,
    question: null,
    scheduleId: null,
    attachmentCount: attached.length,
  };
  s.tasks = [task, ...s.tasks];
  s.taskDetails[task.id] = {
    ...task,
    conversationId,
    objective: null,
    objectiveMessage: null,
    planner: null,
    answer: null,
    steps: [],
    approvals: [],
    events: [],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [],
    canCancel: true,
    canRetry: false,
    startedAt: null,
    attachments: attached,
  };
  return { status: 202, body: task };
}

/** The file part of a multipart body: its name and size (the mock never stores bytes). */
function multipartFile(req: MockRequest): { name: string; size: number } | null {
  const buf = req.request.postDataBuffer();
  if (!buf) return null;
  const head = buf.subarray(0, Math.min(buf.length, 2048)).toString('utf8');
  const name = /filename="([^"]*)"/.exec(head)?.[1];
  if (name === undefined) return null;
  const start = buf.indexOf('\r\n\r\n');
  const boundary = head.slice(0, head.indexOf('\r\n'));
  const end = buf.lastIndexOf(`\r\n${boundary}`);
  return { name, size: start >= 0 && end > start ? end - start - 4 : 0 };
}

function mediaTypeOf(name: string): AttachmentMediaType | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  for (const [type, exts] of Object.entries(ATTACHMENT_EXTENSIONS)) {
    if (exts.includes(ext)) return type as AttachmentMediaType;
  }
  return null;
}

/** What checkWebhookUrl refuses (https only; private and local addresses). */
function refuseWebhookUrl(value: string): MockResponse | null {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    return apiError(422, 'FETCH_BLOCKED', 'https only', { reason: 'WEBHOOK_URL_INSECURE' });
  }
  if (
    /^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname) ||
    url.hostname.endsWith('.internal')
  ) {
    return apiError(422, 'FETCH_BLOCKED', 'Private address', {
      reason: 'WEBHOOK_URL_BLOCKED',
      host: url.host,
    });
  }
  return null;
}

function scheduleDetail(s: Fixtures, schedule: Schedule) {
  return {
    ...schedule,
    upcoming:
      schedule.status === 'active'
        ? nextOccurrences(schedule.recurrence, Date.now(), SCHEDULE_LIMITS.upcomingShown)
        : [],
    runs: (s.scheduleRuns[schedule.id] ?? []).slice(0, SCHEDULE_LIMITS.runsShown),
  };
}

function normalizeRecurrence(r: Recurrence): Recurrence {
  return { ...r, interval: r.interval ?? 1 };
}

const DEFAULTS: Partial<Record<RouteName, MockHandler>> = {
  login: (req, s) => {
    const body = req.body as { email: string; password: string };
    if (body.email.toLowerCase() !== s.me.email || body.password !== MOCK_PASSWORD) {
      return {
        status: 401,
        body: {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Email or password is incorrect.',
            requestId: 'mock',
          },
        },
      };
    }
    return {
      body: {
        user: s.me,
        session: { id: s.sessions[0]!.id, expiresAt: s.sessions[0]!.expiresAt },
      },
    };
  },
  logout: () => ({ status: 204 }),
  listSessions: (_r, s) => ({ body: { items: s.sessions } }),
  revokeSession: () => ({ status: 204 }),
  getMe: (_r, s) => ({ body: s.me }),
  updateMe: (req, s) => {
    const patch = req.body as Partial<Fixtures['me']> & { preferences?: Record<string, object> };
    // Phase D: like the API — a real number of an allowed type; a new number is unverified.
    if (patch.phoneNumber !== undefined && patch.phoneNumber !== null) {
      if (
        !E164PhoneNumber.safeParse(patch.phoneNumber).success ||
        /^\+49(900|137)/.test(patch.phoneNumber)
      ) {
        return apiError(400, 'VALIDATION_FAILED', 'Not a valid phone number', {
          reason: /^\+49900/.test(patch.phoneNumber)
            ? 'CALL_DESTINATION_BLOCKED'
            : 'PHONE_NUMBER_INVALID',
        });
      }
    }
    if (patch.phoneNumber !== undefined && patch.phoneNumber !== s.me.phoneNumber) {
      s.me = { ...s.me, phoneNumberVerifiedAt: null };
      s.phoneVerification = null;
    }
    const prefs = { ...s.me.preferences } as Record<string, object>;
    for (const [k, v] of Object.entries(patch.preferences ?? {})) {
      const next = { ...prefs[k], ...v } as Record<string, unknown>;
      // Like the API: voice names merge per language (an omitted language keeps its voice).
      if (k === 'voice' && 'voiceNames' in v) {
        next.voiceNames = {
          ...(prefs.voice as { voiceNames: object }).voiceNames,
          ...(v as { voiceNames: object }).voiceNames,
        };
      }
      prefs[k] = next;
    }
    s.me = { ...s.me, ...patch, preferences: prefs as Fixtures['me']['preferences'] };
    return { body: s.me };
  },
  getHome: (_r, s) => ({ body: s.home }),
  getAssistantStatus: (_r, s) => ({ body: s.assistantStatus }),
  getUsage: (_r, s) => ({ body: s.usage }),
  listTasks: (req, s) => {
    const status = req.query.get('status') ?? 'all';
    const filter: Record<string, (t: Fixtures['tasks'][number]) => boolean> = {
      active: (t) =>
        ['QUEUED', 'PLANNING', 'AWAITING_APPROVAL', 'RUNNING', 'VERIFYING'].includes(t.status),
      needs_approval: (t) => t.status === 'AWAITING_APPROVAL',
      completed: (t) => t.status === 'COMPLETED',
      failed: (t) => t.status === 'FAILED',
      all: () => true,
    };
    return { body: page(s.tasks.filter(filter[status] ?? filter.all!)) };
  },
  getTask: (req, s) => {
    const detail = s.taskDetails[req.params.id ?? ''];
    return detail ? { body: detail } : notFound('Task');
  },
  createTask: (req, s) => newTask(req, s, crypto.randomUUID()),
  listApprovals: (_r, s) => ({
    body: { items: s.approvals.filter((a) => a.status === 'PENDING') },
  }),
  decideApproval: (req, s) => {
    const approval = s.approvals.find((a) => a.id === req.params.id);
    if (!approval) return notFound('Approval');
    const body = req.body as { decision: 'approve' | 'reject'; actionHash: string; note?: string };
    if (body.actionHash !== approval.actionHash) {
      return {
        status: 409,
        body: {
          error: { code: 'APPROVAL_MISMATCH', message: 'Review it again.', requestId: 'mock' },
        },
      };
    }
    const decided = {
      ...approval,
      status: body.decision === 'approve' ? ('APPROVED' as const) : ('REJECTED' as const),
      decidedAt: new Date().toISOString(),
      decisionNote: body.note ?? null,
    };
    s.approvals = s.approvals.map((a) => (a.id === decided.id ? decided : a));
    return { body: decided };
  },
  listConnections: (_r, s) => ({ body: { items: s.connections } }),
  listMemories: (_r, s) => ({ body: page(s.memories) }),
  listNotifications: (_r, s) => ({ body: page(s.notifications) }),
  markNotificationsRead: (req, s) => {
    const ids = (req.body as { ids?: string[] }).ids;
    const readAt = new Date().toISOString();
    s.notifications = s.notifications.map((n) =>
      !ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? readAt } : n,
    );
    s.home = { ...s.home, unreadNotifications: s.notifications.filter((n) => !n.readAt).length };
    return { body: { ok: true } };
  },
  startVoiceSession: () => ({
    status: 201,
    body: { id: crypto.randomUUID(), startedAt: new Date().toISOString(), endedAt: null },
  }),
  endVoiceSession: (req) => ({
    body: {
      id: req.params.id,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    },
  }),
  adminOverview: (_r, s) => ({ body: s.adminOverview }),
  adminUsers: (_r, s) => ({
    body: page([
      {
        id: s.me.id,
        email: s.me.email,
        tenantName: s.me.tenant.name,
        roles: s.me.roles,
        status: 'active',
        createdAt: s.me.createdAt,
        lastActiveAt: new Date().toISOString(),
        taskCount: s.tasks.length,
      },
    ]),
  }),
  adminAudit: () => ({ body: page([]) }),

  // ---- Phase B: conversations
  listConversations: (req, s) => ({
    body: page(conversationList(s, req.query.get('q') ?? '')),
  }),
  getConversation: (req, s) => {
    const detail = conversationOf(s, req.params.id ?? '');
    return detail ? { body: detail } : notFound('Conversation');
  },
  followUp: (req, s) => {
    const id = req.params.id ?? '';
    const tasks = tasksOf(s, id);
    if (tasks.length === 0) return notFound('Conversation');
    const active = tasks.find((t) => !isTerminal(t.status));
    if (active) {
      return apiError(409, 'INVALID_STATE', 'A task of this conversation is still active', {
        reason: 'CONVERSATION_BUSY',
        taskId: active.id,
      });
    }
    return newTask(req, s, id);
  },
  deleteConversation: (req, s) => {
    const id = req.params.id ?? '';
    const tasks = tasksOf(s, id);
    if (tasks.length === 0) return notFound('Conversation');
    const active = tasks.find((t) => !isTerminal(t.status));
    if (active) {
      return apiError(409, 'INVALID_STATE', 'A task of this conversation is still active', {
        reason: 'CONVERSATION_ACTIVE_TASK',
        taskId: active.id,
      });
    }
    const ids = new Set(tasks.map((t) => t.id));
    s.tasks = s.tasks.filter((t) => !ids.has(t.id));
    for (const taskId of ids) delete s.taskDetails[taskId];
    s.attachments = s.attachments.filter((a) => a.conversationId !== id);
    s.schedules = s.schedules.map((sc) =>
      sc.conversationId === id ? { ...sc, conversationId: null } : sc,
    );
    return { status: 204 };
  },

  // ---- attachments
  uploadAttachment: (req, s) => {
    if (s.assistantStatus.capabilities.attachments === false) {
      return apiError(503, 'SERVICE_UNAVAILABLE', 'Storage is not configured', {
        reason: 'STORAGE_NOT_CONFIGURED',
      });
    }
    const file = multipartFile(req);
    if (!file) return apiError(400, 'VALIDATION_FAILED', 'No file', { reason: 'FILE_EMPTY' });
    const mediaType = mediaTypeOf(file.name);
    if (!mediaType) {
      return apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported file type', {
        reason: 'UNSUPPORTED_FILE_TYPE',
      });
    }
    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const attachment: Fixtures['attachments'][number] = {
      id,
      filename: file.name,
      mediaType,
      sizeBytes: Math.max(1, file.size),
      sha256: '0'.repeat(64),
      conversationId: null,
      pageCount: null,
      textChars: null,
      downloadPath: `/v1/attachments/${id}/content`,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      createdAt: nowIso,
    };
    s.attachments = [...s.attachments, attachment];
    return { status: 201, body: attachment, delayMs: 150 };
  },
  getAttachment: (req, s) => {
    const a = s.attachments.find((x) => x.id === req.params.id);
    return a ? { body: a } : notFound('Attachment');
  },
  downloadAttachment: (req, s) => {
    const a = s.attachments.find((x) => x.id === req.params.id);
    if (!a) return notFound('Attachment');
    return {
      raw: {
        body: `Mock content of ${a.filename}\n`,
        contentType: a.mediaType.startsWith('text/')
          ? `${a.mediaType}; charset=utf-8`
          : a.mediaType,
        headers: {
          'content-disposition': `attachment; filename="${a.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
          'x-content-type-options': 'nosniff',
        },
      },
    };
  },
  deleteAttachment: (req, s) => {
    const before = s.attachments.length;
    s.attachments = s.attachments.filter((a) => a.id !== req.params.id);
    return s.attachments.length < before ? { status: 204 } : notFound('Attachment');
  },

  // ---- skills
  listSkills: (_r, s) => ({ body: { items: s.skills } }),
  updateSkill: (req, s) => {
    const skill = s.skills.find((k) => k.id === req.params.id);
    if (!skill) return notFound('Skill');
    if (skill.status === 'planned') {
      return apiError(409, 'INVALID_STATE', 'Planned skill', { reason: 'SKILL_PLANNED' });
    }
    if (!skill.canToggle) {
      return apiError(409, 'INVALID_STATE', 'Core skill', { reason: 'SKILL_NOT_TOGGLEABLE' });
    }
    const enabled = (req.body as { enabled: boolean }).enabled;
    const prefs = s.me.preferences;
    if (skill.id === 'personal-memory') {
      s.me = { ...s.me, preferences: { ...prefs, memory: { enabled } } };
    } else {
      const disabled = new Set(prefs.skills.disabled);
      if (enabled) disabled.delete(skill.id);
      else disabled.add(skill.id);
      s.me = { ...s.me, preferences: { ...prefs, skills: { disabled: [...disabled] } } };
    }
    s.skills = skillsFor(s);
    return { body: s.skills.find((k) => k.id === skill.id) };
  },

  // ---- schedules
  listSchedules: (_r, s) => ({ body: { items: s.schedules } }),
  previewSchedule: (req) => {
    const body = req.body as { recurrence: Recurrence; count: number };
    const r = normalizeRecurrence(body.recurrence);
    return {
      body: {
        rrule: rruleFor(r, Date.now()),
        occurrences: nextOccurrences(r, Date.now(), body.count),
        timeZone: r.timeZone,
      },
    };
  },
  createSchedule: (req, s) => {
    const body = req.body as {
      title: string;
      request: string;
      recurrence: Recurrence;
      language?: 'en' | 'de' | 'ar';
    };
    const open = s.schedules.filter((x) => x.status !== 'completed').length;
    if (open >= SCHEDULE_LIMITS.maxPerUser) {
      return apiError(409, 'CONFLICT', 'Too many schedules', {
        reason: 'SCHEDULE_LIMIT_REACHED',
        max: SCHEDULE_LIMITS.maxPerUser,
      });
    }
    const r = normalizeRecurrence(body.recurrence);
    const next = nextOccurrences(r, Date.now(), 1)[0] ?? null;
    if (!next) {
      return apiError(422, 'VALIDATION_FAILED', 'No occurrences', {
        reason: 'RECURRENCE_HAS_NO_OCCURRENCES',
      });
    }
    const nowIso = new Date().toISOString();
    const schedule: Schedule = {
      id: crypto.randomUUID(),
      title: body.title,
      request: body.request,
      language: body.language ?? s.me.locale,
      recurrence: r,
      rrule: rruleFor(r, Date.now()),
      status: 'active',
      pausedReason: null,
      nextRunAt: next,
      lastRunAt: null,
      lastTaskId: null,
      conversationId: null,
      runCount: 0,
      consecutiveFailures: 0,
      createdBy: 'user',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    s.schedules = [schedule, ...s.schedules];
    return { status: 201, body: schedule };
  },
  getSchedule: (req, s) => {
    const schedule = s.schedules.find((x) => x.id === req.params.id);
    return schedule ? { body: scheduleDetail(s, schedule) } : notFound('Schedule');
  },
  updateSchedule: (req, s) => {
    const schedule = s.schedules.find((x) => x.id === req.params.id);
    if (!schedule) return notFound('Schedule');
    const body = req.body as { title?: string; request?: string; recurrence?: Recurrence };
    const recurrence = body.recurrence ? normalizeRecurrence(body.recurrence) : schedule.recurrence;
    const next: Schedule = {
      ...schedule,
      ...(body.title ? { title: body.title } : {}),
      ...(body.request ? { request: body.request } : {}),
      recurrence,
      rrule: rruleFor(recurrence, Date.now()),
      nextRunAt:
        schedule.status === 'active'
          ? (nextOccurrences(recurrence, Date.now(), 1)[0] ?? null)
          : null,
      updatedAt: new Date().toISOString(),
    };
    s.schedules = s.schedules.map((x) => (x.id === next.id ? next : x));
    return { body: next };
  },
  deleteSchedule: (req, s) => {
    const before = s.schedules.length;
    s.schedules = s.schedules.filter((x) => x.id !== req.params.id);
    return s.schedules.length < before ? { status: 204 } : notFound('Schedule');
  },
  pauseSchedule: (req, s) => {
    const schedule = s.schedules.find((x) => x.id === req.params.id);
    if (!schedule) return notFound('Schedule');
    const next: Schedule = {
      ...schedule,
      status: 'paused',
      pausedReason: 'user',
      nextRunAt: null,
      updatedAt: new Date().toISOString(),
    };
    s.schedules = s.schedules.map((x) => (x.id === next.id ? next : x));
    return { body: next };
  },
  resumeSchedule: (req, s) => {
    const schedule = s.schedules.find((x) => x.id === req.params.id);
    if (!schedule) return notFound('Schedule');
    const next: Schedule = {
      ...schedule,
      status: 'active',
      pausedReason: null,
      consecutiveFailures: 0,
      nextRunAt: nextOccurrences(schedule.recurrence, Date.now(), 1)[0] ?? null,
      updatedAt: new Date().toISOString(),
    };
    s.schedules = s.schedules.map((x) => (x.id === next.id ? next : x));
    return { body: next };
  },

  // ---- webhooks
  listWebhooks: (_r, s) => ({ body: { items: s.webhooks } }),
  createWebhook: (req, s) => {
    const body = req.body as { url: string; description?: string; eventTypes: string[] };
    if (s.webhooks.length >= WEBHOOK_LIMITS.maxEndpointsPerUser) {
      return apiError(409, 'CONFLICT', 'Too many endpoints', {
        reason: 'WEBHOOK_LIMIT_REACHED',
        max: WEBHOOK_LIMITS.maxEndpointsPerUser,
      });
    }
    const refused = refuseWebhookUrl(body.url);
    if (refused) return refused;
    const nowIso = new Date().toISOString();
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
    const endpoint: Fixtures['webhooks'][number] = {
      id: crypto.randomUUID(),
      url: body.url,
      description: body.description ?? null,
      eventTypes: body.eventTypes as Fixtures['webhooks'][number]['eventTypes'],
      status: 'active',
      disabledReason: null,
      secretHint: `whsec_…${secret.slice(-4)}`,
      consecutiveFailures: 0,
      lastDeliveryAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    s.webhooks = [...s.webhooks, endpoint];
    s.webhookDeliveries[endpoint.id] = [];
    return { status: 201, body: { endpoint, secret } };
  },
  updateWebhook: (req, s) => {
    const endpoint = s.webhooks.find((e) => e.id === req.params.id);
    if (!endpoint) return notFound('Webhook endpoint');
    const body = req.body as {
      enabled?: boolean;
      url?: string;
      description?: string | null;
      eventTypes?: Fixtures['webhooks'][number]['eventTypes'];
    };
    if (body.url) {
      const refused = refuseWebhookUrl(body.url);
      if (refused) return refused;
    }
    const next: Fixtures['webhooks'][number] = {
      ...endpoint,
      ...(body.url ? { url: body.url } : {}),
      ...(body.eventTypes ? { eventTypes: body.eventTypes } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.enabled === false ? { status: 'disabled', disabledReason: 'user' } : {}),
      ...(body.enabled === true
        ? { status: 'active', disabledReason: null, consecutiveFailures: 0 }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    s.webhooks = s.webhooks.map((e) => (e.id === next.id ? next : e));
    return { body: next };
  },
  deleteWebhook: (req, s) => {
    const before = s.webhooks.length;
    s.webhooks = s.webhooks.filter((e) => e.id !== req.params.id);
    delete s.webhookDeliveries[req.params.id ?? ''];
    return s.webhooks.length < before ? { status: 204 } : notFound('Webhook endpoint');
  },
  rotateWebhookSecret: (req, s) => {
    const endpoint = s.webhooks.find((e) => e.id === req.params.id);
    if (!endpoint) return notFound('Webhook endpoint');
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
    const next = {
      ...endpoint,
      secretHint: `whsec_…${secret.slice(-4)}`,
      updatedAt: new Date().toISOString(),
    };
    s.webhooks = s.webhooks.map((e) => (e.id === next.id ? next : e));
    return { body: { endpoint: next, secret } };
  },
  testWebhook: (req, s) => {
    const endpoint = s.webhooks.find((e) => e.id === req.params.id);
    if (!endpoint) return notFound('Webhook endpoint');
    if (endpoint.status !== 'active') {
      return apiError(409, 'INVALID_STATE', 'Endpoint disabled', { reason: 'WEBHOOK_DISABLED' });
    }
    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const delivery: Fixtures['webhookDeliveries'][string][number] = {
      id,
      endpointId: endpoint.id,
      eventType: 'webhook.test',
      webhookId: `msg_${id}`,
      status: 'succeeded',
      attempts: 1,
      maxAttempts: WEBHOOK_LIMITS.maxAttempts,
      nextAttemptAt: null,
      lastAttemptAt: nowIso,
      responseStatus: 204,
      failureReason: null,
      durationMs: 162,
      createdAt: nowIso,
      completedAt: nowIso,
    };
    s.webhookDeliveries[endpoint.id] = [delivery, ...(s.webhookDeliveries[endpoint.id] ?? [])];
    s.webhooks = s.webhooks.map((e) =>
      e.id === endpoint.id ? { ...e, lastDeliveryAt: nowIso, lastSuccessAt: nowIso } : e,
    );
    return { status: 202, body: delivery };
  },
  listWebhookDeliveries: (req, s) => {
    const items = s.webhookDeliveries[req.params.id ?? ''];
    return items ? { body: page(items) } : notFound('Webhook endpoint');
  },

  // ---- meta
  listTimeZones: (_r, s) => ({ body: { items: s.timeZones } }),

  // ---- Phase C: connections (OAuth)
  listConnectionProviders: (_r, s) => ({ body: { items: s.providers } }),
  deleteConnection: (req, s) => {
    const before = s.connections.length;
    s.connections = s.connections.filter((c) => c.id !== req.params.id);
    return s.connections.length < before ? { status: 204 } : notFound('Connection');
  },
  startOAuthConnection: (req, s) => {
    const body = req.body as { provider: 'google' | 'microsoft'; redirectUri: string };
    const info = s.providers.find((p) => p.provider === body.provider);
    if (!info?.configured) {
      return apiError(503, 'SERVICE_UNAVAILABLE', 'Not configured', {
        reason: 'PROVIDER_NOT_CONFIGURED',
        provider: body.provider,
      });
    }
    const redirect = new URL(body.redirectUri);
    if (redirect.pathname !== '/connections/callback') {
      return apiError(400, 'VALIDATION_FAILED', 'Redirect URI not allowed', {
        reason: 'REDIRECT_URI_NOT_ALLOWED',
      });
    }
    // Like the mock providers: the "consent page" answers at once with a code for this state.
    const state = `mock-state-${body.provider}-${'x'.repeat(24)}`;
    const target = new URL(body.redirectUri);
    target.searchParams.set('code', `mock-code-${body.provider}`);
    target.searchParams.set('state', state);
    return {
      body: {
        authorizationUrl: target.href,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  },
  completeOAuthConnection: (req, s) => {
    const body = req.body as { state: string; code?: string; error?: string };
    const provider = /mock-state-(google|microsoft)/.exec(body.state)?.[1] as
      'google' | 'microsoft' | undefined;
    if (!provider)
      return apiError(400, 'VALIDATION_FAILED', 'Unknown state', { reason: 'OAUTH_STATE_INVALID' });
    if (body.error)
      return apiError(400, 'VALIDATION_FAILED', 'Denied', { reason: 'OAUTH_DENIED', provider });
    const existing = s.connections.find((c) => c.provider === provider);
    const nowIso = new Date().toISOString();
    const connection: Fixtures['connections'][number] = {
      id: existing?.id ?? crypto.randomUUID(),
      provider,
      label: provider === 'google' ? 'Google' : 'Microsoft',
      accountIdentifier: existing?.accountIdentifier ?? s.me.email,
      status: 'active',
      permissions: [],
      lastVerifiedAt: nowIso,
      lastError: null,
      expiresAt: null,
      createdAt: existing?.createdAt ?? nowIso,
      capabilities: existing?.capabilities?.length
        ? existing.capabilities
        : ['mail.read', 'calendar.read'],
      scopes: existing?.scopes ?? [],
      statusReason: null,
    };
    s.connections = [...s.connections.filter((c) => c.id !== connection.id), connection];
    const resumable = s.tasks
      .filter(
        (t) =>
          t.status === 'FAILED' &&
          t.error?.reason === 'CONNECTION_EXPIRED' &&
          t.error.params?.provider === provider,
      )
      .map((t) => t.id);
    return { body: { connection, returnTo: '/connections', resumableTaskIds: resumable } };
  },

  // ---- Phase C: calendar (Home "Upcoming" and a window of events)
  listUpcomingEvents: (_r, s) => ({ body: { upcoming: s.home.upcoming ?? null } }),
  listCalendarEvents: (_r, s) => {
    const upcoming = s.home.upcoming;
    if (!upcoming)
      return apiError(409, 'CONFLICT', 'No calendar', { reason: 'CALENDAR_NOT_CONNECTED' });
    return { body: { items: [], sources: upcoming.sources, truncated: false } };
  },

  // ---- Phase C: reply watches
  listEmailWatches: (_r, s) => ({ body: { items: s.emailWatches } }),
  deleteEmailWatch: (req, s) => {
    const watch = s.emailWatches.find((w) => w.id === req.params.id);
    if (!watch) return notFound('Watch');
    s.emailWatches = s.emailWatches.map((w) =>
      w.id === watch.id
        ? { ...w, status: 'stopped', nextCheckAt: null, updatedAt: new Date().toISOString() }
        : w,
    );
    return { status: 204 };
  },

  // ---- Phase C: orders, bookings, evidence
  listOrders: (req, s) => {
    const status = req.query.get('status');
    return { body: page(s.orders.filter((o) => !status || o.status === status)) };
  },
  getOrder: (req, s) => {
    const order = s.orders.find((o) => o.id === req.params.id);
    return order ? { body: order } : notFound('Order');
  },
  listBookings: (req, s) => {
    const status = req.query.get('status');
    return { body: page(s.bookings.filter((b) => !status || b.status === status)) };
  },
  getBooking: (req, s) => {
    const booking = s.bookings.find((b) => b.id === req.params.id);
    return booking ? { body: booking } : notFound('Booking');
  },
  getEvidence: (req, s) => {
    const a = s.evidenceArtifacts.find((x) => x.id === req.params.id);
    return a ? { body: a } : notFound('Evidence');
  },
  downloadEvidence: (req, s) => {
    const a = s.evidenceArtifacts.find((x) => x.id === req.params.id);
    const file = s.evidenceFiles[req.params.id ?? ''];
    if (!a || !file) return notFound('Evidence');
    const ext = a.kind === 'screenshot' ? 'png' : a.kind === 'ics' ? 'ics' : 'json';
    return {
      raw: {
        body: evidenceBytes(file),
        contentType: a.mediaType === 'text/calendar' ? 'text/calendar; charset=utf-8' : a.mediaType,
        headers: {
          'content-disposition': `attachment; filename="evidence-${a.id.slice(0, 8)}.${ext}"`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, no-store',
          'x-evidence-host': FIXTURE_HOST,
        },
      },
    };
  },
};

/** Every call of the account: the tasks' (current) sessions first, then the rest. */
function allCalls(s: Fixtures): Fixtures['calls'] {
  const byId = new Map<string, Fixtures['calls'][number]>();
  for (const d of Object.values(s.taskDetails)) for (const c of d.calls ?? []) byId.set(c.id, c);
  for (const c of s.calls) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The code the mock's verification call "reads out". */
export const MOCK_VERIFICATION_CODE = '482913';

Object.assign(DEFAULTS, {
  // ---- Phase D: calls, do-not-call, phone verification
  listCalls: (req, s) => {
    const result = req.query.get('result');
    const items = allCalls(s)
      .filter((c) => !result || c.result === result)
      .map(({ turns: _turns, timeline: _timeline, ...summary }) => {
        // Like the API: each call carries its task's title.
        const task = s.tasks.find((t) => t.id === summary.taskId);
        return task
          ? { ...summary, taskTitle: task.title, taskTitleMessage: task.titleMessage ?? null }
          : summary;
      });
    return { body: page(items) };
  },
  getCall: (req, s) => {
    const found = allCalls(s).find((c) => c.id === req.params.id);
    return found ? { body: found } : notFound('Call');
  },
  listDoNotCall: (_r, s) => ({ body: { items: s.doNotCall } }),
  deleteDoNotCall: (req, s) => {
    const before = s.doNotCall.length;
    s.doNotCall = s.doNotCall.filter((e) => e.id !== req.params.id);
    return s.doNotCall.length < before ? { status: 204 } : notFound('Do-not-call entry');
  },
  getPhoneVerification: (_r, s) => {
    // Like the API: the latest one while it can be confirmed or shows why it failed.
    const v = s.phoneVerification;
    const live =
      v &&
      (v.status === 'calling' || v.status === 'pending' || v.status === 'failed') &&
      Date.parse(v.expiresAt) > Date.now();
    return { body: { verification: live ? v : null } };
  },
  startPhoneVerification: (_r, s) => {
    if (s.assistantStatus.capabilities.phoneCalls === false) {
      return apiError(503, 'SERVICE_UNAVAILABLE', 'Telephony is not configured', {
        reason: 'TELEPHONY_NOT_CONFIGURED',
      });
    }
    if (!s.me.phoneNumber) {
      return apiError(409, 'CONFLICT', 'Add a phone number first', {
        reason: 'PHONE_NUMBER_REQUIRED',
      });
    }
    if (s.me.phoneNumberVerifiedAt) {
      return apiError(409, 'CONFLICT', 'This number is verified already', {
        reason: 'PHONE_ALREADY_VERIFIED',
      });
    }
    const nowMs = Date.now();
    const n = s.me.phoneNumber;
    const verification: PhoneVerification = {
      id: crypto.randomUUID(),
      status: 'calling',
      number: `${n.slice(0, 3)} ${n.slice(3, 6)} ••• •• ${n.slice(-2)}`,
      attemptsLeft: CALL_LIMITS.verificationMaxAttempts,
      expiresAt: new Date(nowMs + CALL_LIMITS.verificationTtlMinutes * 60_000).toISOString(),
      createdAt: new Date(nowMs).toISOString(),
    };
    s.phoneVerification = verification;
    return { status: 201, body: verification };
  },
  confirmPhoneVerification: (req, s) => {
    const v = s.phoneVerification;
    if (!v || v.status === 'verified') {
      return apiError(400, 'VALIDATION_FAILED', 'No verification is running', {
        reason: 'PHONE_VERIFICATION_INVALID',
        attemptsLeft: 0,
      });
    }
    if (v.status === 'expired' || v.attemptsLeft <= 0) {
      return apiError(400, 'VALIDATION_FAILED', 'The code has expired', {
        reason: 'PHONE_VERIFICATION_EXPIRED',
      });
    }
    if ((req.body as { code: string }).code !== MOCK_VERIFICATION_CODE) {
      const attemptsLeft = v.attemptsLeft - 1;
      s.phoneVerification = { ...v, attemptsLeft, status: attemptsLeft > 0 ? v.status : 'expired' };
      return apiError(400, 'VALIDATION_FAILED', 'The code is not correct', {
        reason: 'PHONE_VERIFICATION_INVALID',
        attemptsLeft,
      });
    }
    s.phoneVerification = { ...v, status: 'verified' };
    s.me = { ...s.me, phoneNumberVerifiedAt: new Date().toISOString() };
    return { body: s.me };
  },
} satisfies Partial<Record<RouteName, MockHandler>>);

/** The default handlers, e.g. to wrap one in an override (delay, failure). */
export const DEFAULT_HANDLERS: Readonly<Partial<Record<RouteName, MockHandler>>> = DEFAULTS;

/** The password the mock accepts for the fixture owner (layla.haddad@example.com). */
export const MOCK_PASSWORD = 'correct horse battery staple';

export async function mockApi(target: Page, options: MockApiOptions = {}): Promise<MockApi> {
  const state = loadFixtures(options);
  const api: MockApi = { state, errors: [], calls: [] };

  await target.route('**/api/v1/**', async (route: Route, request: Request) => {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === EVENTS_PATH) {
      // Keep the stream open without events (never fulfilled) so the app shows "connected".
      return;
    }
    const match = matchRoute(request.method(), path);
    if (!match) {
      api.errors.push(`Unmocked route ${request.method()} ${path}`);
      return route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'Route not found' } },
      });
    }
    api.calls.push(match.name);
    const def = routes[match.name] as { body?: z.ZodType; response: z.ZodType | null };

    let body: unknown = undefined;
    if (def.body) {
      const raw = request.postData();
      const parsed = def.body.safeParse(raw ? JSON.parse(raw) : {});
      if (!parsed.success) {
        api.errors.push(`Invalid ${match.name} body: ${z.prettifyError(parsed.error)}`);
        return route.fulfill({
          status: 400,
          json: {
            error: { code: 'VALIDATION_FAILED', message: 'Invalid request', requestId: 'mock' },
          },
        });
      }
      body = parsed.data;
    }

    const handler = options.overrides?.[match.name] ?? DEFAULTS[match.name];
    if (!handler) {
      api.errors.push(`No mock handler for ${match.name}`);
      return route.fulfill({
        status: 501,
        json: { error: { code: 'INTERNAL', message: 'Not mocked' } },
      });
    }
    const res = await handler(
      { name: match.name, params: match.params, query: url.searchParams, body, request },
      state,
    );
    if (res.delayMs) await new Promise((r) => setTimeout(r, res.delayMs));
    const status =
      res.status ?? (routes[match.name] as { successStatus?: number }).successStatus ?? 200;
    if (status === 204) return route.fulfill({ status: 204 });
    if (res.raw) {
      return route.fulfill({
        status,
        body: res.raw.body,
        contentType: res.raw.contentType,
        headers: { 'x-request-id': 'mock', ...res.raw.headers },
      });
    }
    if (status < 300 && def.response) {
      const checked = def.response.safeParse(res.body);
      if (!checked.success) {
        api.errors.push(
          `Mock ${match.name} response breaks the contract: ${z.prettifyError(checked.error)}`,
        );
      }
    }
    return route.fulfill({ status, json: res.body, headers: { 'x-request-id': 'mock' } });
  });

  return api;
}

/** Cookies a signed-in browser has: the (opaque) session plus the locale/theme mirrors. */
export async function signInWithMock(
  context: BrowserContext,
  baseURL: string,
  { locale = 'en', theme }: { locale?: string; theme?: 'light' | 'dark' } = {},
): Promise<void> {
  await context.addCookies([
    {
      name: 'jarvis_session',
      value: 'mock-session',
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
    ...setAppearanceCookies(baseURL, locale, theme),
  ]);
}

export function setAppearanceCookies(baseURL: string, locale: string, theme?: 'light' | 'dark') {
  return [
    { name: 'jarvis_locale', value: locale, url: baseURL, sameSite: 'Lax' as const },
    ...(theme
      ? [{ name: 'jarvis_theme', value: theme, url: baseURL, sameSite: 'Lax' as const }]
      : []),
  ];
}
