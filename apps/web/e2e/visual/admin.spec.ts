/**
 * Admin with the contract-validated mock API. The admin page speaks German or Arabic only
 * (German unless the `jarvis_admin_locale` cookie says Arabic), whatever the profile's language;
 * the shell keeps the profile's. Covered: de + ar × light + dark (desktop and mobile through the
 * projects), the language switch (cookie, server-rendered first paint, title, profile
 * untouched), the mixed shell/admin directions, no English copy and no raw enum values for an
 * English profile, values of a newer server, the 403-style state for non-admins, a degraded
 * system, and paging of users and audit events. Screenshots:
 * test-results/screenshots/admin--<state>--<theme>--<admin locale>[--<profile> shell]--<viewport>.png
 */
import type { AdminUser, AuditEvent, RouteName } from '@jarvis/contracts';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { catalogs } from '../../src/i18n/messages';
import { IDS, type Fixtures } from '../support/fixtures';
import {
  mockApi,
  signInWithMock,
  type MockApiOptions,
  type MockHandler,
} from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

type Profile = 'en' | 'de' | 'ar';
type AdminLocale = 'de' | 'ar';
const THEMES = ['light', 'dark'] as const;
const ADMIN_LOCALES: AdminLocale[] = ['de', 'ar'];
const ADMIN_COOKIE = 'jarvis_admin_locale';

const TITLE: Record<AdminLocale, string> = {
  de: catalogs.de.admin.title,
  ar: catalogs.ar.admin.title,
};
const SHELL_ADMIN: Record<Profile, string> = {
  en: catalogs.en.shell.nav.admin,
  de: catalogs.de.shell.nav.admin,
  ar: catalogs.ar.shell.nav.admin,
};

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
    profile,
    adminCookie,
    theme,
    admin = true,
    fixtures,
    overrides,
    users = 0,
    audit = 8,
  }: {
    /** The profile's (and so the shell's) language. */
    profile: Profile;
    /** The admin language cookie as stored (none = never chosen). */
    adminCookie?: string;
    theme: 'light' | 'dark';
    admin?: boolean;
    fixtures?: (f: Fixtures) => Fixtures;
    overrides?: MockApiOptions['overrides'];
    users?: number;
    audit?: number;
  },
) {
  await signInWithMock(context, baseURL, { locale: profile, theme });
  if (adminCookie !== undefined) {
    await context.addCookies([
      { name: ADMIN_COOKIE, value: adminCookie, url: baseURL, sameSite: 'Lax' },
    ]);
  }
  let state: Fixtures | null = null;
  const api = await mockApi(page, {
    locale: profile,
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
            {
              toolId: 'calendar.create_event',
              executions: 7,
              succeeded: 7,
              failed: 0,
              p50Ms: 1_240,
              p95Ms: 3_105,
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

const scope = (page: Page) => page.locator('[data-locale-scope]');

/**
 * The server-rendered page already passes the language checks; the overview tables come from the
 * client, so once one shows, the page is hydrated and controls react (a click before hydration
 * would be undone by React).
 */
async function hydrated(page: Page) {
  await expect(scope(page).locator('table').first()).toBeVisible();
}

/** The admin island speaks `admin`; the document (and so the shell) keeps `profile`. */
async function expectLanguages(page: Page, profile: Profile, admin: AdminLocale) {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', profile);
  await expect(html).toHaveAttribute('dir', profile === 'ar' ? 'rtl' : 'ltr');
  await expect(scope(page)).toHaveAttribute('lang', admin);
  await expect(scope(page)).toHaveAttribute('dir', admin === 'ar' ? 'rtl' : 'ltr');
  await expect(scope(page).getByRole('heading', { level: 1 })).toHaveText(TITLE[admin]);
  await expect(page).toHaveTitle(`${TITLE[admin]} · JARVIS`);
}

/* ------------------------------------------------------------------ overview */

for (const theme of THEMES) {
  for (const locale of ADMIN_LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`admin — overview — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const { api } = await openAdmin(page, context, baseURL!, {
        profile: locale,
        adminCookie: locale === 'ar' ? 'ar' : undefined,
        theme,
      });
      await expectLanguages(page, locale, locale);
      // Desktop: three tables; phones: the audit log is a stacked list instead.
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

/* ------------------------------------------------------------------ mixed shell / admin */

for (const { profile, admin, theme } of [
  { profile: 'en', admin: 'de', theme: 'light' },
  { profile: 'en', admin: 'ar', theme: 'dark' },
  { profile: 'ar', admin: 'de', theme: 'light' },
  { profile: 'de', admin: 'ar', theme: 'light' },
] as const) {
  const variant = `${theme}--${admin}--${profile}-shell`;

  test(`admin — ${profile} shell around the ${admin} admin page — ${theme}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const { api } = await openAdmin(page, context, baseURL!, {
      profile,
      adminCookie: admin === 'ar' ? 'ar' : undefined,
      theme,
    });
    await expectLanguages(page, profile, admin);
    // The shell keeps the profile's language: its Admin entry (sidebar on desktop, account
    // menu on phones) and the bottom tab bar.
    if (testInfo.project.name === 'desktop') {
      await expect(
        page.locator('aside').getByRole('link', { name: SHELL_ADMIN[profile] }),
      ).toBeVisible();
    } else {
      await expect(page.locator('[data-tabbar]')).toContainText(catalogs[profile].shell.nav.home);
    }
    // The page's own header (title, switch, refresh) stays on the admin page's start edge.
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const h1 = await box('[data-locale-scope] h1');
    const refresh = await box('[data-locale-scope] header button');
    if (admin === 'ar') expect(h1.x).toBeGreaterThan(refresh.x);
    else expect(h1.x).toBeLessThan(refresh.x);
    await capture(page, testInfo, `admin--mixed--${variant}`);
    await expectNoSeriousA11yViolations(page);
    if (testInfo.project.name === 'mobile') {
      // Once the h1 scrolls under the top bar, the bar names the page as its h1 does: in the
      // admin language (not the shell's section name), with that language's lang and dir.
      await page.evaluate(() => window.scrollTo(0, 900));
      const barTitle = page.locator('header [data-visible]');
      await expect(barTitle).toHaveText(TITLE[admin]);
      await expect(barTitle).toHaveAttribute('lang', admin);
      await expect(barTitle).toHaveAttribute('dir', admin === 'ar' ? 'rtl' : 'ltr');
      await page.waitForTimeout(300);
      await capture(page, testInfo, `admin--mixed-scrolled--${variant}`, { fullPage: false });
    }
    expect(api.errors).toEqual([]);
  });
}

/* ------------------------------------------------------------------ language switch */

test('admin — the language switch changes only the admin page, for this browser', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const { api } = await openAdmin(page, context, baseURL!, { profile: 'en', theme: 'light' });
  await expectLanguages(page, 'en', 'de');
  await hydrated(page);

  // Exactly two choices, each named in its own language.
  const switcher = scope(page).getByRole('group', { name: 'Sprache der Administration' });
  await expect(switcher.getByRole('radio')).toHaveCount(2);
  await expect(switcher.getByRole('radio', { name: 'Deutsch' })).toBeChecked();
  await expect(switcher.locator('[lang="de"]')).toHaveText('Deutsch');
  await expect(switcher.locator('[lang="ar"]')).toHaveText('العربية');

  await switcher.locator('label', { hasText: 'العربية' }).click();
  await expectLanguages(page, 'en', 'ar');
  await expect(
    scope(page).getByRole('group', { name: 'لغة لوحة الإدارة' }).getByRole('radio', {
      name: 'العربية',
    }),
  ).toBeChecked();
  const cookie = (await context.cookies()).find((c) => c.name === ADMIN_COOKIE);
  expect(cookie?.value).toBe('ar');
  // The profile's language is untouched: no PATCH /v1/me, the locale cookie still says en.
  expect(api.calls).not.toContain('updateMe');
  expect((await context.cookies()).find((c) => c.name === 'jarvis_locale')?.value).toBe('en');
  await capture(page, testInfo, 'admin--switched--light--ar--en-shell', { fullPage: false });

  // The server renders the chosen language in the first paint (no flash of German).
  const html = await (await page.request.get('/admin')).text();
  expect(html).toMatch(/<div lang="ar" dir="rtl"[^>]*data-locale-scope/);
  expect(html).toContain(`<title>${TITLE.ar} · JARVIS</title>`);
  await page.reload();
  await expectLanguages(page, 'en', 'ar');
  await hydrated(page);

  // Keyboard: the switch is a radio group (arrow keys move the choice).
  await scope(page).getByRole('radio', { name: 'العربية' }).focus();
  await page.keyboard.press('ArrowRight');
  await expectLanguages(page, 'en', 'de');
  expect((await context.cookies()).find((c) => c.name === ADMIN_COOKIE)?.value).toBe('de');
  expect(api.errors).toEqual([]);
});

for (const value of ['en', 'fr', 'AR', '']) {
  test(`admin — an admin language cookie of "${value}" reads as German`, async ({
    page,
    context,
    baseURL,
  }) => {
    await openAdmin(page, context, baseURL!, { profile: 'en', adminCookie: value, theme: 'light' });
    await expectLanguages(page, 'en', 'de');
  });
}

/* ------------------------------------------------------------------ no English */

/** Every English admin string that is not also German or Arabic (copy, not names). */
function englishOnlyCopy(): string[] {
  const out = new Set<string>();
  const walk = (en: unknown, de: unknown, ar: unknown) => {
    if (typeof en === 'string') {
      // Literal fragments of a template ("Updated {time}" → "Updated").
      for (const part of en.split(/\{[^}]*\}|[#·—–]/)) {
        const text = part.replace(/[{}]/g, '').trim();
        if (text.length < 4 || text === de || text === ar) continue;
        if (typeof de === 'string' && de.includes(text)) continue;
        out.add(text);
      }
      return;
    }
    if (!en || typeof en !== 'object') return;
    for (const k of Object.keys(en)) {
      walk(
        (en as Record<string, unknown>)[k],
        (de as Record<string, unknown>)[k],
        (ar as Record<string, unknown>)[k],
      );
    }
  };
  walk(catalogs.en.admin, catalogs.de.admin, catalogs.ar.admin);
  for (const ns of ['taskStatus', 'tools', 'time'] as const) {
    walk(catalogs.en.common[ns], catalogs.de.common[ns], catalogs.ar.common[ns]);
  }
  walk(catalogs.en.common.actions.loadMore, catalogs.de.common.actions.loadMore, '');
  return [...out];
}

/** Raw values the server sends that must never be shown as labels. */
const RAW_VALUES = [
  'platform_admin',
  'owner',
  'member',
  'active',
  'disabled',
  'admin.users_viewed',
  'approval.requested',
  'task.created',
  'auth.login',
  'auth.login_failed',
  'connection.tested',
  'memory.saved',
  'web.fetch',
  'text.summarize',
  'email.send',
  'calendar.create_event',
  'memory.save',
  'COMPLETED',
  'AWAITING_APPROVAL',
  'task_step',
  'NO_API_KEY',
];

for (const admin of ADMIN_LOCALES) {
  test(`admin — no English copy and no raw values for an English profile — ${admin}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const { api } = await openAdmin(page, context, baseURL!, {
      profile: 'en',
      adminCookie: admin === 'ar' ? 'ar' : undefined,
      theme: 'light',
      users: 30,
      audit: 40,
      fixtures: (f) => ({
        ...f,
        adminOverview: {
          ...f.adminOverview,
          health: {
            ...f.adminOverview.health,
            planner: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
          },
        },
      }),
    });
    await expectLanguages(page, 'en', admin);
    if (testInfo.project.name === 'desktop') {
      await scope(page).getByRole('switch').check();
    }
    const text = await scope(page).innerText();
    const english = englishOnlyCopy();
    expect(english.length).toBeGreaterThan(100);
    const shown = english.filter((s) =>
      new RegExp(`(^|[^\\p{L}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(
        text,
      ),
    );
    expect(shown).toEqual([]);
    const raw = RAW_VALUES.filter((v) =>
      new RegExp(`(^|[^\\w.])${v.replace(/\./g, '\\.')}($|[^\\w.])`).test(text),
    );
    expect(raw).toEqual([]);
    // Nor in names that assistive technology reads (regions, lists, groups).
    const names = await scope(page)
      .locator('[aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    expect(names.filter((n) => english.includes(n))).toEqual([]);
    expect(await page.title()).not.toContain(catalogs.en.admin.title + ' ·');
    expect(api.errors).toEqual([]);
  });
}

test('admin — values of a newer server are named generically, never left blank', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const { api } = await openAdmin(page, context, baseURL!, {
    profile: 'en',
    theme: 'light',
    audit: 0,
    fixtures: (f) => ({
      ...f,
      adminOverview: {
        ...f.adminOverview,
        tasksByStatus: { COMPLETED: 4, ARCHIVED: 2 },
        toolReliability: [
          { toolId: 'video.render', executions: 3, succeeded: 3, failed: 0, p50Ms: 9, p95Ms: 12 },
        ],
      },
    }),
    overrides: {
      adminAudit: () => ({
        body: {
          items: [
            {
              id: '9',
              at: new Date(Date.now() - 5 * MIN).toISOString(),
              tenantId: IDS.tenant,
              actorType: 'system',
              actorId: null,
              action: 'invoice.paid',
              targetType: 'invoice',
              targetId: 'inv_204',
            },
          ],
          nextCursor: null,
        },
      }),
    },
  });
  const main = scope(page);
  await expect(main.getByText('Anderer Status')).toBeVisible();
  await expect(main.getByText('Anderes Werkzeug')).toBeVisible();
  await expect(main.getByText('video.render')).toBeVisible();
  await expect(main.getByText('Anderes Ereignis').filter({ visible: true })).toBeVisible();
  await expect(main.getByText('invoice.paid').filter({ visible: true })).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await expect(main.getByText('Anderes Objekt')).toBeVisible();
  }
  expect(api.errors).toEqual([]);
});

/* ------------------------------------------------------------------ states */

for (const { theme, profile, admin } of [
  { theme: 'light', profile: 'en', admin: 'de' },
  { theme: 'dark', profile: 'ar', admin: 'ar' },
  { theme: 'light', profile: 'de', admin: 'de' },
] as const) {
  const variant = `${theme}--${admin}--${profile}-shell`;

  test(`admin — not a platform admin — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const { api } = await openAdmin(page, context, baseURL!, {
      profile,
      adminCookie: admin === 'ar' ? 'ar' : undefined,
      theme,
      admin: false,
    });
    await expectLanguages(page, profile, admin);
    await expect(page.locator('main').getByRole('link')).toBeVisible();
    await expect(scope(page)).toContainText(catalogs[admin].admin.forbidden);
    await capture(page, testInfo, `admin--forbidden--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.calls.filter((c) => c.startsWith('admin'))).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test(`admin — degraded system — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
    const { api } = await openAdmin(page, context, baseURL!, {
      profile,
      adminCookie: admin === 'ar' ? 'ar' : undefined,
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
    await expect(page.getByText(/^(Im Rückstand:|تأخّر في المعالجة:)/)).toBeVisible();
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
    profile: 'en',
    theme: 'light',
    users: 30,
    audit: 40,
  });
  const usersTable = page.getByRole('table', { name: 'Konten in dieser Installation' });
  // The audit log is a table from 640 px and a stacked list (one entry per event) on phones.
  const auditRows =
    testInfo.project.name === 'mobile'
      ? page
          .getByRole('list', { name: 'Sicherheitsrelevante Aktionen, neueste zuerst' })
          .getByRole('listitem')
      : page
          .getByRole('table', { name: 'Sicherheitsrelevante Aktionen, neueste zuerst' })
          .locator('tbody tr');
  await expect(usersTable.locator('tbody tr')).toHaveCount(25);
  await expect(auditRows).toHaveCount(25);
  await page.getByRole('button', { name: 'Mehr laden' }).first().click();
  await expect(usersTable.locator('tbody tr')).toHaveCount(35);
  await page.getByRole('button', { name: 'Mehr laden' }).click();
  await expect(auditRows).toHaveCount(40);
  await expect(page.getByRole('button', { name: 'Mehr laden' })).toHaveCount(0);

  const before = api.calls.filter((c) => c === 'adminOverview').length;
  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect
    .poll(() => api.calls.filter((c) => c === 'adminOverview').length)
    .toBeGreaterThan(before);

  if (testInfo.project.name === 'mobile') {
    // The table scrolls inside its card; the page itself does not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scroller = page.getByRole('region', { name: 'Konten in dieser Installation' });
    await scroller.evaluate(
      (el) =>
        (el.scrollLeft = el.scrollWidth * (getComputedStyle(el).direction === 'rtl' ? -1 : 1)),
    );
    await scroller.scrollIntoViewIfNeeded();
    await capture(page, testInfo, 'admin--users-scrolled--light--de--en-shell', {
      fullPage: false,
    });
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
    if (msg.type() === 'error' || /\[i18n\] missing/.test(msg.text()))
      problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = list;
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await openAdmin(page, context, baseURL!, { profile: 'en', adminCookie: 'ar', theme: 'light' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp).toEqual([]);
  expect(problems).toEqual([]);
});
