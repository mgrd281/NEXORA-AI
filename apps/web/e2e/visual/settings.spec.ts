/**
 * Settings with the contract-validated mock API: light + dark × en + de + ar on desktop and
 * mobile (full page), the #assistant deep link, the assistant with an AI model near its budget
 * and an unhealthy worker, the delete-account dialog, a failed save, and the real flows (switches,
 * name, theme, language with dir, time zone, budget, export download, revoke a device, delete
 * account). Screenshots: test-results/screenshots/settings--<state>--<theme>--<locale>--<viewport>.png
 */
import type { RouteName, SessionInfo } from '@jarvis/contracts';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { type Fixtures } from '../support/fixtures';
import {
  MOCK_PASSWORD,
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

/** Three signed-in devices: this browser, the iPhone app and an older Windows laptop. */
function sessionsFor(f: Fixtures): SessionInfo[] {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  return [
    f.sessions[0]!,
    {
      id: '5e1d2c3b-4a59-4687-9a1b-2c3d4e5f6a71',
      deviceName: 'Layla’s iPhone',
      platform: 'ios',
      userAgent: 'JarvisApp/0.1 CFNetwork/1568 Darwin/25.0.0',
      createdAt: at(-12 * DAY),
      lastUsedAt: at(-3 * HOUR),
      expiresAt: at(18 * DAY),
      current: false,
    },
    {
      id: '6f2e3d4c-5b6a-4798-8b2c-3d4e5f6a7b82',
      deviceName: null,
      platform: 'web',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      createdAt: at(-26 * DAY),
      lastUsedAt: at(-9 * DAY),
      expiresAt: at(4 * DAY),
      current: false,
    },
  ];
}

/** This month so far: a few dollars of model use. */
function withUsage(f: Fixtures): Fixtures {
  return {
    ...f,
    sessions: sessionsFor(f),
    usage: {
      ...f.usage,
      aiMicroUsd: 4_820_000,
      toolMicroUsd: 120_000,
      totalMicroUsd: 4_940_000,
      tasks: { completed: 23, failed: 2, total: 27 },
    },
  };
}

const settingsRoutes: Partial<Record<RouteName, MockHandler>> = {
  revokeSession: (req, s) => {
    s.sessions = s.sessions.filter((x) => x.id !== req.params.id);
    return { status: 204 };
  },
  exportAccount: (_req, s) => ({
    body: {
      format: 'jarvis.account-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      account: s.me,
      memories: s.memories,
      connections: s.connections,
    },
  }),
  deleteAccount: (req) =>
    (req.body as { password: string }).password === MOCK_PASSWORD
      ? { status: 204 }
      : {
          status: 403,
          body: {
            error: { code: 'FORBIDDEN', message: 'The password is incorrect.', requestId: 'mock' },
          },
        },
};

async function openSettings(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  {
    locale,
    theme,
    fixtures,
    overrides,
    path = '/settings',
    planner,
  }: {
    locale: Locale;
    theme: 'light' | 'dark';
    fixtures?: (f: Fixtures) => Fixtures;
    overrides?: MockApiOptions['overrides'];
    path?: string;
    planner?: 'offline' | 'model';
  },
) {
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, {
    locale,
    theme,
    planner,
    fixtures: (f) => (fixtures ? fixtures(withUsage(f)) : withUsage(f)),
    overrides: { ...settingsRoutes, ...overrides },
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Everything that loads on its own has arrived: status, usage and devices.
  await expect(page.locator('#assistant dl').first()).toBeVisible();
  await expect(page.locator('[role="meter"]')).toBeVisible();
  await expect(page.locator('#security li').first()).toBeVisible();
  return api;
}

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`settings — all sections — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await openSettings(page, context, baseURL!, { locale, theme });
      await capture(page, testInfo, `settings--all--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
}

const STATE_VARIANTS = [
  { theme: 'light', locale: 'en' },
  { theme: 'dark', locale: 'ar' },
  { theme: 'light', locale: 'de' },
] as const;

for (const { theme, locale } of STATE_VARIANTS) {
  const variant = `${theme}--${locale}`;

  test(`settings — #assistant deep link, model near budget, worker down — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openSettings(page, context, baseURL!, {
      locale,
      theme,
      planner: 'model',
      path: '/settings#assistant',
      fixtures: (f) => ({
        ...f,
        assistantStatus: {
          ...f.assistantStatus,
          worker: { healthy: false, lastHeartbeatAt: new Date(Date.now() - 4 * MIN).toISOString() },
        },
        usage: { ...f.usage, aiMicroUsd: 17_400_000, totalMicroUsd: 17_520_000 },
      }),
    });
    await expect(page.locator('#assistant h2')).toBeInViewport();
    await capture(page, testInfo, `settings--assistant--${variant}`, { fullPage: false });
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });

  test(`settings — delete account dialog — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openSettings(page, context, baseURL!, { locale, theme });
    await page.locator('#privacy button').last().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill('not my password');
    await dialog.locator('input').nth(1).fill('DELETE');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.locator('[aria-invalid="true"]')).toBeVisible();
    await capture(page, testInfo, `settings--delete-account--${variant}`, { fullPage: false });
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

test('settings — a failed save reverts the switch and says why', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const api = await openSettings(page, context, baseURL!, {
    locale: 'en',
    theme: 'light',
    overrides: {
      updateMe: () => ({
        status: 503,
        delayMs: 600,
        body: { error: { code: 'INTERNAL', message: 'Service unavailable', requestId: 'req_9c1' } },
      }),
    },
  });
  const toggle = page.getByRole('switch', { name: 'Completed tasks' });
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t save.' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await capture(page, testInfo, 'settings--save-failed--light--en', { fullPage: false });
  expect(api.errors).toEqual([]);
});

test('settings — every control saves through PATCH /v1/me', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Interaction flow runs once, on desktop');
  const api = await openSettings(page, context, baseURL!, { locale: 'en', theme: 'light' });
  const patch = () =>
    page.waitForRequest((r) => r.url().endsWith('/api/v1/me') && r.method() === 'PATCH');

  // Sub-navigation marks the section in view and moves focus to it.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Notifications' })
    .click();
  await expect(page.locator('#notifications h2')).toBeFocused();
  await expect(page).toHaveURL(/#notifications$/);

  // A switch.
  let request = patch();
  await page.getByRole('switch', { name: 'Failed tasks' }).click();
  expect((await request).postDataJSON()).toEqual({
    preferences: { notifications: { taskFailed: false } },
  });
  await expect(page.getByRole('switch', { name: 'Failed tasks' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(
    page.locator('#notifications').getByRole('status').filter({ hasText: 'Saved' }),
  ).toBeVisible();

  // Auto-approve explains the exact rule with the account's address.
  // (The interpolated address is direction-isolated: optional FSI/PDI around it.)
  await expect(page.locator('#assistant')).toContainText(
    /an email whose recipients are all your own address \(\u2068?layla\.haddad@example\.com\u2069?\) is sent without asking first/,
  );

  // Display name: saves when the field is left (no Save button), Enter saves too.
  const name = page.getByRole('textbox', { name: 'Display name' });
  await expect(page.getByRole('button', { name: /^Save (name|budget)$/ })).toHaveCount(0);
  await name.fill('Layla K. Haddad');
  request = patch();
  await name.press('Tab');
  expect((await request).postDataJSON()).toEqual({ displayName: 'Layla K. Haddad' });
  await name.fill('Layla Haddad');
  request = patch();
  await name.press('Enter');
  expect((await request).postDataJSON()).toEqual({ displayName: 'Layla Haddad' });

  // Budget (validated on leaving the field, then saved).
  const budget = page.getByRole('textbox', { name: 'Monthly AI budget' });
  await budget.fill('abc');
  await budget.press('Tab');
  await expect(page.getByText('Enter an amount from 0 to 10,000.')).toBeVisible();
  await budget.fill('35.50');
  request = patch();
  await budget.press('Tab');
  expect((await request).postDataJSON()).toEqual({
    preferences: { spending: { monthlyAiBudgetUsd: 35.5 } },
  });

  // Time zone and recognition language.
  request = patch();
  await page.getByRole('combobox', { name: 'Time zone' }).selectOption('America/New_York');
  expect((await request).postDataJSON()).toEqual({ timeZone: 'America/New_York' });
  request = patch();
  await page.getByRole('combobox', { name: 'Recognition language' }).selectOption('de-DE');
  expect((await request).postDataJSON()).toEqual({
    preferences: { voice: { recognitionLocale: 'de-DE' } },
  });

  // Theme applies at once.
  request = patch();
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true });
  expect((await request).postDataJSON()).toEqual({ theme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Export downloads the JSON file.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^jarvis-export-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.getByText(/^Downloaded \u2068?jarvis-export-/)).toBeVisible();

  // Revoke another device; this device can only sign out.
  await expect(page.getByRole('button', { name: 'Sign out on this device' })).toBeVisible();
  // Device names are direction-isolated (nested FSI…PDI), hence \W+ between the words.
  await page.getByRole('button', { name: /^Sign out\W+Firefox\W+on\W+Windows\W*$/ }).click();
  await expect(page.getByText(/^Signed out\W+Firefox\W+on\W+Windows\W*$/)).toBeVisible();
  await expect(page.locator('#security li')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Signed-in devices' })).toBeFocused();

  // Language applies immediately: lang, dir and the catalog change.
  request = patch();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ar');
  expect((await request).postDataJSON()).toEqual({ locale: 'ar' });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الإعدادات');
  expect(api.errors).toEqual([]);
});

test('settings — delete account needs the password and DELETE, then signs out', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Interaction flow runs once, on desktop');
  const api = await openSettings(page, context, baseURL!, { locale: 'en', theme: 'light' });
  await page.getByRole('button', { name: 'Delete account…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  const confirm = dialog.getByRole('button', { name: 'Delete account permanently' });
  await expect(dialog.getByLabel('Your password')).toBeFocused();
  await dialog.getByLabel('Your password').fill(MOCK_PASSWORD);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('delete');
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
  const request = page.waitForRequest((r) => r.url().endsWith('/api/v1/account/delete'));
  await confirm.click();
  expect((await request).postDataJSON()).toEqual({
    password: MOCK_PASSWORD,
    confirmation: 'DELETE',
  });
  await page.waitForURL(/\/sign-in$/);
  expect(api.errors).toEqual([]);
});

test('settings — hydrates under the CSP without console errors', async ({
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
  await openSettings(page, context, baseURL!, { locale: 'en', theme: 'light' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp).toEqual([]);
  expect(problems).toEqual([]);
});
