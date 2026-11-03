/**
 * Home with the contract-validated mock API: populated, busy (model planner), first run,
 * loading and error — light + dark × en + de + ar on desktop and mobile, axe on each — plus
 * behaviour (Review opens the approval sheet, command chips fill the composer without
 * submitting, connect chips navigate).
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3101 pnpm --filter @jarvis/web exec playwright test e2e/visual/home.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import type { HomeSnapshot, TaskSummary } from '@jarvis/contracts';
import type { FixtureLocale, Fixtures } from '../support/fixtures';
import { mockApi, signInWithMock, type MockApiOptions } from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'de', 'ar'] as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Extra recent results for the busy Home (localized user content). */
const RECENT: Record<FixtureLocale, { title: string; result: string }[]> = {
  en: [
    {
      title: 'What changed between WCAG 2.1 and 2.2',
      result: 'Answered your question about WCAG 2.2.',
    },
    {
      title: 'Summarize the Q3 product newsletter',
      result: 'Summary of “Q3 product newsletter” is ready.',
    },
    {
      title: 'Email me: call the dentist on Friday',
      result: 'Sent “Call the dentist on Friday” to layla.haddad@example.com.',
    },
  ],
  de: [
    {
      title: 'Änderungen zwischen WCAG 2.1 und 2.2',
      result: 'Ihre Frage zu WCAG 2.2 wurde beantwortet.',
    },
    {
      title: 'Produkt-Newsletter Q3 zusammenfassen',
      result: 'Die Zusammenfassung des „Produkt-Newsletters Q3“ ist fertig.',
    },
    {
      title: 'Mail an mich: Freitag Zahnarzt anrufen',
      result: '„Freitag Zahnarzt anrufen“ an layla.haddad@example.com gesendet.',
    },
  ],
  ar: [
    {
      title: 'التغييرات بين WCAG 2.1 و2.2',
      result: 'تمت الإجابة عن سؤالك حول WCAG 2.2.',
    },
    {
      title: 'تلخيص النشرة الإخبارية للربع الثالث',
      result: 'ملخص «النشرة الإخبارية للربع الثالث» جاهز.',
    },
    {
      title: 'راسلني: الاتصال بطبيب الأسنان يوم الجمعة',
      result: 'أُرسلت «الاتصال بطبيب الأسنان يوم الجمعة» إلى layla.haddad@example.com.',
    },
  ],
};

/** A task that has just been asked and is being planned. */
const PLANNING: Record<FixtureLocale, string> = {
  en: 'Summarize the European Accessibility Act FAQ',
  de: 'FAQ zum European Accessibility Act zusammenfassen',
  ar: 'تلخيص الأسئلة الشائعة حول قانون الإتاحة الأوروبي',
};

const RECENT_IDS = [
  'd0b90001-0000-4000-8000-000000000001',
  'd0b90001-0000-4000-8000-000000000002',
  'd0b90001-0000-4000-8000-000000000003',
];

/** A busy day: the model planner, two tasks running, five recent results. */
function busy(locale: FixtureLocale, now: number) {
  return (f: Fixtures): Fixtures => {
    const at = (offset: number) => new Date(now + offset).toISOString();
    const recent: TaskSummary[] = RECENT[locale].map((r, i) => ({
      id: RECENT_IDS[i]!,
      title: r.title,
      request: r.title,
      status: 'COMPLETED',
      riskLevel: i === 2 ? 'MEDIUM' : 'LOW',
      source: i === 0 ? 'voice' : 'text',
      progress: { completed: 1, total: 1 },
      pendingApprovalId: null,
      resultSummary: r.result,
      error: null,
      createdAt: at(-(5 + i * 6) * HOUR),
      updatedAt: at(-(5 + i * 6) * HOUR + 9_000),
      completedAt: at(-(5 + i * 6) * HOUR + 9_000),
    }));
    const planning: TaskSummary = {
      ...f.home.activeTasks[0]!,
      id: 'd0b90001-0000-4000-8000-000000000009',
      title: PLANNING[locale],
      request: PLANNING[locale],
      status: 'PLANNING',
      source: 'text',
      progress: { completed: 0, total: 0 },
      createdAt: at(-5_000),
      updatedAt: at(-4_000),
    };
    const home: HomeSnapshot = {
      ...f.home,
      activeTasks: [f.home.activeTasks[0]!, planning, ...f.home.activeTasks.slice(1)],
      // Newest first, like the API (updated_at desc).
      recentTasks: [...f.home.recentTasks, ...recent]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5),
    };
    return { ...f, home };
  };
}

/** A new account: nothing asked yet; email not connected; memory empty. */
function firstRun(f: Fixtures): Fixtures {
  const assistant = {
    ...f.assistantStatus,
    capabilities: { ...f.assistantStatus.capabilities, email: false },
  };
  return {
    ...f,
    assistantStatus: assistant,
    connections: f.connections.filter((c) => c.provider !== 'smtp'),
    memories: [],
    tasks: [],
    approvals: [],
    notifications: [],
    home: {
      ...f.home,
      pendingApprovals: [],
      activeTasks: [],
      recentTasks: [],
      unreadNotifications: 0,
      assistant,
      suggestions: [
        {
          id: 'connect-email',
          kind: 'connect',
          messageKey: 'suggest.connectEmail',
          command: null,
          href: '/connections',
        },
        {
          id: 'configure-model',
          kind: 'review',
          messageKey: 'suggest.configureModel',
          command: null,
          href: '/settings#assistant',
        },
        {
          id: 'remember',
          kind: 'command',
          messageKey: 'suggest.remember',
          command: null,
          href: null,
        },
      ],
    },
  };
}

async function openHome(
  page: Page,
  context: Parameters<typeof signInWithMock>[0],
  baseURL: string,
  locale: FixtureLocale,
  theme: 'light' | 'dark',
  options: MockApiOptions = {},
) {
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, { locale, theme, ...options });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  return api;
}

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`home — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await openHome(page, context, baseURL!, locale, theme);
      // The greeting uses the first name from the profile.
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Layla');
      await expect(page.locator('main h2')).toHaveCount(3);
      await capture(page, testInfo, `home--default--${variant}`);
      await expectNoSeriousA11yViolations(page);

      // Review opens the approval sheet.
      await page.locator('main section').first().getByRole('button').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await capture(page, testInfo, `home--review--${variant}`, { fullPage: false });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(api.errors).toEqual([]);
    });

    test(`home: first run — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await openHome(page, context, baseURL!, locale, theme, { fixtures: firstRun });
      await expect(page.locator('main h2')).toHaveCount(1);
      await capture(page, testInfo, `home--first-run--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`home: busy with an AI model — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const now = Date.now();
      const api = await openHome(page, context, baseURL!, locale, theme, {
        planner: 'model',
        now,
        fixtures: busy(locale, now),
      });
      await expect(page.locator('main h2')).toHaveCount(3);
      await capture(page, testInfo, `home--busy--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
}

test.describe('home states', () => {
  for (const [theme, locale] of [
    ['light', 'en'],
    ['dark', 'ar'],
    ['light', 'de'],
  ] as const) {
    const variant = `${theme}--${locale}`;

    test(`error and loading — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const failing = await openHome(page, context, baseURL!, locale, theme, {
        overrides: {
          getHome: () => ({
            status: 503,
            body: {
              error: { code: 'INTERNAL', message: 'Database unavailable', requestId: 'req_51c0de' },
            },
          }),
        },
      });
      await expect(page.locator('main [role="alert"]').first()).toBeVisible({ timeout: 15_000 });
      // The composer still works while the overview is unavailable, and the status line does
      // not claim a state it cannot know.
      await expect(page.getByRole('textbox')).toBeVisible();
      if (locale === 'en')
        await expect(page.locator('main header p').first()).not.toContainText('Ready');
      await capture(page, testInfo, `home--error--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(failing.errors).toEqual([]);

      // Loading last: its delayed response is still pending when the test ends.
      await page.unroute('**/api/v1/**');
      await mockApi(page, {
        locale,
        theme,
        overrides: { getHome: (_r, s) => ({ body: s.home, delayMs: 8000 }) },
      });
      await page.goto('/');
      await expect(page.locator('main [aria-busy="true"]')).toBeVisible();
      await capture(page, testInfo, `home--loading--${variant}`);
    });
  }
});

test.describe('home behaviour', () => {
  test.skip(({ isMobile }) => isMobile, 'Behaviour is covered once on desktop');

  test('a command chip fills the composer and never submits', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await openHome(page, context, baseURL!, 'en', 'light', { fixtures: firstRun });
    const composer = page.getByRole('textbox', { name: 'Ask JARVIS' });
    // A first-run example fills the composer.
    await page.getByRole('button', { name: 'Summarize https://www.w3.org/TR/WCAG22/' }).click();
    await expect(composer).toHaveValue('Summarize https://www.w3.org/TR/WCAG22/');
    await page.waitForTimeout(300);
    expect(api.calls).not.toContain('createTask');
    // A connect chip opens Connections.
    await page.getByRole('link', { name: /Connect your email/ }).click();
    await page.waitForURL('**/connections');
    expect(api.errors).toEqual([]);
  });

  test('approving from Home refreshes the sections', async ({ page, context, baseURL }) => {
    const api = await openHome(page, context, baseURL!, 'en', 'light', {
      overrides: {
        decideApproval: (req, s) => {
          const a = s.approvals[0]!;
          const decided = {
            ...a,
            status: 'APPROVED' as const,
            decidedAt: new Date().toISOString(),
          };
          s.approvals = [decided];
          s.home = {
            ...s.home,
            pendingApprovals: [],
            activeTasks: s.home.activeTasks.map((t) =>
              t.id === a.taskId ? { ...t, status: 'RUNNING' as const, pendingApprovalId: null } : t,
            ),
          };
          void req;
          return { body: decided };
        },
      },
    });
    await page.getByRole('button', { name: /^Review:/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Approve and send this email' })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // "Needs you" disappears; the task now shows under In progress, and has the focus.
    await expect(page.locator('main h2')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 2, name: /Needs you/ })).toHaveCount(0);
    await expect(
      page.locator(`#main a[href="/tasks/${api.state.approvals[0]!.taskId}"]`),
    ).toBeFocused();
    expect(api.calls).toContain('decideApproval');
    expect(api.errors).toEqual([]);
  });
});
