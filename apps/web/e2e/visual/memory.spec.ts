/**
 * Memory screen with the contract-validated mock API: light + dark × en + de + ar on desktop
 * and mobile, the main states (list, empty, no results, memory off, editing, delete dialogs,
 * load more, error) and the real interactions (add, search → ?q=, edit, delete, delete all,
 * memory on/off). Screenshots: test-results/screenshots/memory--<state>--<theme>--<locale>--<viewport>.png
 */
import type { Memory, RouteName } from '@jarvis/contracts';
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

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CONTENT: Record<Locale, string[]> = {
  en: [
    'Prefers aisle seats on flights.',
    'My manager is Sam Okafor; our weekly sync is on Tuesdays at 10:00.',
    'Keep emails to me short, without greetings or sign-offs.',
    'I work at Haddad Studio in Berlin, mostly on accessibility audits for public-sector websites.',
    'Summaries should have at most five bullet points.',
    'My research folder for the EU AI Act is https://drive.example.com/ai-act',
  ],
  de: [
    'Bevorzugt Gangplätze auf Flügen.',
    'Meine Vorgesetzte ist Sam Okafor; unser wöchentlicher Abgleich ist dienstags um 10:00 Uhr.',
    'E-Mails an mich bitte kurz und ohne Begrüßungs- und Grußformeln.',
    'Ich arbeite bei Haddad Studio in Berlin, meist an Barrierefreiheitsprüfungen für Behördenwebseiten.',
    'Zusammenfassungen höchstens fünf Stichpunkte.',
    'Mein Rechercheordner zum KI-Gesetz der EU: https://drive.example.com/ai-act',
  ],
  ar: [
    'تفضّل المقاعد بجانب الممر في الرحلات الجوية.',
    'مديري سام أوكافور، واجتماعنا الأسبوعي كل ثلاثاء الساعة 10:00.',
    'اكتب لي الرسائل باختصار ودون عبارات تحية أو ختام.',
    'أعمل في استوديو حداد في برلين، وغالبًا في تدقيق إمكانية الوصول لمواقع الجهات الحكومية.',
    'يجب ألا تتجاوز الملخصات خمس نقاط.',
    'مجلد أبحاثي عن قانون الذكاء الاصطناعي الأوروبي: https://drive.example.com/ai-act',
  ],
};

function uuid(n: number): string {
  return `9a${String(n).padStart(6, '0')}-1b2c-4d3e-8f40-${String(n).padStart(12, '0')}`;
}

/** Six realistic memories (the fixture's aisle-seat one first), newest first. */
function memoriesFor(locale: Locale, base: Fixtures): Memory[] {
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const [seat, manager, emails, work, summaries, folder] = CONTENT[locale];
  return [
    ...base.memories.map((m) => ({ ...m, content: seat! })),
    {
      id: uuid(1),
      kind: 'fact',
      content: manager!,
      source: 'user',
      sourceTaskId: null,
      createdAt: at(DAY + 3 * HOUR),
      updatedAt: at(DAY + 3 * HOUR),
    },
    {
      id: uuid(2),
      kind: 'preference',
      content: emails!,
      source: 'user',
      sourceTaskId: null,
      createdAt: at(3 * DAY),
      updatedAt: at(2 * HOUR),
    },
    {
      id: uuid(3),
      kind: 'fact',
      content: work!,
      source: 'user',
      sourceTaskId: null,
      createdAt: at(6 * DAY),
      updatedAt: at(6 * DAY),
    },
    {
      id: uuid(4),
      kind: 'preference',
      content: summaries!,
      source: 'assistant',
      sourceTaskId: IDS.taskEmail,
      createdAt: at(9 * DAY),
      updatedAt: at(9 * DAY),
    },
    {
      id: uuid(5),
      kind: 'fact',
      content: folder!,
      source: 'user',
      sourceTaskId: null,
      createdAt: at(14 * DAY),
      updatedAt: at(14 * DAY),
    },
  ];
}

/** Stateful memory routes: search (q), cursor paging, create, update, delete, delete all. */
const memoryRoutes: Partial<Record<RouteName, MockHandler>> = {
  listMemories: (req, s) => {
    const q = (req.query.get('q') ?? '').trim().toLowerCase();
    const limit = Number(req.query.get('limit') ?? 25);
    const start = Number(req.query.get('cursor') ?? 0);
    const all = q ? s.memories.filter((m) => m.content.toLowerCase().includes(q)) : s.memories;
    const items = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : null;
    return { body: { items, nextCursor: next } };
  },
  createMemory: (req, s) => {
    const body = req.body as { kind: Memory['kind']; content: string };
    const nowIso = new Date().toISOString();
    const memory: Memory = {
      id: crypto.randomUUID(),
      kind: body.kind,
      content: body.content,
      source: 'user',
      sourceTaskId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    s.memories = [memory, ...s.memories];
    return { status: 201, body: memory };
  },
  updateMemory: (req, s) => {
    const current = s.memories.find((m) => m.id === req.params.id);
    if (!current)
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Memory not found' } } };
    const next = { ...current, ...(req.body as object), updatedAt: new Date().toISOString() };
    s.memories = s.memories.map((m) => (m.id === next.id ? next : m));
    return { body: next };
  },
  deleteMemory: (req, s) => {
    s.memories = s.memories.filter((m) => m.id !== req.params.id);
    return { status: 204 };
  },
  deleteAllMemories: (_req, s) => {
    const deleted = s.memories.length;
    s.memories = [];
    return { body: { deleted } };
  },
};

async function openMemory(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  {
    locale,
    theme,
    fixtures,
    overrides,
    path = '/memory',
  }: {
    locale: Locale;
    theme: 'light' | 'dark';
    fixtures?: (f: Fixtures) => Fixtures;
    overrides?: MockApiOptions['overrides'];
    path?: string;
  },
) {
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, {
    locale,
    theme,
    fixtures: (f) => {
      const withMemories = { ...f, memories: memoriesFor(locale, f) };
      return fixtures ? fixtures(withMemories) : withMemories;
    },
    overrides: { ...memoryRoutes, ...overrides },
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return api;
}

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`memory — list — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await openMemory(page, context, baseURL!, { locale, theme });
      await expect(page.locator('main li').filter({ hasText: CONTENT[locale][1]! })).toBeVisible();
      await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      await capture(page, testInfo, `memory--list--${variant}`);
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

  test(`memory — empty, off and error states — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openMemory(page, context, baseURL!, {
      locale,
      theme,
      fixtures: (f) => ({
        ...f,
        memories: [],
        me: { ...f.me, preferences: { ...f.me.preferences, memory: { enabled: false } } },
      }),
    });
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(
      page.locator('main').getByRole('status').filter({ hasText: /\S/ }).first(),
    ).toBeAttached();
    await capture(page, testInfo, `memory--empty-off--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });

  test(`memory — search without results — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openMemory(page, context, baseURL!, {
      locale,
      theme,
      path: '/memory?q=passport',
    });
    await expect(page.getByRole('searchbox')).toHaveValue('passport');
    await expect(
      page
        .locator('main')
        .getByText(/passport/)
        .last(),
    ).toBeVisible();
    await capture(page, testInfo, `memory--no-results--${variant}`);
    await expectNoSeriousA11yViolations(page);
    expect(api.calls).toContain('listMemories');
    expect(api.errors).toEqual([]);
  });

  test(`memory — editing and dialogs — ${variant}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openMemory(page, context, baseURL!, { locale, theme });
    const row = page.locator('main li').filter({ hasText: CONTENT[locale][2]! });
    await row.getByRole('button').first().click();
    await expect(page.locator('main textarea').nth(1)).toBeFocused();
    await capture(page, testInfo, `memory--editing--${variant}`);
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');

    await row.getByRole('button').nth(1).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await capture(page, testInfo, `memory--delete-one--${variant}`, { fullPage: false });
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');

    await page.locator('main section').last().getByRole('button').click();
    await expect(page.getByRole('dialog').getByRole('button').last()).toContainText(/6/);
    await capture(page, testInfo, `memory--delete-all--${variant}`, { fullPage: false });
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });
}

test('memory — list failed to load, then retry', async ({ page, context, baseURL }, testInfo) => {
  let fail = true;
  const api = await openMemory(page, context, baseURL!, {
    locale: 'en',
    theme: 'light',
    overrides: {
      listMemories: (req, s) =>
        fail
          ? {
              status: 500,
              body: {
                error: { code: 'INTERNAL', message: 'Database unavailable', requestId: 'req_7f3a' },
              },
            }
          : memoryRoutes.listMemories!(req, s),
    },
  });
  const alert = page.getByRole('alert').filter({ hasText: /went wrong/i });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await capture(page, testInfo, 'memory--error--light--en');
  fail = false;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('main li').first()).toBeVisible();
  expect(api.errors).toEqual([]);
});

test('memory — add, search, edit, delete, delete all and turn off', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Interaction flow runs once, on desktop');
  const api = await openMemory(page, context, baseURL!, { locale: 'en', theme: 'light' });

  // Add a preference.
  const newMemory = page.getByRole('textbox', { name: 'New memory' });
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByText('Write the memory first.')).toBeVisible();
  await newMemory.fill('Book trains with a quiet-zone seat when possible.');
  await page.getByRole('radio', { name: 'Preference' }).first().check({ force: true });
  const created = page.waitForRequest(
    (r) => r.url().endsWith('/api/v1/memories') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save memory' }).click();
  expect((await created).postDataJSON()).toEqual({
    kind: 'preference',
    content: 'Book trains with a quiet-zone seat when possible.',
  });
  await expect(page.locator('main li').first()).toContainText('quiet-zone seat');
  await expect(newMemory).toHaveValue('');
  await expect(newMemory).toBeFocused();

  // Search is debounced and mirrored into ?q=.
  await page.getByRole('searchbox', { name: 'Search memories' }).fill('manager');
  await page.waitForURL(/\/memory\?q=manager$/);
  await expect(page.locator('main ul li')).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: '1 memory matches.' })).toBeAttached();
  await page.getByRole('searchbox', { name: 'Search memories' }).fill('');
  await page.waitForURL(/\/memory$/);

  // Edit (correct) a memory; focus returns to its Edit button.
  const editButton = page.getByRole('button', { name: /^Edit memory: My manager is Sam/ });
  await editButton.click();
  const field = page.getByRole('textbox', { name: 'Memory', exact: true });
  await field.fill('My manager is Sam Okafor; our weekly sync moved to Wednesdays at 10:00.');
  const updated = page.waitForRequest((r) => r.method() === 'PATCH');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await updated).postDataJSON()).toEqual({
    content: 'My manager is Sam Okafor; our weekly sync moved to Wednesdays at 10:00.',
  });
  await expect(page.locator('main li').filter({ hasText: 'Wednesdays' })).toContainText('Edited');
  await expect(page.getByRole('button', { name: /^Edit memory: My manager is Sam/ })).toBeFocused();

  // Delete one, with confirmation.
  await page.getByRole('button', { name: /^Delete memory: Summaries should/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete memory' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main').getByText('Summaries should have at most')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your memories' })).toBeFocused();
  expect(api.calls).toContain('deleteMemory');

  // Delete all: the dialog states the exact count before anything is deleted.
  await page.getByRole('button', { name: 'Delete all memories…' }).click();
  const confirmAll = page.getByRole('dialog').getByRole('button', { name: 'Delete 6 memories' });
  await expect(confirmAll).toBeEnabled();
  await expect(page.getByRole('dialog')).toContainText(
    'This permanently deletes all 6 of your memories.',
  );
  await confirmAll.click();
  await expect(page.getByText('Deleted 6 memories.')).toBeVisible();
  await expect(
    page.getByText('JARVIS doesn’t remember anything yet.', { exact: false }),
  ).toBeVisible();

  // Memory off saves the preference and shows the banner.
  const saved = page.waitForRequest(
    (r) => r.url().endsWith('/api/v1/me') && r.method() === 'PATCH',
  );
  await page.getByRole('switch', { name: 'Use memory' }).click();
  expect((await saved).postDataJSON()).toEqual({ preferences: { memory: { enabled: false } } });
  await expect(page.getByRole('switch', { name: 'Use memory' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(page.getByText('Memory is turned off.', { exact: false })).toBeVisible();
  expect(api.errors).toEqual([]);
});

test('memory — show more loads the next page', async ({ page, context, baseURL }, testInfo) => {
  const api = await openMemory(page, context, baseURL!, {
    locale: 'en',
    theme: 'light',
    fixtures: (f) => ({
      ...f,
      memories: Array.from({ length: 32 }, (_, i): Memory => ({
        id: uuid(100 + i),
        kind: i % 3 === 0 ? 'preference' : 'fact',
        content: `Project note ${i + 1}: keep the accessibility audit checklist up to date.`,
        source: 'user',
        sourceTaskId: null,
        createdAt: new Date(Date.now() - (i + 1) * HOUR).toISOString(),
        updatedAt: new Date(Date.now() - (i + 1) * HOUR).toISOString(),
      })),
    }),
  });
  await expect(page.locator('main ul li')).toHaveCount(25);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('main ul li')).toHaveCount(32);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await capture(page, testInfo, 'memory--paged--light--en', { fullPage: false });
  expect(api.errors).toEqual([]);
});

test('memory — hydrates under the CSP without console errors', async ({
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
  await openMemory(page, context, baseURL!, { locale: 'en', theme: 'light' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp).toEqual([]);
  expect(problems).toEqual([]);
});
