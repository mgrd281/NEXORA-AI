/**
 * Visual capture of sign-in and the app shell with the contract-validated mock API:
 * light + dark × en + ar + de on desktop (1440 × 900) and mobile (iPhone 15). Screenshots go to
 * test-results/screenshots/<screen>--<state>--<theme>--<locale>--<viewport>.png; axe runs on
 * every page (serious/critical violations fail).
 *
 *   pnpm --filter @jarvis/web dev                      # or a production build + start
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @jarvis/web e2e:visual
 */
import { expect, test } from '@playwright/test';
import { mockApi, MOCK_PASSWORD, setAppearanceCookies, signInWithMock } from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

const THEMES = ['light', 'dark'] as const;
// German is included for its long compounds at 390 px.
const LOCALES = ['en', 'ar', 'de'] as const;

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`sign-in — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      await context.addCookies(setAppearanceCookies(baseURL!, locale, theme));
      const api = await mockApi(page, { locale, theme });
      await page.goto('/sign-in');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await capture(page, testInfo, `sign-in--default--${variant}`);
      await expectNoSeriousA11yViolations(page);

      // Wrong password → the generic, non-revealing error.
      await page.locator('input[name="email"]').fill('layla.haddad@example.com');
      await page.locator('input[name="password"]').fill('not the password');
      await page.locator('button[type="submit"]').click();
      await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible();
      await capture(page, testInfo, `sign-in--error--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`shell — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      await signInWithMock(context, baseURL!, { locale, theme });
      const api = await mockApi(page, { locale, theme });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('textarea')).toBeVisible();
      // The shell has loaded real (mock) data: the account and the pending-approval badge.
      const mobile = testInfo.project.name === 'mobile';
      if (!mobile) await expect(page.getByText('Layla Haddad').first()).toBeVisible();
      await capture(page, testInfo, `home--placeholder--${variant}`);
      await expectNoSeriousA11yViolations(page);

      // Notifications (popover on desktop, sheet on mobile).
      if (mobile) {
        await page.locator('header button[aria-haspopup="dialog"]').click();
      } else {
        await page.locator('aside button[aria-haspopup="dialog"]').click();
      }
      await expect(
        page.getByRole('link', { name: /EU AI|الذكاء الاصطناعي/ }).first(),
      ).toBeVisible();
      await capture(page, testInfo, `notifications--open--${variant}`);
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');

      await page.goto('/tasks');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await capture(page, testInfo, `tasks--placeholder--${variant}`);
      expect(api.errors).toEqual([]);
    });
  }
}

test('signs in with the mock API and lands on the requested page', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/sign-in?next=%2Ftasks');
  await page.getByLabel('Email').fill('layla.haddad@example.com');
  await page.locator('input[name="password"]').fill(MOCK_PASSWORD);
  // The mock API does not set the httpOnly session cookie; emulate the API's Set-Cookie.
  await page
    .context()
    .addCookies([
      { name: 'jarvis_session', value: 'mock-session', url: page.url(), httpOnly: true },
    ]);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/tasks');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(api.calls).toContain('login');
  expect(api.errors).toEqual([]);
});

test('redirects to sign-in without a session cookie', async ({ page }) => {
  await page.goto('/memory');
  await page.waitForURL(/\/sign-in\?next=%2Fmemory$/);
});
