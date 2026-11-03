/**
 * WCAG 2.4.11 (Focus Not Obscured) on a phone: tab through every screen at 393 × 659 and check
 * that the focused control is not hidden under the fixed top bar or tab bar (the centre of the
 * focused element must hit the element itself). Uses the contract-validated mock API.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @jarvis/web exec playwright test \
 *     e2e/visual/focus-not-obscured.spec.ts --project=mobile
 */
import { expect, test } from '@playwright/test';
import { mockApi, signInWithMock } from '../support/mock-api';

const SCREENS = ['/', '/tasks', '/memory', '/connections', '/settings', '/admin'];
const MAX_STOPS = 120;

test.use({ viewport: { width: 393, height: 659 } });

for (const locale of ['en', 'ar'] as const) {
  test(`focused controls stay clear of the fixed bars — ${locale}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'The fixed bars exist only below 900 px.');
    await signInWithMock(context, baseURL!, { locale, theme: 'light' });
    await mockApi(page, { locale, theme: 'light' });
    const obscured: string[] = [];
    for (const path of SCREENS) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const seen = new Set<string>();
      for (let i = 0; i < MAX_STOPS; i++) {
        await page.keyboard.press('Tab');
        // Let focus-driven scrolling and the skip link's transition settle.
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const stop = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          // A visually hidden input (segmented control, switch) is drawn by its label.
          const raw = el.getBoundingClientRect();
          const host = raw.height <= 2 ? (el.closest('label') ?? el.parentElement ?? el) : el;
          const r = host.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            id: el.outerHTML.slice(0, 160),
            name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60),
            visible: !!hit && (host.contains(hit) || hit.contains(el)),
          };
        });
        if (!stop || seen.has(stop.id)) break;
        seen.add(stop.id);
        if (!stop.visible) obscured.push(`${path}: "${stop.name}"`);
      }
    }
    expect(obscured).toEqual([]);
  });
}
