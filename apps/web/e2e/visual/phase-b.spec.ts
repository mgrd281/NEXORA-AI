/**
 * Phase B screens with the contract-validated mock API: conversation threads on the task page
 * (follow-ups, a clarifying question, documents), conversation history, attachments in the
 * composers, Scheduled (list, runs, editor), Settings › Skills and retention, Memory retention,
 * Connections › Developer (webhooks) and the schedule / memory approval sheets — light + dark ×
 * en + de + ar on desktop and mobile, axe on every state — plus the real flows on desktop.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3401 npx playwright test e2e/visual/phase-b.spec.ts
 */
import type { Approval, Notification, TaskDetail } from '@jarvis/contracts';
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { IDS, msg, text, type FixtureLocale, type Fixtures } from '../support/fixtures';
import {
  DEFAULT_HANDLERS,
  mockApi,
  signInWithMock,
  type MockApiOptions,
  type MockHandler,
} from '../support/mock-api';
import { PB, PHASE_B_COPY, summaryOf, withConversations } from '../support/phase-b';
import { capture, expectNoSeriousA11yViolations, SCREENSHOT_DIR } from '../support/visual';

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'de', 'ar'] as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

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
  }: {
    locale?: FixtureLocale;
    theme?: 'light' | 'dark';
    path: string;
    options?: MockApiOptions;
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
      const rich = withApprovalKinds(withConversations(f, locale, now), locale, now);
      return options.fixtures ? options.fixtures(rich) : rich;
    },
  });
  await page.goto(target);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  return api;
}

/** A screenshot of one region (a settings section, a card). */
async function shot(locator: Locator, testInfo: TestInfo, name: string) {
  await locator.page().evaluate(() => document.fonts.ready);
  await locator.page().waitForTimeout(200);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}--${testInfo.project.name}.png`);
  await locator.screenshot({ path: file, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

/** Requests the page sent, by route, with their parsed bodies. */
function recorder(page: Page) {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/v1/')) return;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    seen.push({ method: req.method(), path: url.pathname.replace(/^\/api/, ''), body });
  });
  return seen;
}

/* ------------------------------------------------------------------ approval kinds */

const T_SCHEDULE = 'ee000001-0000-4000-8000-0000000000e1';
const T_SCHEDULE_STEP = 'ee000001-0000-4000-8000-000000000e11';
const T_SCHEDULE_APPROVAL = 'ee000001-0000-4000-8000-000000000e12';
const T_MEMORY = 'ee000001-0000-4000-8000-0000000000e2';
const T_MEMORY_RECALL = 'ee000001-0000-4000-8000-000000000e21';
const T_MEMORY_STEP = 'ee000001-0000-4000-8000-000000000e22';
const T_MEMORY_APPROVAL = 'ee000001-0000-4000-8000-000000000e23';

/**
 * Two tasks waiting on the new approval kinds: "every Monday at 9 summarize … and email it to
 * me" (schedule.create, MEDIUM) and "remember that" after the document summary (memory.save of
 * an earlier result, MEMORY_FROM_CONTENT).
 */
function withApprovalKinds(f: Fixtures, locale: FixtureLocale, now: number): Fixtures {
  const c = PHASE_B_COPY[locale];
  const at = (o: number) => new Date(now + o).toISOString();
  const weekly = f.schedules.find((s) => s.id === PB.scheduleWeekly)!;
  const sTitle = { key: 'plan.schedule', params: { title: c.scheduleWeeklyTitle } } as const;
  const schedApproval: Approval = {
    id: T_SCHEDULE_APPROVAL,
    taskId: T_SCHEDULE,
    taskTitle: text(locale, msg(sTitle.key, sTitle.params)),
    taskTitleMessage: msg(sTitle.key, sTitle.params),
    stepId: T_SCHEDULE_STEP,
    toolId: 'schedule.create',
    status: 'PENDING',
    riskLevel: 'MEDIUM',
    summary: text(locale, msg('approval.schedule', { title: c.scheduleWeeklyTitle })),
    summaryMessage: msg('approval.schedule', { title: c.scheduleWeeklyTitle }),
    details: {
      kind: 'schedule',
      title: c.scheduleWeeklyTitle,
      request: c.scheduleWeeklyRequest,
      recurrence: weekly.recurrence,
      rrule: weekly.rrule,
      nextOccurrences: [0, 7, 14].map((d) =>
        new Date(new Date(weekly.nextRunAt!).getTime() + d * 24 * HOUR).toISOString(),
      ),
    },
    actionHash: 'sha256:e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
    reasons: ['RISK_MEDIUM', 'FUTURE_RUNS'],
    expiresAt: at(23 * HOUR),
    decidedAt: null,
    decisionNote: null,
    createdAt: at(-4 * MIN),
  };
  const memoryText = PHASE_B_COPY[locale].c1Summary.split('. ')[0]!.replace(/\.$/, '') + '.';
  const memApproval: Approval = {
    id: T_MEMORY_APPROVAL,
    taskId: T_MEMORY,
    taskTitle: text(locale, msg('plan.rememberResult', { title: 'Q3' })),
    taskTitleMessage: msg('plan.rememberResult', { title: 'Q3' }),
    stepId: T_MEMORY_STEP,
    toolId: 'memory.save',
    status: 'PENDING',
    riskLevel: 'LOW',
    summary: text(locale, msg('approval.memory', { text: memoryText })),
    summaryMessage: msg('approval.memory', { text: memoryText }),
    details: { kind: 'memory', content: memoryText, memoryKind: 'fact', sourceTaskId: PB.c1 },
    actionHash: 'sha256:e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2',
    reasons: ['MEMORY_FROM_CONTENT'],
    expiresAt: at(23 * HOUR),
    decidedAt: null,
    decisionNote: null,
    createdAt: at(-3 * MIN),
  };
  const base = (
    id: string,
    conversationId: string,
    title: typeof schedApproval.taskTitleMessage,
    request: string,
    approval: Approval,
    steps: TaskDetail['steps'],
  ): TaskDetail => ({
    id,
    conversationId,
    title: text(locale, title!),
    titleMessage: title,
    request,
    status: 'AWAITING_APPROVAL',
    riskLevel: approval.riskLevel,
    source: 'text',
    progress: {
      completed: steps.filter((s) => s.status === 'SUCCEEDED').length,
      total: steps.length,
    },
    pendingApprovalId: approval.id,
    pendingApproval: { id: approval.id, untrustedSource: false },
    resultSummary: null,
    resultSummaryMessage: null,
    error: null,
    createdAt: at(-5 * MIN),
    updatedAt: at(-3 * MIN),
    completedAt: null,
    outcome: null,
    question: null,
    scheduleId: null,
    attachmentCount: 0,
    objective: null,
    objectiveMessage: null,
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    steps,
    approvals: [approval],
    events: [],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [],
    canCancel: true,
    canRetry: false,
    startedAt: at(-5 * MIN),
    attachments: [],
  });
  const step = (
    id: string,
    position: number,
    toolId: TaskDetail['steps'][number]['toolId'],
    title: ReturnType<typeof msg>,
    status: TaskDetail['steps'][number]['status'],
    extra: Partial<TaskDetail['steps'][number]> = {},
  ): TaskDetail['steps'][number] => ({
    id,
    position,
    title: text(locale, title),
    titleMessage: title,
    toolId,
    riskLevel: 'LOW',
    status,
    requiresApproval: false,
    policy: { decision: 'allow', reasons: ['RISK_LOW'] },
    inputPreview: {},
    output: null,
    evidence: [],
    attempts: status === 'SUCCEEDED' ? 1 : 0,
    startedAt: status === 'SUCCEEDED' ? at(-5 * MIN) : null,
    completedAt: status === 'SUCCEEDED' ? at(-5 * MIN + 1000) : null,
    error: null,
    ...extra,
  });
  const schedTask = base(
    T_SCHEDULE,
    'ee000001-0000-4000-8000-00000000c0e1',
    sTitle as never,
    c.scheduleWeeklyRequest,
    schedApproval,
    [
      step(T_SCHEDULE_STEP, 0, 'schedule.create', msg('step.schedule'), 'AWAITING_APPROVAL', {
        riskLevel: 'MEDIUM',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM', 'FUTURE_RUNS'] },
        inputPreview: { title: c.scheduleWeeklyTitle, request: c.scheduleWeeklyRequest },
      }),
    ],
  );
  const memTask = base(
    T_MEMORY,
    PB.convC,
    memApproval.taskTitleMessage!,
    locale === 'de' ? 'Merk dir das' : locale === 'ar' ? 'تذكّر ذلك' : 'Remember that',
    memApproval,
    [
      step(T_MEMORY_RECALL, 0, 'conversation.recall', msg('step.recall'), 'SUCCEEDED', {
        inputPreview: { taskId: PB.c1 },
      }),
      step(T_MEMORY_STEP, 1, 'memory.save', msg('step.remember'), 'AWAITING_APPROVAL', {
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['MEMORY_FROM_CONTENT'] },
        inputPreview: { content: memoryText, kind: 'fact' },
      }),
    ],
  );
  return {
    ...f,
    tasks: [...f.tasks, summaryOf(schedTask), summaryOf(memTask)],
    taskDetails: { ...f.taskDetails, [T_SCHEDULE]: schedTask, [T_MEMORY]: memTask },
    approvals: [...f.approvals, schedApproval, memApproval],
  };
}

/* ------------------------------------------------------------------ visual matrix */

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`conversation thread on the task page — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      // The question task in the middle of conversation A: the summary above, the answered
      // question, then the request still waiting for approval (follow-ups wait for it).
      const api = await open(page, context, baseURL!, { locale, theme, path: `/tasks/${PB.a2}` });
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 2 }).first()).toBeVisible();
      await expect(main.locator(`a[href="/tasks/${PB.a3}"]`).first()).toBeVisible();
      await capture(page, testInfo, `phaseb-thread--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`clarifying question waiting for an answer — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: `/tasks/${PB.b1}` });
      const answer = page.locator('main textarea');
      await expect(answer).toBeFocused();
      await capture(page, testInfo, `phaseb-question--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`document conversation with files and a follow-up — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: `/tasks/${PB.c2}` });
      await expect(page.locator(`main a[href$="${PB.attachmentPdf}/content"]`)).toBeVisible();
      await capture(page, testInfo, `phaseb-document-followup--${variant}`);
      await expectNoSeriousA11yViolations(page);
      await page.goto(`/tasks/${PB.c1}`);
      await expect(page.locator(`main a[href$="${PB.attachmentCsv}/content"]`)).toBeVisible();
      await capture(page, testInfo, `phaseb-document--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`conversation history — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: '/tasks/conversations',
      });
      await expect(page.locator('main ul[aria-label] > li').first()).toBeVisible();
      await capture(page, testInfo, `phaseb-conversations--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`scheduled: list, runs and the editor — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: '/tasks/scheduled' });
      const cards = page.locator('main ul[aria-label] > li');
      await expect(cards).toHaveCount(3);
      await capture(page, testInfo, `phaseb-scheduled--${variant}`);
      await expectNoSeriousA11yViolations(page);
      // Run history of the weekly schedule.
      await cards.first().locator('footer button[aria-expanded]').click();
      await expect(cards.first().locator('ol').first()).toBeVisible();
      await shot(cards.first(), testInfo, `phaseb-schedule-runs--${variant}`);
      await expectNoSeriousA11yViolations(page);
      // The editor, weekly with two days, preview from the server.
      await page.locator('main header').getByRole('button').first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('label:has(input[value="weekly"])').click();
      await dialog.locator('button[aria-pressed="false"]').first().click();
      await expect(dialog.locator('ol time').first()).toBeVisible();
      await capture(page, testInfo, `phaseb-schedule-editor--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await dialog.locator('label:has(input[value="monthly"])').click();
      await expect(dialog.locator('button[aria-pressed="true"]')).toHaveCount(1);
      await shot(dialog.locator('form'), testInfo, `phaseb-schedule-editor-monthly--${variant}`);
      await page.keyboard.press('Escape');
      expect(api.errors).toEqual([]);
    });

    test(`settings: skills and retention — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: '/settings' });
      const skills = page.locator('#skills');
      await expect(skills.getByRole('switch').first()).toBeVisible();
      await shot(skills, testInfo, `phaseb-skills--${variant}`);
      await shot(page.locator('#privacy'), testInfo, `phaseb-privacy--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`memory retention — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: '/memory',
        options: {
          fixtures: (f) => ({
            ...f,
            me: {
              ...f.me,
              preferences: {
                ...f.me.preferences,
                retention: { memoryDays: 90, taskHistoryDays: 365 },
              },
            },
          }),
        },
      });
      await expect(page.locator('main select').first()).toHaveValue('90');
      await capture(page, testInfo, `phaseb-memory-retention--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`connections: developer webhooks — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: '/connections' });
      const developer = page.locator('#developer');
      await expect(developer.locator('article').first()).toBeVisible();
      await developer.locator('article').first().getByRole('button', { expanded: false }).click();
      await expect(developer.locator('article ol li').first()).toBeVisible();
      await shot(developer, testInfo, `phaseb-webhooks--${variant}`);
      await expectNoSeriousA11yViolations(page);
      await developer.locator('header').getByRole('button').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('checkbox').first()).toBeVisible();
      await capture(page, testInfo, `phaseb-webhook-add--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await dialog.locator('input[type="url"]').fill('https://hooks.example.com/jarvis');
      await dialog.locator('footer').getByRole('button').last().click();
      await expect(page.getByRole('dialog').locator('code')).toContainText('whsec_');
      await capture(page, testInfo, `phaseb-webhook-secret--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`composer with files — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: '/' });
      const composer = page.locator('main form').first();
      await composer
        .locator('textarea')
        .fill(
          locale === 'de'
            ? 'Fasse die Dokumente zusammen'
            : locale === 'ar'
              ? 'لخّص المستندات'
              : 'Summarize the documents',
        );
      await composer.locator('input[type="file"]').setInputFiles([
        {
          name: 'Q3-board-report.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7 report'),
        },
        { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') },
        { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('png') },
      ]);
      await expect(composer.locator('li[data-status="ready"]')).toHaveCount(2);
      await expect(composer.locator('li[data-status="error"]')).toHaveCount(1);
      await shot(page.locator('main form').first(), testInfo, `phaseb-composer-files--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`approval sheets for a schedule and a memory — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${T_SCHEDULE}`,
      });
      await page.locator('main section').first().getByRole('button').last().click();
      let sheet = page.getByRole('dialog');
      await expect(sheet.locator('ul time').first()).toBeVisible();
      await capture(page, testInfo, `phaseb-approval-schedule--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
      await page.goto(`/tasks/${T_MEMORY}`);
      await page.locator('main section').first().getByRole('button').last().click();
      sheet = page.getByRole('dialog');
      await expect(sheet.locator(`a[href="/tasks/${PB.c1}"]`)).toBeVisible();
      await capture(page, testInfo, `phaseb-approval-memory--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
}

/* ------------------------------------------------------------------ behaviour */

test.describe('phase B behaviour', () => {
  test.skip(({ isMobile }) => isMobile, 'Behaviour is covered once on desktop');

  test('a follow-up with a file goes to the conversation and appears in the thread', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: `/tasks/${PB.c2}` });
    const sent = recorder(page);
    const form = page.locator('main form').last();
    await form.locator('textarea').fill('Translate it into German');
    await form
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'glossary.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('AI Act'),
      });
    await expect(form.locator('li[data-status="ready"]')).toHaveCount(1);
    await form.locator('textarea').press('Enter');
    await expect(page.getByText('Follow-up sent.')).toBeVisible();
    const followUp = sent.find((r) => r.path === `/v1/conversations/${PB.convC}/messages`);
    expect(followUp?.body).toMatchObject({
      request: 'Translate it into German',
      source: 'text',
      attachmentIds: [expect.any(String)],
    });
    // The new request shows up under "Since then", live from the refreshed thread.
    await expect(page.locator('main ol li', { hasText: 'Translate it into German' })).toBeVisible();
    expect(api.errors).toEqual([]);
  });

  test('answering a question that asks for a file: attach, then send', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: `/tasks/${PB.b1}` });
    const sent = recorder(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach the file' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'contract.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('PK'),
    });
    await expect(page.locator('main li[data-status="ready"]')).toHaveCount(1);
    await page.locator('main textarea').fill('This one');
    await page.locator('main textarea').press('Enter');
    await expect
      .poll(() => sent.find((r) => r.path === `/v1/conversations/${PB.convB}/messages`)?.body)
      .toMatchObject({ request: 'This one', attachmentIds: [expect.any(String)] });
    expect(api.errors).toEqual([]);
  });

  test('files JARVIS can’t use are refused before uploading; removing deletes the upload', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/' });
    const sent = recorder(page);
    const form = page.locator('main form').first();
    const input = form.locator('input[type="file"]');
    await input.setInputFiles([
      {
        name: 'huge.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1),
      },
      { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      { name: 'slides.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') },
    ]);
    await expect(form.locator('li[data-status="error"]')).toHaveCount(3);
    await expect(form).toContainText('Files can be at most 10 MB.');
    await expect(form).toContainText('The file is empty.');
    await expect(form).toContainText(
      'JARVIS reads PDF, Word (.docx), text, Markdown and CSV files.',
    );
    expect(sent.filter((r) => r.path === '/v1/attachments')).toEqual([]);
    // Can't send while files are refused: the reason is said, nothing is created.
    await form.locator('textarea').fill('Summarize these');
    await form.locator('textarea').press('Enter');
    await expect(form).toContainText('Remove the files that couldn’t be attached, then send.');
    expect(sent.filter((r) => r.path === '/v1/tasks')).toEqual([]);
    for (const name of ['huge.pdf', 'empty.txt', 'slides.pptx']) {
      await form.getByRole('button', { name: `Remove ${name}` }).click();
    }
    // An uploaded file that is removed again is deleted on the server.
    await input.setInputFiles({
      name: 'notes.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('a,b'),
    });
    await expect(form.locator('li[data-status="ready"]')).toHaveCount(1);
    await form.getByRole('button', { name: 'Remove notes.csv' }).click();
    await expect
      .poll(() => sent.some((r) => r.method === 'DELETE' && r.path.startsWith('/v1/attachments/')))
      .toBe(true);
    // More than five files at once: the extra ones are not added, and that is said.
    await input.setInputFiles(
      Array.from({ length: 6 }, (_, i) => ({
        name: `part-${i + 1}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('x'),
      })),
    );
    await expect(form.locator('ul[aria-label] > li')).toHaveCount(ATTACHMENT_LIMITS.maxPerRequest);
    await expect(form).toContainText('You can attach up to 5 files to one request.');
    expect(api.errors).toEqual([]);
  });

  test('a new request with files sends their ids and opens the task', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, {
      path: '/',
      options: { overrides: { uploadAttachment: slowUpload } },
    });
    const sent = recorder(page);
    const form = page.locator('main form').first();
    await form.locator('textarea').fill('Summarize the report');
    await form
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'report.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF'),
      });
    // Sending while the upload runs waits for it, and says so.
    await form.locator('textarea').press('Enter');
    await expect(form).toContainText('Wait until the files have finished uploading.');
    await expect(form.locator('li[data-status="ready"]')).toHaveCount(1);
    await form.locator('textarea').press('Enter');
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    const create = sent.find((r) => r.path === '/v1/tasks');
    expect(create?.body).toMatchObject({
      request: 'Summarize the report',
      attachmentIds: [expect.any(String)],
    });
    await expect(page.locator('main a[download="report.pdf"]')).toBeVisible();
    expect(api.errors).toEqual([]);
  });

  test('a follow-up waits for the active task of its conversation', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: `/tasks/${PB.a2}` });
    const sent = recorder(page);
    const form = page.locator('main form').last();
    await expect(page.locator('main').getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/tasks/${PB.a3}`,
    );
    await form.locator('textarea').fill('Also send it to Mia');
    await expect(form.getByRole('button', { name: 'Send follow-up' })).toBeDisabled();
    await form.locator('textarea').press('Enter');
    expect(sent.filter((r) => r.path.endsWith('/messages'))).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test('conversation history: search, open, delete', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL!, { path: '/tasks/conversations' });
    const rows = page.locator('main ul[aria-label] > li');
    const all = await rows.count();
    expect(all).toBeGreaterThan(3);
    await page.getByRole('searchbox').fill('quarterly');
    await expect(rows).toHaveCount(1);
    await expect(page).toHaveURL(/q=quarterly/);
    await rows.first().getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${PB.c2}$`));
    // Delete the whole conversation from its task page.
    await page.getByRole('button', { name: 'Delete conversation…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete conversation' }).click();
    await expect(page).toHaveURL(/\/tasks\/conversations$/);
    await expect(page.getByText('Conversation deleted.')).toBeVisible();
    expect(api.calls).toContain('deleteConversation');
    expect(api.errors).toEqual([]);
  });

  test('skills: turning one off saves it; planned and core skills have no switch', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/settings#skills' });
    const sent = recorder(page);
    const skills = page.locator('#skills');
    const email = skills.getByRole('switch', { name: /^Email/ });
    await expect(email).toHaveAttribute('aria-checked', 'true');
    await email.click();
    await expect(email).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Email turned off.')).toBeVisible();
    expect(sent.find((r) => r.path === '/v1/skills/email-management')?.body).toEqual({
      enabled: false,
    });
    await expect(skills).toContainText('Turned off. JARVIS won’t plan or run its actions.');
    // Planned skills and the core planning skill can't be switched.
    await expect(skills.getByRole('switch')).toHaveCount(6);
    await expect(skills).toContainText('Coming later');
    // Translation needs a model in basic mode: said, not hidden.
    await expect(skills).toContainText('Needs an AI model, and none is available right now.');
    expect(api.errors).toEqual([]);
  });

  test('schedules: create with a weekly recurrence, pause, resume and delete', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/tasks/scheduled' });
    const sent = recorder(page);
    await page.getByRole('button', { name: 'New schedule' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Friday digest');
    await dialog
      .getByLabel('What should JARVIS do each time?')
      .fill('Summarize https://example.com/news and email it to me');
    await dialog.locator('label:has(input[value="weekly"])').click();
    await dialog.getByRole('button', { name: 'Friday' }).click();
    await dialog.getByLabel('Time', { exact: true }).fill('17:30');
    await expect(dialog.locator('ol time')).toHaveCount(3);
    expect(api.calls).toContain('previewSchedule');
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(page.getByText('Schedule created.')).toBeVisible();
    const create = sent.find((r) => r.method === 'POST' && r.path === '/v1/schedules');
    expect(create?.body).toMatchObject({
      title: 'Friday digest',
      recurrence: { frequency: 'weekly', time: '17:30', timeZone: 'Europe/Berlin' },
    });
    expect(
      (create?.body as { recurrence: { byWeekday: string[] } }).recurrence.byWeekday,
    ).toContain('FR');
    const card = page.locator('main ul[aria-label] > li', { hasText: 'Friday digest' });
    await card.getByRole('button', { name: 'Pause: Friday digest' }).click();
    await expect(card).toContainText('Paused by you.');
    await card.getByRole('button', { name: 'Resume: Friday digest' }).click();
    await expect(card).not.toContainText('Paused by you.');
    await card.getByRole('button', { name: 'Delete: Friday digest' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete schedule' }).click();
    await expect(card).toHaveCount(0);
    expect(api.calls).toEqual(
      expect.arrayContaining(['pauseSchedule', 'resumeSchedule', 'deleteSchedule']),
    );
    expect(api.errors).toEqual([]);
  });

  test('schedules: a weekly schedule needs a day; the server explains a refusal', async ({
    page,
    context,
    baseURL,
  }) => {
    const refuse: MockHandler = () => ({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'limit',
          requestId: 'mock',
          details: { reason: 'SCHEDULE_LIMIT_REACHED', max: 20 },
        },
      },
    });
    const api = await open(page, context, baseURL!, {
      path: '/tasks/scheduled',
      options: { overrides: { createSchedule: refuse } },
    });
    await page.getByRole('button', { name: 'New schedule' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Digest');
    await dialog.getByLabel('What should JARVIS do each time?').fill('Email me: hello');
    await dialog.locator('label:has(input[value="weekly"])').click();
    for (const pressed of await dialog.locator('button[aria-pressed="true"]').all())
      await pressed.click();
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog).toContainText('Choose at least one day.');
    await dialog.getByRole('button', { name: 'Monday' }).click();
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog).toContainText(
      'You can have up to 20 schedules. Delete one to add another.',
    );
    expect(api.errors).toEqual([]);
  });

  test('webhooks: the secret is shown once; test send lands in the log; turn off', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/connections' });
    const developer = page.locator('#developer');
    await developer.getByRole('button', { name: 'Add endpoint' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Endpoint URL').fill('http://hooks.example.com');
    await dialog.getByRole('button', { name: 'Add endpoint' }).click();
    await expect(dialog).toContainText('Webhook addresses must start with https://.');
    await dialog.getByLabel('Endpoint URL').fill('https://hooks.example.com/jarvis');
    await dialog.getByRole('button', { name: 'Add endpoint' }).click();
    const secretDialog = page.getByRole('dialog');
    const secret = (await secretDialog.locator('code').textContent()) ?? '';
    expect(secret).toMatch(/^whsec_/);
    await secretDialog.getByRole('button', { name: 'I’ve saved it' }).click();
    // Never shown again: only the hint remains.
    await expect(page.locator('body')).not.toContainText(secret);
    const added = developer.locator('article', { hasText: 'hooks.example.com/jarvis' });
    await added.getByRole('button', { name: 'Send test (hooks.example.com)' }).click();
    await expect(added.locator('ol li').first()).toContainText('Test');
    await added.getByRole('switch').click();
    await expect(added).toContainText('Turned off by you.');
    expect(api.calls).toEqual(
      expect.arrayContaining(['createWebhook', 'testWebhook', 'updateWebhook']),
    );
    expect(api.errors).toEqual([]);
  });

  test('webhooks: a blocked address is explained by the server reason', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/connections' });
    await page.locator('#developer').getByRole('button', { name: 'Add endpoint' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Endpoint URL').fill('https://intranet.haddad.internal/hook');
    await dialog.getByRole('button', { name: 'Add endpoint' }).click();
    await expect(dialog).toContainText(
      'intranet.haddad.internal is on a private or local network, so JARVIS won’t send to it.',
    );
    expect(api.errors).toEqual([]);
  });

  test('retention and the time-zone picker save through the profile', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: '/settings#privacy' });
    const sent = recorder(page);
    await page.getByLabel('Keep memories').selectOption('90');
    await expect
      .poll(() => sent.find((r) => r.method === 'PATCH' && r.path === '/v1/me')?.body)
      .toEqual({ preferences: { retention: { memoryDays: 90 } } });
    // The time-zone picker offers exactly the server's list.
    const zone = page.getByLabel('Time zone');
    const options = await zone.locator('option').count();
    expect(options).toBe(api.state.timeZones.length);
    await zone.selectOption('America/New_York');
    await expect
      .poll(() => sent.filter((r) => r.path === '/v1/me').map((r) => r.body))
      .toContainEqual({ timeZone: 'America/New_York' });
    expect(api.errors).toEqual([]);
  });

  test('approving a schedule creates it; the memory approval shows the exact text', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { path: `/tasks/${T_SCHEDULE}` });
    await page.getByRole('button', { name: 'Review and decide' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('Nothing is approved in advance');
    await sheet.getByRole('button', { name: 'Approve and create this schedule' }).click();
    await expect(page.getByText('Approved. JARVIS is continuing the task.')).toBeVisible();
    expect(api.calls).toContain('decideApproval');
    expect(api.errors).toEqual([]);
  });

  test('new notification kinds read in plain language and link to their screens', async ({
    page,
    context,
    baseURL,
  }) => {
    const now = Date.now();
    const extra: Notification[] = [
      {
        id: 'ab000001-0000-4000-8000-000000000001',
        kind: 'schedule_paused',
        taskId: null,
        data: { scheduleTitle: 'Morning WCAG news', reason: 'failures' },
        readAt: null,
        createdAt: new Date(now - MIN).toISOString(),
      },
      {
        id: 'ab000001-0000-4000-8000-000000000002',
        kind: 'webhook_disabled',
        taskId: null,
        data: { endpointHost: 'staging.haddad.example' },
        readAt: null,
        createdAt: new Date(now - 2 * MIN).toISOString(),
      },
    ];
    const api = await open(page, context, baseURL!, {
      path: '/tasks',
      options: { fixtures: (f) => ({ ...f, notifications: [...extra, ...f.notifications] }) },
    });
    await page
      .getByRole('button', { name: /^Notifications/ })
      .first()
      .click();
    const paused = page.getByRole('link', {
      name: /Morning WCAG news.*paused after repeated failures/,
    });
    await expect(paused).toHaveAttribute('href', '/tasks/scheduled');
    await expect(
      page.getByRole('link', { name: /Webhook to .*staging\.haddad\.example.* turned off/ }),
    ).toHaveAttribute('href', '/connections#developer');
    expect(api.errors).toEqual([]);
  });

  test('screens run without console errors', async ({ page, context, baseURL }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const api = await open(page, context, baseURL!, { path: '/tasks/conversations' });
    for (const target of [
      '/tasks/scheduled',
      `/tasks/${PB.a1}`,
      `/tasks/${PB.b1}`,
      `/tasks/${PB.c1}`,
      '/settings',
      '/connections',
      '/memory',
      `/tasks/${IDS.taskEmail}`,
    ]) {
      await page.goto(target);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    expect(problems).toEqual([]);
    expect(api.errors).toEqual([]);
  });
});

/** An upload that takes a moment (to see "uploading" and the wait notice). */
const slowUpload: MockHandler = async (req, s) => {
  const res = await DEFAULT_HANDLERS.uploadAttachment!(req, s);
  return { ...res, delayMs: 1200 };
};
