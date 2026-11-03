import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright projects: desktop (1440 × 900) and mobile (iPhone 15 descriptor on Chromium — the
 * only browser installed in CI and the dev container).
 *
 *   PLAYWRIGHT_BASE_URL   web app under test (default http://localhost:3000; E2E_BASE_URL also works)
 *   PLAYWRIGHT_WEB_SERVER set to a command (e.g. "pnpm start") to let Playwright start the app
 *
 * Specs under e2e/visual use the contract-validated mock API (e2e/support/mock-api.ts) and only
 * need the web app; the end-to-end specs run against the real API.
 */
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:3000';
const webServerCommand = process.env.PLAYWRIGHT_WEB_SERVER;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 15'], browserName: 'chromium' },
    },
  ],
  webServer: webServerCommand
    ? { command: webServerCommand, url: baseURL, reuseExistingServer: true, timeout: 120_000 }
    : undefined,
});
