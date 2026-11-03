import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SCREENSHOT_DIR = path.join(process.cwd(), 'test-results', 'screenshots');

/** Waits for fonts and for animations to settle, then saves a full-page PNG. */
export async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  { fullPage = true }: { fullPage?: boolean } = {},
): Promise<string> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}--${testInfo.project.name}.png`);
  // Modal overlays are fixed to the viewport, so capture those without fullPage.
  await page.screenshot({ path: file, fullPage, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

/** Runs axe (WCAG 2.2 A/AA) and fails on serious or critical violations. */
export async function expectNoSeriousA11yViolations(
  page: Page,
  exclude: string[] = [],
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);
  for (const selector of exclude) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const report = serious.map(
    (v) =>
      `${v.impact}: ${v.id} — ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
  );
  expect(report, report.join('\n')).toEqual([]);
}
