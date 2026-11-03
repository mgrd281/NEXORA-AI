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
  AdminOverview,
  Approval,
  AssistantStatus,
  Connection,
  EVENTS_PATH,
  HomeSnapshot,
  Me,
  Memory,
  Notification,
  routes,
  SessionInfo,
  TaskDetail,
  TaskSummary,
  UsageSummary,
  type RouteName,
} from '@jarvis/contracts';
import { z } from 'zod';
import { buildFixtures, type FixtureOptions, type Fixtures } from './fixtures';

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
});

/** Builds fixtures and validates them against the contracts (throws on drift). */
export function loadFixtures(options: MockApiOptions = {}): Fixtures {
  const base = buildFixtures(options);
  const fixtures = options.fixtures ? options.fixtures(base) : base;
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
    const prefs = { ...s.me.preferences } as Record<string, object>;
    for (const [k, v] of Object.entries(patch.preferences ?? {})) prefs[k] = { ...prefs[k], ...v };
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
  createTask: (req, s) => {
    const body = req.body as { request: string; source: 'text' | 'voice' };
    const nowIso = new Date().toISOString();
    const task: Fixtures['tasks'][number] = {
      id: crypto.randomUUID(),
      title: body.request.slice(0, 80),
      request: body.request,
      status: 'QUEUED',
      riskLevel: 'LOW',
      source: body.source,
      progress: { completed: 0, total: 0 },
      pendingApprovalId: null,
      resultSummary: null,
      error: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };
    s.tasks = [task, ...s.tasks];
    s.taskDetails[task.id] = {
      ...task,
      objective: null,
      conversationId: crypto.randomUUID(),
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
    };
    return { status: 202, body: task };
  },
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
};

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
