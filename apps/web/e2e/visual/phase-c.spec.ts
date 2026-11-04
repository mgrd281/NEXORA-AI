/**
 * Phase C screens with the contract-validated mock API (docs/architecture/phase-c.md §3.9):
 * Connections (Google / Microsoft: not configured, connect with capabilities, connected,
 * expired → Reconnect, disconnect with what it revokes, the OAuth callback page with resumable
 * tasks), Home "Upcoming" (conflicts, an expired source; absent without a calendar), the
 * approval sheets for calendar events, bookings, purchases, form submissions and email drafts,
 * task detail (email results, product comparison with evidence screenshots in a lightbox, slots,
 * a confirmed booking with its ICS file, a placed order, handovers, CONNECTION_EXPIRED,
 * CAPTCHA_DETECTED, LOGIN_REQUIRED, SITE_UNSUPPORTED, PURCHASES_DISABLED, PURCHASE_LIMIT,
 * ORDER_UNKNOWN) and Settings › Spending and Reply tracking — light + dark × en + de + ar on
 * desktop and mobile, axe on every state — plus the interactions on desktop.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3501 npx playwright test e2e/visual/phase-c.spec.ts
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureLocale } from '../support/fixtures';
import { mockApi, signInWithMock, type MockApiOptions } from '../support/mock-api';
import { PC, withPhaseC, type PhaseCOptions } from '../support/phase-c';
import { capture, expectNoSeriousA11yViolations, SCREENSHOT_DIR } from '../support/visual';

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'de', 'ar'] as const;
type Theme = (typeof THEMES)[number];

/** Every theme × locale, or (for secondary states) light English and dark Arabic only. */
function variants(all = true): Array<{ theme: Theme; locale: FixtureLocale; name: string }> {
  const out: Array<{ theme: Theme; locale: FixtureLocale; name: string }> = [];
  for (const theme of THEMES)
    for (const locale of LOCALES)
      if (all || (theme === 'light' && locale === 'en') || (theme === 'dark' && locale === 'ar'))
        out.push({ theme, locale, name: `${theme}--${locale}` });
  return out;
}

/* ------------------------------------------------------------------ helpers */

async function open(
  page: Page,
  context: Parameters<typeof signInWithMock>[0],
  baseURL: string,
  {
    locale = 'en',
    theme = 'light',
    path: target,
    options = {},
    phaseC = {},
    connected = true,
  }: {
    locale?: FixtureLocale;
    theme?: Theme;
    path: string;
    options?: MockApiOptions;
    phaseC?: PhaseCOptions;
    /** false: the base account (no Phase C data: nothing connected, purchases off). */
    connected?: boolean;
  },
) {
  const now = Date.now();
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, {
    locale,
    theme,
    now,
    ...options,
    fixtures: (f) => {
      const rich = connected ? withPhaseC(f, locale, now, phaseC) : f;
      return options.fixtures ? options.fixtures(rich) : rich;
    },
  });
  await page.goto(target);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  return api;
}

/** A screenshot of one region (a card, a section). */
async function shot(locator: Locator, testInfo: TestInfo, name: string) {
  await locator.page().evaluate(() => document.fonts.ready);
  await locator.page().waitForTimeout(200);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}--${testInfo.project.name}.png`);
  await locator.screenshot({ path: file, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

/**
 * Loads every screenshot thumbnail now (they are lazy: below the fold they would only load on
 * scroll, so a full-page capture would show empty frames) and waits until each has decoded.
 */
async function imagesLoaded(page: Page) {
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img')) img.loading = 'eager';
  });
  await page.waitForFunction(() =>
    [...document.images].every((img) => !img.src || (img.complete && img.naturalWidth > 0)),
  );
}

/** Copy as rendered: interpolated values are wrapped in Unicode isolates. */
function loose(text: string): RegExp {
  const chars = [...text].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(chars.join('[\\u2066-\\u2069]*'));
}

/** Opens the task's approval sheet from its "Review and decide" panel. */
async function openApproval(page: Page) {
  const panel = page.locator('main section:has(h2[id^="approval-"])');
  await panel.getByRole('button').last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** POST /v1/tasks/:id/retry: the failed task is queued again (what the API answers). */
const retryOverride: MockApiOptions['overrides'] = {
  retryTask: (req, s) => {
    const d = s.taskDetails[req.params.id ?? ''];
    if (!d) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Task' } } };
    const next = {
      ...d,
      status: 'QUEUED' as const,
      error: null,
      canRetry: false,
      completedAt: null,
    };
    s.taskDetails[d.id] = next;
    s.tasks = s.tasks.map((t) => (t.id === d.id ? { ...t, status: 'QUEUED', error: null } : t));
    const {
      objective: _o,
      objectiveMessage: _m,
      planner: _p,
      answer: _a,
      steps: _s,
      approvals: _ap,
      events: _e,
      cost: _c,
      evidence: _ev,
      canCancel: _cc,
      canRetry: _cr,
      startedAt: _st,
      attachments: _at,
      browserSessions: _b,
      ...summary
    } = next;
    return { status: 202, body: summary };
  },
};

/* ------------------------------------------------------------------ connections */

for (const { theme, locale, name: variant } of variants()) {
  test(`connections — Google connected, Microsoft expired — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await open(page, context, baseURL!, { locale, theme, path: '/connections' });
    await expect(page.getByRole('heading', { name: 'Google', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Microsoft', level: 2 })).toBeVisible();
    await capture(page, testInfo, `phase-c--connections--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });

  test(`connections — connect choices and not configured — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await open(page, context, baseURL!, {
      locale,
      theme,
      path: '/connections',
      connected: false,
    });
    const google = page
      .locator('main section')
      .filter({ has: page.getByRole('heading', { name: 'Google' }) });
    await expect(google.getByRole('checkbox')).toHaveCount(5);
    await google.locator('details').first().locator('summary').click();
    await capture(page, testInfo, `phase-c--connections-connect--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });

  test(`connections — callback with resumable tasks — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await open(page, context, baseURL!, {
      locale,
      theme,
      path: `/connections/callback?code=mock-code-microsoft&state=mock-state-microsoft-${'x'.repeat(24)}`,
    });
    await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(page.locator('main li a[href^="/tasks/"]')).toHaveCount(1);
    // The code never stays in the address bar or the history.
    expect(new URL(page.url()).search).toBe('');
    await capture(page, testInfo, `phase-c--oauth-callback--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

/* ------------------------------------------------------------------ home */

for (const { theme, locale, name: variant } of variants()) {
  test(`home — upcoming with a conflict and an expired calendar — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await open(page, context, baseURL!, { locale, theme, path: '/' });
    const upcoming = page.locator('main section').filter({ has: page.locator('ol li h3') });
    await expect(upcoming).toBeVisible();
    await capture(page, testInfo, `phase-c--home-upcoming--${variant}`);
    await shot(upcoming, testInfo, `phase-c--home-upcoming-section--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

/* ------------------------------------------------------------------ approvals */

const APPROVALS = [
  { task: PC.buy, name: 'purchase', all: true },
  { task: PC.meet, name: 'calendar-event', all: true },
  { task: PC.book, name: 'booking', all: true },
  { task: PC.form, name: 'form-submission', all: false },
  { task: PC.draft, name: 'email-draft', all: false },
] as const;

for (const a of APPROVALS) {
  for (const { theme, locale, name: variant } of variants(a.all)) {
    test(`approval sheet — ${a.name} — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: `/tasks/${a.task}` });
      const dialog = await openApproval(page);
      await expect(dialog.getByRole('button', { name: /./ }).last()).toBeEnabled();
      await imagesLoaded(page);
      await capture(page, testInfo, `phase-c--approval-${a.name}--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
}

/* ------------------------------------------------------------------ task detail */

const TASKS = [
  { task: PC.replies, name: 'email-needs-reply', all: false },
  { task: PC.unread, name: 'email-unread-summary', all: false },
  { task: PC.compare, name: 'compare', all: true },
  { task: PC.slots, name: 'slots', all: true },
  { task: PC.booked, name: 'booked', all: true },
  { task: PC.ordered, name: 'ordered', all: false },
  { task: PC.expired, name: 'connection-expired', all: true },
  { task: PC.captcha, name: 'captcha', all: true },
  { task: PC.login, name: 'login-required', all: false },
  { task: PC.unsupported, name: 'site-unsupported', all: false },
  { task: PC.denied, name: 'purchases-disabled', all: true },
  { task: PC.overLimit, name: 'purchase-limit', all: false },
  { task: PC.unknown, name: 'order-unknown', all: false },
] as const;

for (const tk of TASKS) {
  for (const { theme, locale, name: variant } of variants(tk.all)) {
    test(`task detail — ${tk.name} — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${tk.task}`,
        // Scenario 7 as shipped: purchases are off by default.
        phaseC: tk.task === PC.denied ? { purchaseLimitUsd: 0 } : {},
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await imagesLoaded(page);
      await capture(page, testInfo, `phase-c--task-${tk.name}--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
}

/* ------------------------------------------------------------------ settings */

for (const { theme, locale, name: variant } of variants()) {
  test(`settings — spending and reply tracking — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await open(page, context, baseURL!, { locale, theme, path: '/settings#spending' });
    const spending = page.locator('#spending');
    await expect(spending.locator('li').first()).toBeVisible();
    await shot(spending, testInfo, `phase-c--settings-spending--${variant}`);
    const replies = page.locator('#replies');
    await expect(replies.locator('li').first()).toBeVisible();
    await shot(replies, testInfo, `phase-c--settings-replies--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

for (const { theme, locale, name: variant } of variants(false)) {
  test(`settings — purchases off by default — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await open(page, context, baseURL!, {
      locale,
      theme,
      path: '/settings#spending',
      connected: false,
    });
    const spending = page.locator('#spending');
    await expect(spending.getByRole('textbox')).toHaveValue('0');
    await shot(spending, testInfo, `phase-c--settings-spending-off--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

/* ------------------------------------------------------------------ evidence lightbox */

for (const { theme, locale, name: variant } of variants(false)) {
  test(`evidence lightbox — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
    const api = await open(page, context, baseURL!, {
      locale,
      theme,
      path: `/tasks/${PC.compare}`,
    });
    await imagesLoaded(page);
    const thumb = page.locator('main figure button').first();
    await thumb.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('img')).toHaveAttribute('alt', /127\.0\.0\.1:4599/);
    await imagesLoaded(page);
    await capture(page, testInfo, `phase-c--evidence-lightbox--${variant}`, { fullPage: false });
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(thumb).toBeFocused();
    expect(api.errors).toEqual([]);
  });
}

/* ------------------------------------------------------------------ interactions (desktop) */

test.describe('interactions', () => {
  test.skip(({ isMobile }) => isMobile, 'Interaction flows run on desktop');

  test('connect Google: least-privilege capabilities, PKCE redirect, callback', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/connections', connected: false });
    const google = page
      .locator('main section')
      .filter({ has: page.getByRole('heading', { name: 'Google' }) });
    // Read-only by default; "Change the calendar" brings "Read the calendar" with it (locked).
    await expect(google.getByRole('checkbox', { name: /Read email/ })).toBeChecked();
    await expect(google.getByRole('checkbox', { name: /Send email/ })).not.toBeChecked();
    await google.getByRole('checkbox', { name: /Read email/ }).uncheck();
    await google.getByRole('checkbox', { name: /Read the calendar/ }).uncheck();
    await google.getByRole('button', { name: loose('Continue to Google') }).click();
    await expect(google.getByRole('alert')).toHaveText('Choose at least one thing JARVIS may do.');
    expect(api.calls).not.toContain('startOAuthConnection');

    await google.getByRole('checkbox', { name: /Change the calendar/ }).check();
    await expect(google.getByRole('checkbox', { name: /Read the calendar/ })).toBeChecked();
    await expect(google.getByRole('checkbox', { name: /Read the calendar/ })).toBeDisabled();
    await google.locator('details summary').first().click();
    await expect(google.locator('details code')).toContainText([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
    ]);

    const start = page.waitForRequest((r) => r.url().endsWith('/api/v1/connections/oauth/start'));
    await google.getByRole('button', { name: loose('Continue to Google') }).click();
    expect((await start).postDataJSON()).toEqual({
      provider: 'google',
      capabilities: ['calendar.read', 'calendar.write'],
      redirectUri: `${new URL(baseURL!).origin}/connections/callback`,
      returnTo: '/connections',
    });
    // The mock's "consent page" answers at once: the callback finishes on this session.
    await page.waitForURL('**/connections/callback');
    await expect(page.getByRole('heading', { name: loose('Google is connected') })).toBeFocused();
    expect(api.calls).toContain('completeOAuthConnection');
    await page.getByRole('link', { name: 'Continue' }).click();
    await page.waitForURL('**/connections');
    expect(api.errors).toEqual([]);
  });

  test('reconnect an expired account and disconnect with what it revokes', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, {
      path: '/connections',
      options: { overrides: retryOverride },
    });
    const microsoft = page
      .locator('main section')
      .filter({ has: page.getByRole('heading', { name: 'Microsoft' }) });
    await expect(microsoft).toContainText(loose('Your Microsoft connection has expired'));
    await expect(microsoft).toContainText(loose('Read email and Read the calendar'));
    // Disconnect first: Microsoft has no revoke endpoint, so the dialog says where to remove it.
    await microsoft.getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Microsoft doesn’t let apps revoke their own access');
    await expect(dialog.getByRole('link', { name: /account\.live\.com/ })).toHaveAttribute(
      'href',
      'https://account.live.com/consent/Manage',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const start = page.waitForRequest((r) => r.url().endsWith('/api/v1/connections/oauth/start'));
    await microsoft.getByRole('button', { name: loose('Reconnect Microsoft') }).click();
    expect((await start).postDataJSON()).toMatchObject({
      provider: 'microsoft',
      capabilities: ['mail.read', 'calendar.read'],
      connectionId: PC.connMicrosoft,
    });
    await page.waitForURL('**/connections/callback');
    await expect(
      page.getByRole('heading', { name: loose('Microsoft is connected') }),
    ).toBeVisible();
    // The task that failed with CONNECTION_EXPIRED is offered for a retry.
    const retry = page.waitForRequest((r) => /\/api\/v1\/tasks\/[^/]+\/retry$/.test(r.url()));
    await page.getByRole('button', { name: /Retry/ }).click();
    expect(new URL((await retry).url()).pathname).toBe(`/api/v1/tasks/${PC.expired}/retry`);
    await expect(page.getByText('Retry started').first()).toBeVisible();
    expect(api.errors).toEqual([]);
  });

  test('purchase approval binds the decision to the exact action', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: `/tasks/${PC.buy}` });
    const dialog = await openApproval(page);
    await expect(dialog).toContainText('FX-200 Noise-Cancelling Headphones');
    await expect(dialog).toContainText('Visa •••• 4242');
    await expect(dialog.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      /\$44\.98.*\$149\.00.*\$200\.00/,
    );
    const decide = page.waitForRequest((r) =>
      r.url().includes(`/approvals/${PC.aPurchase}/decision`),
    );
    await dialog
      .getByRole('button', { name: loose('Approve and buy for $149.00 from Fixture Shop') })
      .click();
    const body = (await decide).postDataJSON() as { decision: string; actionHash: string };
    expect(body.decision).toBe('approve');
    expect(body.actionHash).toMatch(/^sha256:/);
    expect(api.errors).toEqual([]);
  });

  test('choosing a slot proposes the booking in the follow-up field', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: `/tasks/${PC.slots}` });
    await page
      .getByRole('button', { name: /^Choose / })
      .first()
      .click();
    const field = page.getByRole('textbox', { name: 'Follow-up to JARVIS' });
    await expect(field).toHaveValue(
      /^Book Check-up at Fixture Dental on \d{4}-\d{2}-\d{2} at 10:00$/,
    );
    expect(api.calls).not.toContain('followUp');
  });

  test('failed tasks offer the one next step', async ({ page, context, baseURL }) => {
    await open(page, context, baseURL!, { path: `/tasks/${PC.captcha}` });
    const open1 = page.getByRole('link', { name: /Open the site yourself/ }).first();
    await expect(open1).toHaveAttribute('href', 'http://127.0.0.1:4599/captcha');
    await expect(open1).toHaveAttribute('target', '_blank');

    await page.goto(`/tasks/${PC.overLimit}`);
    await expect(
      page
        .getByText(
          loose(
            'This purchase ($899.00) would go over your monthly limit of $200.00 ($44.98 already spent).',
          ),
        )
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Adjust the limit' })).toHaveAttribute(
      'href',
      '/settings#spending',
    );
  });

  test('home shows no Upcoming section without a calendar', async ({ page, context, baseURL }) => {
    await open(page, context, baseURL!, { path: '/', connected: false });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Upcoming/ })).toHaveCount(0);
  });

  test('set the purchase limit and stop watching a thread', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL!, { path: '/settings#spending' });
    const field = page.getByRole('textbox', { name: 'Monthly purchase limit' });
    await expect(field).toHaveValue('200');
    await field.fill('150');
    const save = page.waitForRequest(
      (r) => r.url().endsWith('/api/v1/me') && r.method() === 'PATCH',
    );
    await field.press('Enter');
    expect((await save).postDataJSON()).toEqual({
      preferences: { spending: { monthlyPurchaseLimitUsd: 150 } },
    });
    const replies = page.locator('#replies');
    await replies.getByRole('button', { name: /^Stop watching/ }).click();
    await expect(replies.getByText('Stopped', { exact: true })).toBeVisible();
    expect(api.calls).toContain('deleteEmailWatch');
    expect(api.errors).toEqual([]);
  });
});
