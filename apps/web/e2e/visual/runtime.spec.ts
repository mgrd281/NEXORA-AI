/**
 * Runtime health of the shell with the mock API: no Content-Security-Policy violations, no
 * console errors, hydrated and interactive (keyboard shortcuts, live region, RTL switch).
 */
import { expect, test, type Page } from '@playwright/test';
import { mockApi, setAppearanceCookies, signInWithMock } from '../support/mock-api';

function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  return problems;
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = list;
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
});

test('sign-in hydrates under the CSP and switches language', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await context.addCookies(setAppearanceCookies(baseURL!, 'en'));
  await mockApi(page);
  const response = await page.goto('/sign-in');
  expect(response?.headers()['content-security-policy']).toContain("'strict-dynamic'");
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تسجيل الدخول إلى JARVIS');
  expect(await cspViolations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test('shell is interactive: shortcuts, live presence, notifications', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard shortcuts are a desktop affordance');
  const problems = watch(page);
  await signInWithMock(context, baseURL!, { locale: 'en' });
  const api = await mockApi(page, { locale: 'en' });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  // Presence reflects the pending approval from the Home snapshot.
  await expect(
    page.getByRole('status').filter({ hasText: 'Needs your approval' }).first(),
  ).toBeAttached();
  // '?' opens the shortcuts dialog; Esc closes it.
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Ctrl+K goes Home and focuses the composer.
  await page.keyboard.press('Control+k');
  await page.waitForURL(/\/$/);
  await expect(page.getByRole('textbox', { name: 'Ask JARVIS' })).toBeFocused();
  // Typing and Enter creates a task with an Idempotency-Key, then opens it.
  const created = page.waitForRequest(
    (r) => r.url().endsWith('/api/v1/tasks') && r.method() === 'POST',
  );
  await page.keyboard.type('Remember that I prefer aisle seats on flights');
  await page.keyboard.press('Enter');
  const request = await created;
  expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  expect(api.errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  expect(problems).toEqual([]);
});
