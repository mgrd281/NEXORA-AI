/**
 * Connections screen with the contract-validated mock API: light + dark × en + de + ar on
 * desktop and mobile, connected and not connected, a mailbox that needs attention, a failed
 * verification, the disconnect dialog, and the real flows (enable / disconnect web access,
 * verify-and-connect SMTP, test, disconnect). Screenshots:
 * test-results/screenshots/connections--<state>--<theme>--<locale>--<viewport>.png
 */
import type { Connection, RouteName } from '@jarvis/contracts';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { IDS, type Fixtures } from '../support/fixtures';
import {
  mockApi,
  signInWithMock,
  type MockApiOptions,
  type MockHandler,
} from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

type Locale = 'en' | 'de' | 'ar';
const THEMES = ['light', 'dark'] as const;
const LOCALES: Locale[] = ['en', 'de', 'ar'];

const SMTP_ERROR: Record<Locale, string> = {
  en: 'The mail server rejected the username or password.',
  de: 'Der Mailserver hat Benutzername oder Passwort abgelehnt.',
  ar: 'رفض خادم البريد اسم المستخدم أو كلمة المرور.',
};

/** Stateful connection routes, mirroring the API (verified before saving, one row per provider). */
const connectionRoutes: Partial<Record<RouteName, MockHandler>> = {
  enableWebAccess: (_req, s) => {
    const nowIso = new Date().toISOString();
    const web: Connection = {
      id: IDS.connectionWeb,
      provider: 'web',
      label: 'Web access',
      accountIdentifier: null,
      status: 'active',
      permissions: ['web.fetch'],
      lastVerifiedAt: nowIso,
      lastError: null,
      expiresAt: null,
      createdAt: nowIso,
    };
    s.connections = [...s.connections.filter((c) => c.provider !== 'web'), web];
    return { status: 201, body: web };
  },
  connectSmtp: (req, s) => {
    const body = req.body as {
      label: string;
      host: string;
      password?: string;
      fromAddress: string;
    };
    if (body.password !== 'app-password-1234') {
      return {
        status: 400,
        body: {
          error: {
            code: 'CONNECTION_FAILED',
            message: 'The mail server rejected the username or password.',
            requestId: 'req_smtp_1',
          },
        },
      };
    }
    const nowIso = new Date().toISOString();
    const smtp: Connection = {
      id: IDS.connectionSmtp,
      provider: 'smtp',
      label: body.label,
      accountIdentifier: body.fromAddress,
      status: 'active',
      permissions: ['email.send'],
      lastVerifiedAt: nowIso,
      lastError: null,
      expiresAt: null,
      createdAt: nowIso,
    };
    s.connections = [...s.connections.filter((c) => c.provider !== 'smtp'), smtp];
    return { status: 201, body: smtp };
  },
  testConnection: (req, s) => {
    const current = s.connections.find((c) => c.id === req.params.id)!;
    const checked = {
      ...current,
      status: 'active' as const,
      lastError: null,
      lastVerifiedAt: new Date().toISOString(),
    };
    s.connections = s.connections.map((c) => (c.id === checked.id ? checked : c));
    return { body: checked };
  },
  deleteConnection: (req, s) => {
    s.connections = s.connections.filter((c) => c.id !== req.params.id);
    return { status: 204 };
  },
};

async function openConnections(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  {
    locale,
    theme,
    fixtures,
    overrides,
  }: {
    locale: Locale;
    theme: 'light' | 'dark';
    fixtures?: (f: Fixtures) => Fixtures;
    overrides?: MockApiOptions['overrides'];
  },
) {
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, {
    locale,
    theme,
    fixtures,
    overrides: { ...connectionRoutes, ...overrides },
  });
  await page.goto('/connections');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
  return api;
}

const none = (f: Fixtures): Fixtures => ({ ...f, connections: [] });

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`connections — connected — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await openConnections(page, context, baseURL!, { locale, theme });
      await expect(
        page.locator('main').getByText('layla.haddad@example.com').first(),
      ).toBeVisible();
      await capture(page, testInfo, `connections--connected--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`connections — not connected — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await openConnections(page, context, baseURL!, { locale, theme, fixtures: none });
      await expect(page.locator('main form')).toBeVisible();
      await capture(page, testInfo, `connections--not-connected--${variant}`);
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

  test(`connections — mailbox needs attention — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openConnections(page, context, baseURL!, {
      locale,
      theme,
      fixtures: (f) => ({
        ...f,
        connections: f.connections.map((c) =>
          c.provider === 'smtp' ? { ...c, status: 'error', lastError: SMTP_ERROR[locale] } : c,
        ),
      }),
    });
    await expect(page.locator('main').getByText(SMTP_ERROR[locale])).toBeVisible();
    await capture(page, testInfo, `connections--smtp-error--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });

  test(`connections — verification failed and disconnect dialog — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openConnections(page, context, baseURL!, { locale, theme, fixtures: none });
    const form = page.locator('main form');
    await form.locator('input').nth(1).fill('smtp.mailbox.example');
    await form.locator('input[type="password"]').fill('wrong password');
    await form.locator('button[type="submit"]').click();
    await expect(form.getByRole('alert')).toContainText('rejected the username or password');
    await capture(page, testInfo, `connections--verify-failed--${variant}`);
    await expectNoSeriousA11yViolations(page);

    // Now connect for real and open the disconnect confirmation.
    await form.locator('input[type="password"]').fill('app-password-1234');
    await form.locator('button[type="submit"]').click();
    await expect(page.locator('main form')).toHaveCount(0);
    // Cards: Google, Microsoft, Email (SMTP), Web access.
    const emailCard = page.locator('main section').nth(2);
    // Test connection, Update settings, then the quiet Disconnect last. Activated from the
    // keyboard: on phones the "connected" toast sits over the bottom of the card for a moment.
    await emailCard.locator('footer button').last().press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, testInfo, `connections--disconnect-dialog--${variant}`, {
      fullPage: false,
    });
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

test('connections — enable web access, connect, test and disconnect email', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Interaction flow runs once, on desktop');
  const api = await openConnections(page, context, baseURL!, {
    locale: 'en',
    theme: 'light',
    fixtures: none,
  });

  // Web access: one button that enables and then disconnects; focus stays on it.
  const webButton = page.getByRole('button', { name: 'Enable web access' });
  await webButton.click();
  const disconnectWeb = page.getByRole('button', { name: 'Disconnect', exact: true }).first();
  await expect(disconnectWeb).toBeFocused();
  await expect(page.locator('main section').nth(3)).toContainText('Connected');
  await disconnectWeb.click();
  await expect(page.getByRole('button', { name: 'Enable web access' })).toBeFocused();
  expect(api.calls.filter((c) => c === 'enableWebAccess' || c === 'deleteConnection')).toEqual([
    'enableWebAccess',
    'deleteConnection',
  ]);

  // SMTP: client validation first, then security defaults, then verify and connect.
  await page.getByRole('textbox', { name: 'From address' }).fill('');
  await page.getByRole('button', { name: 'Verify and connect' }).click();
  await expect(page.getByText('Enter the SMTP server’s host name.')).toBeVisible();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SMTP server' })).toBeFocused();
  expect(api.calls).not.toContain('connectSmtp');

  const port = page.getByRole('textbox', { name: 'Port' });
  await expect(port).toHaveValue('465');
  await page.getByRole('combobox', { name: 'Security' }).selectOption('starttls');
  await expect(port).toHaveValue('587');

  await page.getByRole('textbox', { name: 'SMTP server' }).fill('smtp.mailbox.example');
  await page.getByRole('textbox', { name: 'Username' }).fill('layla.haddad@example.com');
  await page.getByLabel('Password', { exact: true }).fill('app-password-1234');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('textbox', { name: 'From address' }).fill('layla.haddad@example.com');
  const connect = page.waitForRequest((r) => r.url().endsWith('/api/v1/connections/smtp'));
  await page.getByRole('button', { name: 'Verify and connect' }).click();
  expect((await connect).postDataJSON()).toEqual({
    label: 'Email',
    host: 'smtp.mailbox.example',
    port: 587,
    security: 'starttls',
    username: 'layla.haddad@example.com',
    password: 'app-password-1234',
    fromAddress: 'layla.haddad@example.com',
    fromName: 'Layla Haddad',
  });
  // The interpolated address is direction-isolated (FSI…PDI).
  await expect(
    page.getByText(/^Email connected as \u2068?layla\.haddad@example\.com\u2069?\.$/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Email', level: 2 })).toBeFocused();
  await expect(page.getByText('Last verified', { exact: false })).toBeVisible();

  // Test connection re-verifies on the server.
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('The mail server accepted the connection.')).toBeVisible();

  // Disconnect: the dialog explains the password is erased; confirming removes the mailbox.
  await page.locator('main section').nth(2).getByRole('button', { name: 'Disconnect' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('The stored password is erased from the server right away.');
  await dialog.getByRole('button', { name: 'Disconnect and erase password' }).click();
  await expect(page.getByText('Email disconnected. The stored password was erased.')).toBeVisible();
  await expect(page.locator('main form')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Email', level: 2 })).toBeFocused();
  expect(api.calls).toContain('testConnection');
  expect(api.errors).toEqual([]);
});

test('connections — hydrates under the CSP without console errors', async ({
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
  await openConnections(page, context, baseURL!, { locale: 'en', theme: 'light' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp).toEqual([]);
  expect(problems).toEqual([]);
});

test('connections — the sender defaults to the account even when the profile loads late', async ({
  page,
  context,
  baseURL,
}) => {
  const api = await openConnections(page, context, baseURL!, {
    locale: 'en',
    theme: 'light',
    fixtures: none,
    overrides: { getMe: (_req, s) => ({ body: s.me, delayMs: 1500 }) },
  });
  await expect(page.getByRole('textbox', { name: 'From address' })).toHaveValue(
    'layla.haddad@example.com',
  );
  await expect(page.getByRole('textbox', { name: 'From name' })).toHaveValue('Layla Haddad');
  // Once edited, the person's value wins.
  await page.getByRole('textbox', { name: 'From name' }).fill('Layla H.');
  await expect(page.getByRole('textbox', { name: 'From name' })).toHaveValue('Layla H.');
  expect(api.errors).toEqual([]);
});
