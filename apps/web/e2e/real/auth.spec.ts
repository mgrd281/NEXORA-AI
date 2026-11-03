/**
 * Against the real stack (API + web, no mocks): sign in through the same-origin proxy, load the
 * shell from live data, hold the SSE stream open, sign out. Runs only when E2E_EMAIL and
 * E2E_PASSWORD are set (CI creates that owner with `cli create-owner`).
 */
import { expect, test } from '@playwright/test';

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD are not set (real backend only)');

test('signs in, shows the live shell and signs out', async ({ page }, testInfo) => {
  await page.goto('/tasks');
  await page.waitForURL(/\/sign-in\?next=%2Ftasks/);

  await page.locator('input[name="email"]').fill(email!);
  await page.locator('input[name="password"]').fill('definitely-not-the-password');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible();

  await page.locator('input[name="password"]').fill(password!);
  const events = page.waitForResponse((r) => r.url().includes('/api/v1/events'));
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/tasks$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The realtime stream is proxied by the route handler and stays open.
  const stream = await events;
  expect(stream.status()).toBe(200);
  expect(stream.headers()['content-type']).toContain('text/event-stream');

  // Live profile data reached the shell; the status line reflects the real planner mode.
  const me = await page.evaluate(async () => (await fetch('/api/v1/me')).json());
  expect(me.email).toBe(email);
  if (testInfo.project.name === 'desktop') {
    await expect(page.locator('aside').getByText(me.displayName).first()).toBeVisible();
    await expect(page.locator('aside a[href="/settings#assistant"]')).toBeVisible();
    await page.locator('aside button[aria-haspopup="menu"]').click();
  } else {
    await page.locator('header button[aria-haspopup="menu"]').click();
  }
  await page.getByRole('menuitem', { name: /Sign out|Abmelden|تسجيل الخروج/ }).click();
  await page.waitForURL(/\/sign-in$/);
  const after = await page.evaluate(async () => (await fetch('/api/v1/me')).status);
  expect(after).toBe(401);
});
