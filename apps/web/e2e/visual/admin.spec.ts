/**
 * Admin with the contract-validated mock API: light + dark × en + de + ar on desktop and mobile
 * (the tables scroll sideways inside their card on phones, first column pinned), the 403-style
 * state for non-admins, a degraded system, and paging of users and audit events. Screenshots:
 * test-results/screenshots/admin--<state>--<theme>--<locale>--<viewport>.png
 */
import type { AdminUser, AuditEvent, RouteName } from '@jarvis/contracts';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { IDS, type Fixtures } from '../support/fixtures';
import {
  mockApi,
  signInWithMock,
  type MockApiOptions,
  type MockHandler,
} from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

type Locale = 'en' | 'de' | 'ar';
const THEMES = ['light', 'dark'] as const;
const LOCALES: Locale[] = ['en', 'de', 'ar'];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function id(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(6, '0')}-2c51-4d7a-9e10-${String(n).padStart(12, '0')}`;
}

function usersFor(f: Fixtures, extra = 0): AdminUser[] {
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const base: AdminUser[] = [
    {
      id: f.me.id,
      email: f.me.email,
      tenantName: f.me.tenant.name,
      roles: f.me.roles,
      status: 'active',
      createdAt: f.me.createdAt,
      lastActiveAt: at(MIN),
      taskCount: 27,
    },
    {
      id: id('a1', 1),
      email: 'omar.said@example.com',
      tenantName: 'Said Architekten',
      roles: ['owner'],
      status: 'active',
      createdAt: at(18 * DAY),
      lastActiveAt: at(5 * HOUR),
      taskCount: 14,
    },
    {
      id: id('a1', 2),
      email: 'jonas.becker@example.de',
      tenantName: 'Becker & Partner Steuerberatungsgesellschaft',
      roles: ['owner'],
      status: 'active',
      createdAt: at(11 * DAY),
      lastActiveAt: at(2 * DAY),
      taskCount: 6,
    },
    {
      id: id('a1', 3),
      email: 'nadia.rahman@example.com',
      tenantName: 'Becker & Partner Steuerberatungsgesellschaft',
      roles: ['member'],
      status: 'active',
      createdAt: at(9 * DAY),
      lastActiveAt: null,
      taskCount: 0,
    },
    {
      id: id('a1', 4),
      email: 'mei.lin@example.com',
      tenantName: 'Lin Studio',
      roles: ['owner'],
      status: 'disabled',
      createdAt: at(30 * DAY),
      lastActiveAt: at(25 * DAY),
      taskCount: 3,
    },
  ];
  const more = Array.from({ length: extra }, (_, i): AdminUser => ({
    id: id('b2', i + 10),
    email: `alpha.tester${i + 1}@example.org`,
    tenantName: `Alpha ${i + 1}`,
    roles: ['owner'],
    status: 'active',
    createdAt: at((40 + i) * DAY),
    lastActiveAt: at((i + 1) * HOUR),
    taskCount: i,
  }));
  return [...base, ...more];
}

function auditFor(f: Fixtures, count = 8): AuditEvent[] {
  const now = Date.now();
  const rows: Array<Omit<AuditEvent, 'id' | 'at'> & { ago: number }> = [
    {
      ago: MIN,
      tenantId: IDS.tenant,
      actorType: 'admin',
      actorId: f.me.id,
      action: 'admin.users_viewed',
      targetType: null,
      targetId: null,
    },
    {
      ago: 8 * MIN,
      tenantId: IDS.tenant,
      actorType: 'agent',
      actorId: null,
      action: 'approval.requested',
      targetType: 'approval',
      targetId: IDS.approval,
    },
    {
      ago: 9 * MIN,
      tenantId: IDS.tenant,
      actorType: 'user',
      actorId: f.me.id,
      action: 'task.created',
      targetType: 'task',
      targetId: IDS.taskEmail,
    },
    {
      ago: 2 * HOUR,
      tenantId: IDS.tenant,
      actorType: 'agent',
      actorId: null,
      action: 'memory.saved',
      targetType: 'memory',
      targetId: IDS.memorySeat,
    },
    {
      ago: 26 * HOUR,
      tenantId: IDS.tenant,
      actorType: 'user',
      actorId: f.me.id,
      action: 'connection.tested',
      targetType: 'connection',
      targetId: IDS.connectionSmtp,
    },
    {
      ago: 3 * DAY,
      tenantId: IDS.tenant,
      actorType: 'user',
      actorId: f.me.id,
      action: 'auth.login',
      targetType: 'session',
      targetId: IDS.session,
    },
    {
      ago: 4 * DAY,
      tenantId: null,
      actorType: 'system',
      actorId: null,
      action: 'auth.login_failed',
      targetType: null,
      targetId: null,
    },
    {
      ago: 20 * DAY,
      tenantId: IDS.tenant,
      actorType: 'user',
      actorId: f.me.id,
      action: 'connection.created',
      targetType: 'connection',
      targetId: IDS.connectionWeb,
    },
  ];
  return Array.from({ length: count }, (_, i) => {
    const r = rows[i % rows.length]!;
    const { ago, ...rest } = r;
    return {
      ...rest,
      id: String(1000 - i),
      at: new Date(now - ago - Math.floor(i / rows.length) * DAY).toISOString(),
    };
  });
}

function paged<T>(items: T[]): MockHandler {
  return (req) => {
    const limit = Number(req.query.get('limit') ?? 25);
    const start = Number(req.query.get('cursor') ?? 0);
    const next = start + limit < items.length ? String(start + limit) : null;
    return { body: { items: items.slice(start, start + limit), nextCursor: next } };
  };
}

async function openAdmin(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  {
    locale,
    theme,
    admin = true,
    fixtures,
    overrides,
    users = 0,
    audit = 8,
  }: {
    locale: Locale;
    theme: 'light' | 'dark';
    admin?: boolean;
    fixtures?: (f: Fixtures) => Fixtures;
    overrides?: MockApiOptions['overrides'];
    users?: number;
    audit?: number;
  },
) {
  await signInWithMock(context, baseURL, { locale, theme });
  let state: Fixtures | null = null;
  const api = await mockApi(page, {
    locale,
    theme,
    admin,
    fixtures: (f) => {
      const realistic: Fixtures = {
        ...f,
        adminOverview: {
          ...f.adminOverview,
          users: { total: 5 + users, active7d: 3 },
          tenants: { total: 4 },
          // Two tasks are due now (waited 4 s); five approval expiry timers are scheduled.
          health: {
            ...f.adminOverview.health,
            queueDepth: 2,
            queueReady: 2,
            queueScheduled: 5,
            oldestReadyAgeMs: 4_200,
          },
          tasksByStatus: {
            QUEUED: 2,
            RUNNING: 1,
            AWAITING_APPROVAL: 1,
            COMPLETED: 41,
            FAILED: 3,
            CANCELLED: 2,
          },
          toolReliability: [
            {
              toolId: 'web.fetch',
              executions: 38,
              succeeded: 33,
              failed: 5,
              p50Ms: 412,
              p95Ms: 1890,
            },
            {
              toolId: 'text.summarize',
              executions: 31,
              succeeded: 31,
              failed: 0,
              p50Ms: 18,
              p95Ms: 64,
            },
            {
              toolId: 'email.send',
              executions: 12,
              succeeded: 12,
              failed: 0,
              p50Ms: 840,
              p95Ms: 2310,
            },
            { toolId: 'memory.save', executions: 9, succeeded: 9, failed: 0, p50Ms: 9, p95Ms: 21 },
          ],
          cost30dMicroUsd: 18_640_000,
        },
      };
      state = fixtures ? fixtures(realistic) : realistic;
      return state;
    },
    overrides: {
      adminUsers: (req, s) => paged(usersFor(s, users))(req, s),
      adminAudit: (req, s) => paged(auditFor(s, audit))(req, s),
      ...overrides,
    } satisfies Partial<Record<RouteName, MockHandler>>,
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return { api, state: state! };
}

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`admin — overview — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const { api } = await openAdmin(page, context, baseURL!, { locale, theme });
      await expect(page.locator('main table')).toHaveCount(3);
      await expect(page.locator('main').getByText('omar.said@example.com')).toBeVisible();
      await capture(page, testInfo, `admin--overview--${variant}`);
      await expectNoSeriousA11yViolations(page);
      // Admin views never request content endpoints.
      expect(api.calls.filter((c) => /Memor|getTask|listTasks|Approval/.test(c))).toEqual([]);
      expect(api.errors).toEqual([]);
    });
  }
}

for (const { theme, locale } of [
  { theme: 'light', locale: 'en' },
  { theme: 'dark', locale: 'ar' },
  { theme: 'light', locale: 'de' },
] as const) {
  const variant = `${theme}--${locale}`;

  test(`admin — not a platform admin — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const { api } = await openAdmin(page, context, baseURL!, { locale, theme, admin: false });
    await expect(page.locator('main').getByRole('link')).toBeVisible();
    await capture(page, testInfo, `admin--forbidden--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.calls.filter((c) => c.startsWith('admin'))).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test(`admin — degraded system — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
    const { api } = await openAdmin(page, context, baseURL!, {
      locale,
      theme,
      fixtures: (f) => ({
        ...f,
        adminOverview: {
          ...f.adminOverview,
          health: {
            ...f.adminOverview.health,
            worker: {
              healthy: false,
              lastHeartbeatAt: new Date(Date.now() - 47 * MIN).toISOString(),
            },
            // The worker is down: due jobs pile up, the oldest has waited 47 minutes.
            queueDepth: 14,
            queueReady: 14,
            queueScheduled: 15,
            oldestReadyAgeMs: 47 * MIN,
          },
          toolReliability: [],
          tasksByStatus: {},
        },
      }),
      audit: 0,
    });
    await expect(page.locator('main table')).toHaveCount(1);
    // Due jobs waiting over a minute: the queue tile warns in words (scheduled ones never do).
    await expect(page.getByText(/^(Behind:|Im Rückstand:|تأخّر:)/)).toBeVisible();
    await capture(page, testInfo, `admin--degraded--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

test('admin — load more users and audit events, refresh', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const { api } = await openAdmin(page, context, baseURL!, {
    locale: 'en',
    theme: 'light',
    users: 30,
    audit: 40,
  });
  const usersTable = page.getByRole('table', { name: 'Accounts on this installation' });
  // The audit log is a table from 640 px and a stacked list (one entry per event) on phones.
  const auditRows =
    testInfo.project.name === 'mobile'
      ? page
          .getByRole('list', { name: 'Security-relevant actions, newest first' })
          .getByRole('listitem')
      : page
          .getByRole('table', { name: 'Security-relevant actions, newest first' })
          .locator('tbody tr');
  await expect(usersTable.locator('tbody tr')).toHaveCount(25);
  await expect(auditRows).toHaveCount(25);
  await page.getByRole('button', { name: 'Load more' }).first().click();
  await expect(usersTable.locator('tbody tr')).toHaveCount(35);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(auditRows).toHaveCount(40);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

  const before = api.calls.filter((c) => c === 'adminOverview').length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect
    .poll(() => api.calls.filter((c) => c === 'adminOverview').length)
    .toBeGreaterThan(before);

  if (testInfo.project.name === 'mobile') {
    // The table scrolls inside its card; the page itself does not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scroller = page.getByRole('region', { name: 'Accounts on this installation' });
    await scroller.evaluate(
      (el) =>
        (el.scrollLeft = el.scrollWidth * (getComputedStyle(el).direction === 'rtl' ? -1 : 1)),
    );
    await scroller.scrollIntoViewIfNeeded();
    await capture(page, testInfo, 'admin--users-scrolled--light--en', { fullPage: false });
  }
  expect(api.errors).toEqual([]);
});

test('admin — hydrates under the CSP without console errors', async ({
  page,
  context,
  baseURL,
}) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = list;
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await openAdmin(page, context, baseURL!, { locale: 'en', theme: 'light' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp).toEqual([]);
  expect(problems).toEqual([]);
});
