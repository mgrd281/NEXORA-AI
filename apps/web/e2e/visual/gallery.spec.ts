/**
 * Component gallery (/dev/components, development builds only): every component in every
 * state, both themes, LTR and RTL. Skipped against production builds (the page is a 404).
 */
import { expect, test } from '@playwright/test';
import { sampleApproval } from '../../src/app/dev/components/samples';
import { mockApi, setAppearanceCookies } from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en', 'ar'] as const) {
    test(`gallery — ${theme}--${locale}`, async ({ page, context, baseURL }, testInfo) => {
      await context.addCookies(setAppearanceCookies(baseURL!, locale, theme));
      // The gallery's sample approval is the one pending, so the sheet shows its ready state.
      await mockApi(page, {
        locale,
        theme,
        overrides: { listApprovals: () => ({ body: { items: [sampleApproval(Date.now())] } }) },
      });
      const response = await page.goto(`/dev/components?locale=${locale}`);
      test.skip(response?.status() === 404, 'The gallery exists only in development builds');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Meridian components' }),
      ).toBeVisible();
      await capture(page, testInfo, `gallery--all--${theme}--${locale}`);
      await expectNoSeriousA11yViolations(page);

      // Overlays: approval sheet and voice mode (voice shows the honest unsupported/permission state).
      await page
        .getByRole('button', { name: locale === 'ar' ? 'راجع هذه الرسالة' : 'Review this email' })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(
        page
          .getByRole('dialog')
          .getByRole('button', { name: /Approve and send|الموافقة والإرسال/ }),
      ).toBeVisible();
      await capture(page, testInfo, `gallery--approval-sheet--${theme}--${locale}`, {
        fullPage: false,
      });
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page
        .getByRole('button', { name: locale === 'ar' ? 'طلب صوتي' : 'Voice request' })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(400);
      await capture(page, testInfo, `gallery--voice--${theme}--${locale}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
    });
  }
}
