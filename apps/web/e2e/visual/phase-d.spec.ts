/**
 * Phase D screens with the contract-validated mock API (docs/architecture/phase-d.md §3.1,
 * §3.7): the voice conversation mode (listening, hearing, sending, thinking, speaking sentence
 * by sentence as the answer streams, barge-in, waiting for an approval that is decided on
 * screen only, busy, reconnecting with one Idempotency-Key, failed, permission denied,
 * unsupported browser, stop phrases, Esc, keyboard and text fallback) and Settings › Voice —
 * light + dark × en + de + ar on desktop and mobile, axe on every state — driven by a fake
 * Web Speech API (e2e/support/fake-speech.ts) and a live SSE stream.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3601 npx playwright test e2e/visual/phase-d.spec.ts
 */
import type { CallSession, TaskDetail, TaskStep } from '@jarvis/contracts';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureLocale, Fixtures } from '../support/fixtures';
import { installFakeSpeech, speech, type FakeSpeechOptions } from '../support/fake-speech';
import { liveStream, type LiveStream } from '../support/live-stream';
import { NUMBER, OWN_NUMBER, PD, withPhaseD, type PhaseDOptions } from '../support/phase-d';
import {
  MOCK_VERIFICATION_CODE,
  mockApi,
  signInWithMock,
  type MockApiOptions,
} from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations, SCREENSHOT_DIR } from '../support/visual';
import { catalogs } from '../../src/i18n/messages';

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'de', 'ar'] as const;
type Theme = (typeof THEMES)[number];

const VOICES = [
  { voiceURI: 'mock-en-samantha', name: 'Samantha', lang: 'en-US', localService: true },
  { voiceURI: 'mock-en-daniel', name: 'Daniel', lang: 'en-GB', localService: true },
  { voiceURI: 'mock-de-anna', name: 'Anna', lang: 'de-DE', localService: true },
  { voiceURI: 'mock-de-online', name: 'Google Deutsch', lang: 'de-DE', localService: false },
  { voiceURI: 'mock-ar-maged', name: 'Maged', lang: 'ar-SA', localService: true },
];

/** The words a user says in each language, and what JARVIS answers. */
const SAID = {
  en: {
    ask: 'What is on my calendar tomorrow?',
    answer: [
      'Tomorrow you have two meetings. ',
      'The design review starts at 10:00, ',
      'and lunch with Omar is at 12:30. ',
      'Nothing else is planned.',
    ],
    next: 'Email that to me',
    stop: 'Stop.',
  },
  de: {
    ask: 'Was steht morgen in meinem Kalender?',
    answer: [
      'Morgen hast du zwei Termine. ',
      'Das Design-Review beginnt um 10:00 Uhr, ',
      'und das Mittagessen mit Omar ist um 12:30 Uhr. ',
      'Sonst ist nichts geplant.',
    ],
    next: 'Schick mir das per E-Mail',
    stop: 'Stopp!',
  },
  ar: {
    ask: 'ما المواعيد في تقويمي غدًا؟',
    answer: [
      'لديك غدًا اجتماعان. ',
      'تبدأ مراجعة التصميم الساعة 10:00، ',
      'والغداء مع عمر الساعة 12:30. ',
      'لا شيء آخر مخطط له.',
    ],
    next: 'أرسل ذلك إليّ بالبريد',
    stop: 'توقف',
  },
} as const;

function variants(all = true): Array<{ theme: Theme; locale: FixtureLocale; name: string }> {
  const out: Array<{ theme: Theme; locale: FixtureLocale; name: string }> = [];
  for (const theme of THEMES)
    for (const locale of LOCALES)
      if (all || (theme === 'light' && locale === 'en') || (theme === 'dark' && locale === 'ar'))
        out.push({ theme, locale, name: `${theme}--${locale}` });
  return out;
}

/* ------------------------------------------------------------------ helpers */

function withVoicePrefs(f: Fixtures, conversation = true): Fixtures {
  return {
    ...f,
    me: {
      ...f.me,
      preferences: {
        ...f.me.preferences,
        voice: { ...f.me.preferences.voice, conversationMode: conversation },
      },
    },
  };
}

async function open(
  page: Page,
  context: Parameters<typeof signInWithMock>[0],
  baseURL: string,
  {
    locale = 'en',
    theme = 'light',
    path: target = '/',
    options = {},
    speechOptions = {},
    stream,
    conversation = true,
  }: {
    locale?: FixtureLocale;
    theme?: Theme;
    path?: string;
    options?: MockApiOptions;
    speechOptions?: FakeSpeechOptions;
    stream?: LiveStream;
    conversation?: boolean;
  },
) {
  await installFakeSpeech(page, { voices: VOICES, ...speechOptions });
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, {
    locale,
    theme,
    ...options,
    fixtures: (f) => {
      const next = withVoicePrefs(f, conversation);
      return options.fixtures ? options.fixtures(next) : next;
    },
  });
  await stream?.attach();
  await page.goto(target);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  return api;
}

/** A screenshot of one region (a settings section, a card). */
async function region(locator: Locator, testInfo: TestInfo, name: string) {
  await locator.page().evaluate(() => document.fonts.ready);
  await locator.page().waitForTimeout(200);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}--${testInfo.project.name}.png`);
  await locator.screenshot({ path: file, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await capture(page, testInfo, name, { fullPage: false });
}

/** Copy as rendered: interpolated values are wrapped in Unicode isolates. */
function loose(text: string): RegExp {
  const chars = [...text].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(chars.join('[\\u2066-\\u2069]*'));
}

/** Opens voice mode from the page's composer. */
async function openVoice(page: Page, locale: FixtureLocale = 'en') {
  await page
    .getByRole('main')
    .getByRole('button', { name: catalogs[locale].composer.voice, exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Waits until the app has fetched the task in this status. */
function taskFetched(page: Page, id: string, status: TaskDetail['status']) {
  return page.waitForResponse(
    async (r) =>
      r.url().endsWith(`/api/v1/tasks/${id}`) &&
      r.request().method() === 'GET' &&
      ((await r.json().catch(() => null)) as { status?: string } | null)?.status === status,
  );
}

/** The step list of an answer task while it runs, then completed. */
function answerStep(taskId: string, status: TaskStep['status'], at: string): TaskStep {
  return {
    id: `${taskId.slice(0, 24)}aaaaaaaaaaaa`,
    position: 0,
    title: 'Answer',
    titleMessage: null,
    toolId: 'assistant.answer',
    riskLevel: 'LOW',
    status,
    requiresApproval: false,
    policy: { decision: 'allow', reasons: ['RISK_LOW'] },
    inputPreview: {},
    output: null,
    evidence: [],
    attempts: 1,
    startedAt: at,
    completedAt: status === 'SUCCEEDED' ? at : null,
    error: null,
  };
}

function setTask(state: Fixtures, id: string, patch: Partial<TaskDetail>): TaskDetail {
  const d = state.taskDetails[id]!;
  const next = { ...d, ...patch } as TaskDetail;
  state.taskDetails[id] = next;
  state.tasks = state.tasks.map((t) =>
    t.id === id ? { ...t, status: next.status, resultSummary: next.resultSummary } : t,
  );
  return next;
}

/* ------------------------------------------------------------------ the conversation, end to end */

test.describe('voice conversation', () => {
  test('listen → send → speak the streamed answer → barge-in → follow-up → stop', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, { stream });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect(dialog.getByRole('heading', { name: 'Conversation with JARVIS' })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Conversation' })).toBeChecked();
    await expect(dialog.getByRole('status').first()).toHaveText('Listening…');
    await expect.poll(() => s.listening()).toBe(1);
    expect(await s.runs()).toEqual(['en-US']);

    // Hearing: interim text, then the final words; nothing is sent before the pause.
    await s.hear([], 'what is on my');
    await expect(dialog.getByText('what is on my')).toBeVisible();
    await s.hear([SAID.en.ask]);
    await page.waitForTimeout(500);
    expect(api.calls.filter((c) => c === 'createTask')).toHaveLength(0);
    const created = page.waitForRequest(
      (r) => r.url().endsWith('/api/v1/tasks') && r.method() === 'POST',
    );
    const request = await created;
    expect(request.postDataJSON()).toMatchObject({
      request: SAID.en.ask,
      source: 'voice',
      language: 'en',
    });
    expect(request.postDataJSON().voiceSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.headers()['idempotency-key']).toBeTruthy();
    await expect(dialog.getByRole('status').first()).toHaveText('Working on it…');
    const taskId = api.state.tasks[0]!.id;
    const at = new Date().toISOString();

    // The task runs; the answer streams — the first sentence is spoken while it is still written.
    setTask(api.state, taskId, {
      status: 'RUNNING',
      steps: [answerStep(taskId, 'RUNNING', at)],
      canCancel: true,
    });
    stream.send({ type: 'task.status_changed', taskId, data: { from: 'PLANNING', to: 'RUNNING' } });
    stream.send({ type: 'task.answer.delta', taskId, data: { text: SAID.en.answer[0] } });
    stream.send({ type: 'task.answer.delta', taskId, data: { text: SAID.en.answer[1] } });
    await expect.poll(() => s.speaking()).toBe(SAID.en.answer[0].trim());
    await expect(dialog.getByRole('status').first()).toHaveText('Speaking…');
    // The app-wide Presence says so too (it reflects the real synthesis state).
    await expect.poll(() => page.locator('[data-state="speaking"]').count()).toBeGreaterThan(1);
    await shot(page, testInfo, 'voice--speaking--light--en');
    await expectNoSeriousA11yViolations(page);
    await s.finish();
    // A sentence is spoken once it is complete: when the next one begins (or the answer ends).
    stream.send({ type: 'task.answer.delta', taskId, data: { text: SAID.en.answer[2] } });
    await page.waitForTimeout(300);
    expect(await s.speaking()).toBeNull();
    stream.send({ type: 'task.answer.delta', taskId, data: { text: SAID.en.answer[3] } });
    await expect.poll(() => s.speaking()).toBe(`${SAID.en.answer[1]}${SAID.en.answer[2]}`.trim());

    // Barge-in: the user speaks — JARVIS stops at once; the rest is not spoken.
    await s.hear([], 'okay thanks');
    await expect.poll(() => s.speaking()).toBeNull();
    await expect(dialog.getByText('Interrupted')).toBeVisible();
    await expect(dialog.getByRole('status').first()).toHaveText('Listening…');
    const fullAnswer = SAID.en.answer.join('');
    const completed = taskFetched(page, taskId, 'COMPLETED');
    setTask(api.state, taskId, {
      status: 'COMPLETED',
      outcome: 'answer',
      answer: fullAnswer,
      resultSummary: fullAnswer,
      steps: [answerStep(taskId, 'SUCCEEDED', at)],
      canCancel: false,
      completedAt: new Date().toISOString(),
    });
    stream.send({
      type: 'task.status_changed',
      taskId,
      data: { from: 'RUNNING', to: 'COMPLETED' },
    });
    await completed;
    // "okay thanks" is the user's next utterance: a follow-up in the same conversation.
    const conversationId = api.state.tasks[0]!.conversationId!;
    const sending = page.waitForRequest(
      (r) => r.url().endsWith(`/conversations/${conversationId}/messages`) && r.method() === 'POST',
    );
    await s.hear(['okay thanks']);
    const followUp = await sending;
    expect(followUp.postDataJSON()).toMatchObject({ request: 'okay thanks', source: 'voice' });
    const spokenTexts = (await s.spoken()).map((x) => x.text);
    expect(spokenTexts).not.toContain('Nothing else is planned.');

    // Captions: everything said, with speaker labels.
    const log = dialog.getByRole('log');
    await expect(log.getByText(SAID.en.ask)).toBeVisible();
    await expect(log.getByText('okay thanks')).toBeVisible();
    await shot(page, testInfo, 'voice--captions--light--en');

    // "stop" ends voice mode (never sent); the overlay closes on the conversation's newest task.
    await expect.poll(() => api.state.tasks.length).toBeGreaterThan(1);
    const second = api.state.tasks[0]!.id;
    setTask(api.state, second, {
      status: 'COMPLETED',
      outcome: 'answer',
      answer: 'You’re welcome.',
    });
    stream.send({
      type: 'task.status_changed',
      taskId: second,
      data: { from: 'RUNNING', to: 'COMPLETED' },
    });
    await expect.poll(() => s.speaking()).toBe('You’re welcome.');
    await s.finish();
    const ended = page.waitForRequest((r) => /\/voice-sessions\/[^/]+\/end$/.test(r.url()));
    await s.hear([SAID.en.stop]);
    const end = (await ended).postDataJSON();
    expect(end).toMatchObject({
      outcome: 'ended',
      turns: 2,
      bargeIns: 1,
      endReason: 'voice_command',
    });
    expect(Object.keys(end).sort()).toEqual(
      ['bargeIns', 'endReason', 'outcome', 'reconnects', 'transcriptChars', 'turns'].sort(),
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/tasks/${second}$`));
    expect(api.calls.filter((c) => c === 'createTask')).toHaveLength(1);
    expect(api.errors).toEqual([]);
    await stream.close();
  });
});

/* ------------------------------------------------------------------ phone calls */

async function openCalls(
  page: Page,
  context: Parameters<typeof signInWithMock>[0],
  baseURL: string,
  p: {
    locale?: FixtureLocale;
    theme?: Theme;
    path: string;
    phaseD?: PhaseDOptions;
    options?: MockApiOptions;
    stream?: LiveStream;
  },
) {
  const now = Date.now();
  const locale = p.locale ?? 'en';
  return open(page, context, baseURL, {
    locale,
    theme: p.theme ?? 'light',
    path: p.path,
    stream: p.stream,
    conversation: false,
    options: {
      now,
      ...p.options,
      fixtures: (f) => {
        const rich = withPhaseD(f, locale, now, p.phaseD);
        return p.options?.fixtures ? p.options.fixtures(rich) : rich;
      },
    },
  });
}

test.describe('phone calls — visual', () => {
  for (const { theme, locale, name } of variants()) {
    test(`approval sheet, live call, completed call — ${name}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await openCalls(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${PD.approval}`,
      });
      const panel = page.locator('main section:has(h2[id^="approval-"])');
      await expect(panel).toBeVisible();
      await panel.getByRole('button').last().click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByText(NUMBER.display).first()).toBeVisible();
      await shot(page, testInfo, `call--approval--${name}`);
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');

      await page.goto(`/tasks/${PD.live}`);
      await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
      await capture(page, testInfo, `call--live--${name}`);
      await expectNoSeriousA11yViolations(page);

      await page.goto(`/tasks/${PD.done}`);
      await expect(page.getByText(catalogs[locale].calls.outcome.title).first()).toBeVisible();
      await capture(page, testInfo, `call--completed--${name}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }

  for (const { theme, locale, name } of variants(false)) {
    test(`unsuccessful calls and lists — ${name}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await openCalls(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${PD.busy}`,
      });
      await expect(page.getByText(catalogs[locale].tasks.nextStep.titles.callRetry)).toBeVisible();
      await capture(page, testInfo, `call--busy--${name}`);
      await expectNoSeriousA11yViolations(page);
      for (const [id, label] of [
        [PD.unknown, 'unknown'],
        [PD.denied, 'do-not-call'],
        [PD.voicemail, 'voicemail'],
      ] as const) {
        await page.goto(`/tasks/${id}`);
        await expect(page.locator('main h1')).toBeVisible();
        await page.waitForTimeout(300);
        await capture(page, testInfo, `call--${label}--${name}`);
        await expectNoSeriousA11yViolations(page);
      }
      await page.goto('/tasks/calls');
      await expect(page.getByRole('list', { name: catalogs[locale].calls.title })).toBeVisible();
      await capture(page, testInfo, `calls--list--${name}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ voice: states and recovery */

/** Waits until the conversation has sent a request, and returns the new task's id. */
async function sentTask(api: Awaited<ReturnType<typeof open>>, count = 1) {
  await expect
    .poll(() => api.calls.filter((c) => c === 'createTask' || c === 'followUp').length)
    .toBe(count);
  return api.state.tasks[0]!.id;
}

/** Puts a phone_call approval on the task (as the API would after planning the call). */
function awaitApproval(
  state: Fixtures,
  taskId: string,
  approvalTemplate: Fixtures['approvals'][number],
) {
  const approval = { ...approvalTemplate, id: crypto.randomUUID(), taskId };
  state.approvals = [approval, ...state.approvals];
  return setTask(state, taskId, {
    status: 'AWAITING_APPROVAL',
    pendingApprovalId: approval.id,
    pendingApproval: { id: approval.id, untrustedSource: false },
    approvals: [approval],
  });
}

test.describe('voice conversation — states', () => {
  test('an approval is never given by voice: the sheet opens, "yes" is not a decision', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const stream = await liveStream(page);
    const now = Date.now();
    const api = await open(page, context, baseURL!, {
      stream,
      options: { now, fixtures: (f) => withPhaseD(f, 'en', now) },
    });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['Call my dentist at +49 30 1234567 and ask about Friday morning']);
    const taskId = await sentTask(api);
    const template = api.state.approvals.find((a) => a.details.kind === 'phone_call')!;
    awaitApproval(api.state, taskId, template);
    stream.send({ type: 'approval.requested', taskId, data: {} });
    stream.send({
      type: 'task.status_changed',
      taskId,
      data: { from: 'PLANNING', to: 'AWAITING_APPROVAL' },
    });
    // JARVIS says it out loud, and the ApprovalSheet opens on top of the conversation.
    await expect
      .poll(() => s.speaking())
      .toBe(catalogs.en.voice.conversation.lines.approvalOnScreen);
    const sheet = page.getByRole('dialog', { name: 'Review this phone call' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(NUMBER.display).first()).toBeVisible();
    await s.finish();
    await shot(page, testInfo, 'voice--approval-sheet--light--en');
    // Saying "yes" decides nothing: it is answered with the same sentence, nothing is sent.
    await s.hear(['Yes, approve it.']);
    await page.waitForTimeout(1400);
    expect(api.calls).not.toContain('decideApproval');
    await s.hear(['yes']);
    await expect
      .poll(
        async () =>
          (await s.spoken()).filter(
            (x) => x.text === catalogs.en.voice.conversation.lines.approvalOnScreen,
          ).length,
      )
      .toBe(3);
    expect(api.calls).not.toContain('decideApproval');
    // Plain assent is not even kept as a request.
    await expect(dialog.getByRole('textbox', { name: 'Message JARVIS' })).toHaveValue('');
    await expect
      .poll(async () => {
        await s.finish();
        return s.speaking();
      })
      .toBeNull();
    // Closing the sheet keeps the conversation waiting, with a way back to it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Review this phone call' })).toHaveCount(0);
    await expect(dialog.getByRole('status').first()).toHaveText('Waiting for your approval');
    await shot(page, testInfo, 'voice--awaiting--light--en');
    await expectNoSeriousA11yViolations(page);
    // A tap decides: Approve in the sheet.
    await dialog.getByRole('button', { name: 'Review and decide' }).click();
    const decide = page.waitForRequest((r) => /\/approvals\/[^/]+\/decision$/.test(r.url()));
    await page
      .getByRole('dialog', { name: 'Review this phone call' })
      .getByRole('button', { name: /Approve and call/ })
      .click();
    expect((await decide).postDataJSON()).toMatchObject({
      decision: 'approve',
      actionHash: template.actionHash,
    });
    setTask(api.state, taskId, {
      status: 'RUNNING',
      pendingApprovalId: null,
      pendingApproval: null,
    });
    stream.send({
      type: 'task.status_changed',
      taskId,
      data: { from: 'AWAITING_APPROVAL', to: 'RUNNING' },
    });
    await expect(dialog.getByRole('status').first()).toHaveText('Working on it…');
    expect(api.errors).toEqual([]);
    await stream.close();
  });

  test('busy: speech while the request still runs is kept in the text field, not sent', async ({
    page,
    context,
    baseURL,
  }) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, { stream });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['Summarize https://www.w3.org/TR/WCAG22/']);
    const taskId = await sentTask(api);
    setTask(api.state, taskId, { status: 'RUNNING' });
    stream.send({ type: 'task.status_changed', taskId, data: { from: 'PLANNING', to: 'RUNNING' } });
    await expect(dialog.getByRole('status').first()).toHaveText('Working on it…');
    await s.hear(['and translate it to German']);
    await expect.poll(() => s.speaking()).toBe(catalogs.en.voice.conversation.lines.busy);
    await expect(dialog.getByRole('textbox', { name: 'Message JARVIS' })).toHaveValue(
      'and translate it to German',
    );
    await expect(dialog.getByText('Not sent — it’s in the text field')).toBeVisible();
    expect(api.calls.filter((c) => c === 'followUp')).toHaveLength(0);
    expect(api.errors).toEqual([]);
    await stream.close();
  });

  test('network: a failed send is retried with the same Idempotency-Key, then succeeds', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, { stream });
    await stream.connected();
    const keys: string[] = [];
    let failures = 2;
    await page.route('**/api/v1/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (failures-- > 0) return route.abort('internetdisconnected');
      return route.fallback();
    });
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['What is on my calendar tomorrow?']);
    await expect(dialog.getByRole('status').first()).toHaveText('Connection lost. Trying again…');
    await shot(page, testInfo, 'voice--retrying--light--en');
    await expect(dialog.getByRole('status').first()).toHaveText('Working on it…', {
      timeout: 10_000,
    });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(api.calls.filter((c) => c === 'createTask')).toHaveLength(1);
    expect(api.errors).toEqual([]);
    await stream.close();
  });

  test('network: after the last retry listening ends, the words stay in the focused field', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    test.setTimeout(60_000);
    const stream = await liveStream(page);
    await open(page, context, baseURL!, { stream });
    await stream.connected();
    await page.route('**/api/v1/tasks', (route) =>
      route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.fallback(),
    );
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['Remind me to call Omar tomorrow']);
    await expect(dialog.getByRole('status').first()).toHaveText('Couldn’t send your request.', {
      timeout: 30_000,
    });
    const field = dialog.getByRole('textbox', { name: 'Message JARVIS' });
    await expect(field).toHaveValue('Remind me to call Omar tomorrow');
    await expect(field).toBeFocused();
    expect(await s.listening()).toBe(0);
    await shot(page, testInfo, 'voice--failed--light--en');
    await expectNoSeriousA11yViolations(page);
    await stream.close();
  });

  test('the stream drops while working: the task is polled and the answer still arrives', async ({
    page,
    context,
    baseURL,
  }) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, { stream });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['How long is the flight to Cairo?']);
    const taskId = await sentTask(api);
    stream.refuse(true);
    stream.drop();
    await expect(dialog.getByRole('status').first()).toHaveText('Reconnecting to live updates…', {
      timeout: 15_000,
    });
    setTask(api.state, taskId, {
      status: 'COMPLETED',
      outcome: 'answer',
      answer: 'About four hours from Berlin.',
    });
    await expect
      .poll(() => s.speaking(), { timeout: 15_000 })
      .toBe('About four hours from Berlin.');
    stream.refuse(false);
    await stream.close();
  });

  test('keyboard: Space mutes and unmutes, text fallback, Esc ends', async ({
    page,
    context,
    baseURL,
  }) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, { stream });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect.poll(() => s.listening()).toBe(1);
    // Space (focus on the overlay itself) turns the microphone off and on.
    await dialog.getByRole('heading', { name: 'Conversation with JARVIS' }).click();
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('status').first()).toHaveText('Microphone off');
    await expect.poll(() => s.listening()).toBe(0);
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('status').first()).toHaveText('Listening…');
    await expect.poll(() => s.listening()).toBe(1);
    // Typing works at any time (source 'text', same voice session).
    const field = dialog.getByRole('textbox', { name: 'Message JARVIS' });
    await field.fill('What time is it in Riyadh?');
    const sent = page.waitForRequest(
      (r) => r.url().endsWith('/api/v1/tasks') && r.method() === 'POST',
    );
    await field.press('Enter');
    const body = (await sent).postDataJSON();
    expect(body).toMatchObject({ request: 'What time is it in Riyadh?', source: 'text' });
    expect(body.voiceSessionId).toBeTruthy();
    await expect(dialog.getByRole('log').getByText('typed')).toBeVisible();
    // Esc ends voice mode (the task keeps running).
    const ended = page.waitForRequest((r) => /\/voice-sessions\/[^/]+\/end$/.test(r.url()));
    await field.press('Escape');
    expect((await ended).postDataJSON()).toMatchObject({
      endReason: 'escape_key',
      outcome: 'ended',
      turns: 1,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.calls).not.toContain('cancelTask');
    await stream.close();
  });

  for (const [locale, phrase] of [
    ['de', SAID.de.stop],
    ['ar', SAID.ar.stop],
  ] as const) {
    test(`a spoken stop phrase ends voice mode — ${locale}`, async ({ page, context, baseURL }) => {
      await open(page, context, baseURL!, { locale });
      const s = speech(page);
      const dialog = await openVoice(page, locale);
      await expect(
        dialog.getByRole('heading', { name: catalogs[locale].voice.conversation.title }),
      ).toBeVisible();
      await expect.poll(() => s.listening()).toBe(1);
      expect(await s.runs()).toEqual([locale === 'de' ? 'de-DE' : 'ar-SA']);
      const ended = page.waitForRequest((r) => /\/voice-sessions\/[^/]+\/end$/.test(r.url()));
      await s.hear([phrase]);
      expect((await ended).postDataJSON()).toMatchObject({
        endReason: 'voice_command',
        outcome: 'cancelled',
        turns: 0,
      });
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }

  test('one request (dictation) runs on the same speech seam and is sent once', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, { conversation: false });
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect(dialog.getByRole('radio', { name: 'One request' })).toBeChecked();
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['Remember that I like'], 'window');
    await s.hear(['window seats']);
    await expect(dialog.getByText('Remember that I like window seats')).toBeVisible();
    const sent = page.waitForRequest(
      (r) => r.url().endsWith('/api/v1/tasks') && r.method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Send this request' }).click();
    expect((await sent).postDataJSON()).toMatchObject({
      request: 'Remember that I like window seats',
      source: 'voice',
      language: 'en',
    });
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    expect(api.calls.filter((c) => c === 'createTask')).toHaveLength(1);
  });

  test('microphone blocked: explains how to allow it, typing still works', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    await open(page, context, baseURL!, { speechOptions: { mic: 'denied' } });
    const dialog = await openVoice(page);
    await expect(dialog.getByRole('status').first()).toHaveText('Microphone access is blocked.');
    await expect(dialog.getByRole('textbox', { name: 'Message JARVIS' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Listen again' })).toBeVisible();
    await shot(page, testInfo, 'voice--denied--light--en');
    await expectNoSeriousA11yViolations(page);
  });

  test('no speech recognition (like Firefox): a typed conversation, answered aloud', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, {
      stream,
      speechOptions: { noRecognition: true },
    });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect(dialog.getByRole('status').first()).toHaveText(
      'Voice input isn’t available in this browser.',
    );
    await expect(
      dialog.getByText('Type your requests below. JARVIS still answers aloud.'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: /microphone/i })).toHaveCount(0);
    await shot(page, testInfo, 'voice--unsupported--light--en');
    await dialog.getByRole('textbox', { name: 'Message JARVIS' }).fill('Hello');
    await dialog.getByRole('textbox', { name: 'Message JARVIS' }).press('Enter');
    const taskId = await sentTask(api);
    setTask(api.state, taskId, { status: 'COMPLETED', outcome: 'answer', answer: 'Hello, Layla.' });
    stream.send({
      type: 'task.status_changed',
      taskId,
      data: { from: 'RUNNING', to: 'COMPLETED' },
    });
    await expect.poll(() => s.speaking()).toBe('Hello, Layla.');
    await stream.close();
  });

  test('no speech output: replies appear as captions only', async ({ page, context, baseURL }) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, {
      stream,
      speechOptions: { noSynthesis: true },
    });
    await stream.connected();
    const s = speech(page);
    const dialog = await openVoice(page);
    await expect(
      dialog.getByText('This browser can’t speak, so replies appear as captions only.'),
    ).toBeVisible();
    await expect.poll(() => s.listening()).toBe(1);
    await s.hear(['Hi']);
    const taskId = await sentTask(api);
    setTask(api.state, taskId, {
      status: 'COMPLETED',
      outcome: 'answer',
      answer: 'Hello. How can I help?',
    });
    stream.send({
      type: 'task.status_changed',
      taskId,
      data: { from: 'RUNNING', to: 'COMPLETED' },
    });
    await expect(dialog.getByRole('log').getByText('Hello. How can I help?')).toBeVisible();
    await expect(dialog.getByRole('status').first()).toHaveText('Listening…');
    await stream.close();
  });
});

/* ------------------------------------------------------------------ voice: visual matrix */

test.describe('voice conversation — visual', () => {
  for (const { theme, locale, name } of variants()) {
    test(`listening, hearing, speaking — ${name}`, async ({ page, context, baseURL }, testInfo) => {
      const stream = await liveStream(page);
      const api = await open(page, context, baseURL!, { locale, theme, stream });
      await stream.connected();
      const s = speech(page);
      const c = catalogs[locale].voice.conversation;
      const dialog = await openVoice(page, locale);
      await expect(dialog.getByRole('status').first()).toHaveText(c.states.listening);
      await shot(page, testInfo, `voice--listening--${name}`);
      await expectNoSeriousA11yViolations(page);
      await s.hear([SAID[locale].ask]);
      const taskId = await sentTask(api);
      setTask(api.state, taskId, { status: 'RUNNING' });
      stream.send({
        type: 'task.status_changed',
        taskId,
        data: { from: 'PLANNING', to: 'RUNNING' },
      });
      for (const part of SAID[locale].answer.slice(0, 3)) {
        stream.send({ type: 'task.answer.delta', taskId, data: { text: part } });
      }
      await expect.poll(() => s.speaking()).toBe(SAID[locale].answer[0]!.trim());
      await s.hear([], SAID[locale].next.slice(0, 12));
      await expect.poll(() => s.speaking()).toBeNull();
      await shot(page, testInfo, `voice--barge-in--${name}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
      await stream.close();
    });
  }
});

/* ------------------------------------------------------------------ phone calls: behaviour */

/** POST /v1/tasks/:id/retry: a definitely-ended call → a new attempt (what the API answers). */
function retryOverride(now: number): MockApiOptions['overrides'] {
  return {
    retryTask: (req, s) => {
      const d = s.taskDetails[req.params.id ?? ''];
      if (!d) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Task' } } };
      const body = req.body as { acknowledgeUnknownOutcome?: boolean };
      if (d.error?.code === 'OUTCOME_UNKNOWN' && !body.acknowledgeUnknownOutcome) {
        return {
          status: 409,
          body: {
            error: {
              code: 'INVALID_STATE',
              message: 'Acknowledge first',
              details: { requiresAcknowledgement: true },
            },
          },
        };
      }
      const previous = d.calls?.at(-1);
      const attempt2: CallSession | null = previous
        ? {
            ...previous,
            id: PD.callBusyRetry,
            attempt: previous.attempt + 1,
            status: 'queued',
            result: null,
            outcome: null,
            failureReason: null,
            providerCallSid: null,
            timeline: [
              {
                status: 'queued',
                providerStatus: null,
                sequence: null,
                at: new Date(now).toISOString(),
              },
            ],
            turns: [],
            endedAt: null,
            durationSeconds: null,
            createdAt: new Date().toISOString(),
          }
        : null;
      const next: TaskDetail = {
        ...d,
        status: 'RUNNING',
        error: null,
        canRetry: false,
        canCancel: true,
        completedAt: null,
        calls: [...(d.calls ?? []), ...(attempt2 ? [attempt2] : [])],
      };
      s.taskDetails[d.id] = next;
      s.tasks = s.tasks.map((t) => (t.id === d.id ? { ...t, status: 'RUNNING', error: null } : t));
      return { status: 202, body: s.tasks.find((t) => t.id === d.id) };
    },
  };
}

function updateCall(state: Fixtures, taskId: string, callId: string, patch: Partial<CallSession>) {
  const d = state.taskDetails[taskId]!;
  state.taskDetails[taskId] = {
    ...d,
    calls: (d.calls ?? []).map((c) => (c.id === callId ? { ...c, ...patch } : c)),
  };
}

test.describe('phone calls — behaviour', () => {
  test('the call is approved by a click on the exact action (number, script, recording)', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await openCalls(page, context, baseURL!, { path: `/tasks/${PD.approval}` });
    await page.locator('main section:has(h2[id^="approval-"])').getByRole('button').last().click();
    const sheet = page.getByRole('dialog', { name: 'Review this phone call' });
    // Everything the user must see before JARVIS speaks for them.
    for (const text of [
      'my dentist',
      NUMBER.display,
      'Germany',
      'Layla Haddad',
      '+49 30 5550100',
      'Ask for free times',
      'Between 9:00 AM and 12:00 PM',
      'Exactly what JARVIS will say',
      'May I record this call? The recording is for Layla Haddad only. Please say yes or no.',
      'Patient number',
      'P-20417',
      'Only if they agree when asked; otherwise not recorded',
      'Leave the voicemail message above',
      '8:00 AM–8:00 PM',
    ]) {
      await expect(sheet.getByText(loose(text)).first()).toBeVisible();
    }
    await expect(
      sheet.getByText(/Hello, this is JARVIS, an AI assistant calling on behalf of Layla Haddad/),
    ).toBeVisible();
    await expect(sheet.getByText(/your verified number/)).toContainText(OWN_NUMBER.masked);
    await expect(sheet.getByText('$0.75')).toBeVisible();
    const decision = page.waitForRequest((r) => /\/approvals\/[^/]+\/decision$/.test(r.url()));
    await sheet.getByRole('button', { name: 'Approve and call, exactly as shown' }).click();
    const body = (await decision).postDataJSON();
    expect(body).toEqual({
      decision: 'approve',
      actionHash: api.state.approvals.find((a) => a.id === PD.callApproval)!.actionHash,
    });
    expect(api.errors).toEqual([]);
  });

  test('scenario 4: busy → Retry places a new attempt → live captions → completed', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const now = Date.now();
    const stream = await liveStream(page);
    const api = await openCalls(page, context, baseURL!, {
      path: `/tasks/${PD.busy}`,
      stream,
      options: { now, overrides: retryOverride(now) },
    });
    await stream.connected();
    await expect(page.getByText('The call didn’t reach anyone')).toBeVisible();
    await expect(
      page.getByText('The line was busy. Nothing was said or agreed. You can try again.').first(),
    ).toBeVisible();
    const retry = page.waitForRequest((r) => r.url().endsWith(`/tasks/${PD.busy}/retry`));
    await page.getByRole('button', { name: 'Retry' }).click();
    expect((await retry).postDataJSON()).toEqual({ acknowledgeUnknownOutcome: false });
    await expect(page.getByText('Attempt 2').first()).toBeVisible();
    await expect(page.getByText('Earlier attempts')).toBeVisible();
    // The provider rings, the callee answers: status and captions arrive live.
    const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    updateCall(api.state, PD.busy, PD.callBusyRetry, {
      status: 'in_progress',
      providerCallSid: 'CA00000000000000000000000000000042',
      answeredBy: 'human',
      aiDisclosedAt: at(0),
      answeredAt: at(0),
      timeline: [
        { status: 'queued', providerStatus: null, sequence: null, at: at(-12) },
        { status: 'dialing', providerStatus: 'queued', sequence: 1, at: at(-10) },
        { status: 'ringing', providerStatus: 'ringing', sequence: 2, at: at(-6) },
        { status: 'in_progress', providerStatus: 'in-progress', sequence: 3, at: at(-1) },
      ],
      turns: [
        {
          id: 'dd000007-0000-4000-8000-000000000000',
          sequence: 0,
          speaker: 'agent',
          kind: 'disclosure',
          text: 'Hello, this is JARVIS, an AI assistant calling on behalf of Layla Haddad.',
          language: 'en',
          confidence: null,
          flagged: false,
          at: at(0),
        },
      ],
    });
    stream.send({
      type: 'call.status_changed',
      taskId: PD.busy,
      data: {
        callId: PD.callBusyRetry,
        taskId: PD.busy,
        stepId: PD.busyStep,
        status: 'in_progress',
        result: null,
      },
    });
    await expect(page.getByText('Live')).toBeVisible();
    await expect(
      page.getByText('Hello, this is JARVIS, an AI assistant calling on behalf of Layla Haddad.'),
    ).toBeVisible();
    const d = api.state.taskDetails[PD.busy]!;
    const call = d.calls!.find((c) => c.id === PD.callBusyRetry)!;
    updateCall(api.state, PD.busy, PD.callBusyRetry, {
      turns: [
        ...call.turns,
        {
          id: 'dd000007-0000-4000-8000-000000000001',
          sequence: 1,
          speaker: 'callee',
          kind: 'answer',
          text: 'We have 10:15 free on Friday.',
          language: 'en',
          confidence: 0.93,
          flagged: false,
          at: at(8),
        },
      ],
    });
    stream.send({
      type: 'call.turn',
      taskId: PD.busy,
      data: { callId: PD.callBusyRetry, taskId: PD.busy, sequence: 1, speaker: 'callee' },
    });
    await expect(page.getByText('We have 10:15 free on Friday.')).toBeVisible();
    await expect(page.getByRole('log')).toBeVisible();
    await capture(page, testInfo, 'call--retry-live--light--en');
    // Completed with the collected time.
    updateCall(api.state, PD.busy, PD.callBusyRetry, {
      status: 'ended',
      result: 'completed',
      endedAt: at(40),
      durationSeconds: 40,
      outcome: {
        result: 'completed',
        goalReached: true,
        details: {
          date: '2026-11-06',
          times: ['10:15'],
          appointment: null,
          reply: null,
          answers: [],
        },
        notes: [],
        summaryMessage: { key: 'result.callCompleted', params: { who: 'my dentist' } },
      },
    });
    setTask(api.state, PD.busy, {
      status: 'COMPLETED',
      canCancel: false,
      resultSummary: 'Called my dentist; the call reached its goal.',
      resultSummaryMessage: { key: 'result.callCompleted', params: { who: 'my dentist' } },
    });
    stream.send({
      type: 'task.status_changed',
      taskId: PD.busy,
      data: { from: 'RUNNING', to: 'COMPLETED' },
    });
    await expect(
      page.getByText(loose('Called my dentist; the call reached its goal.')).first(),
    ).toBeVisible();
    await expect(page.getByText('10:15 AM')).toBeVisible();
    await expect(page.getByText('Live')).toHaveCount(0);
    expect(api.calls.filter((c) => c === 'retryTask')).toHaveLength(1);
    expect(api.errors).toEqual([]);
    await stream.close();
  });

  test('unknown outcome: Retry asks to acknowledge first, then sends acknowledgeUnknownOutcome', async ({
    page,
    context,
    baseURL,
  }) => {
    const now = Date.now();
    await openCalls(page, context, baseURL!, {
      path: `/tasks/${PD.unknown}`,
      options: { now, overrides: retryOverride(now) },
    });
    await expect(page.getByText('It’s unclear whether the call was placed')).toBeVisible();
    await expect(
      page.getByText('JARVIS doesn’t know yet whether this call took place.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox').check();
    const retry = page.waitForRequest((r) => r.url().endsWith(`/tasks/${PD.unknown}/retry`));
    await dialog.getByRole('button', { name: /Retry/ }).click();
    expect((await retry).postDataJSON()).toEqual({ acknowledgeUnknownOutcome: true });
  });

  test('do-not-call: the task links to the list; removing an entry says the callee asked', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openCalls(page, context, baseURL!, { path: `/tasks/${PD.denied}` });
    await expect(
      page
        .getByText(loose(`${NUMBER.masked} asked not to be called again, so JARVIS won’t call it.`))
        .first(),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Open the do-not-call list' }).click();
    await expect(page).toHaveURL(/\/settings#privacy$/);
    const card = page
      .locator('section', { has: page.getByRole('heading', { name: 'Numbers JARVIS won’t call' }) })
      .last();
    await expect(page.getByText(NUMBER.masked)).toBeVisible();
    await expect(page.getByText(/They asked during a call/)).toBeVisible();
    await region(page.locator('#privacy'), testInfo, 'settings--do-not-call--light--en');
    await page
      .getByRole('button', { name: loose(`Remove ${NUMBER.masked} from the list`) })
      .click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('The person asked not to be called again.');
    const del = page.waitForRequest(
      (r) => r.url().endsWith(`/do-not-call/${PD.dnc1}`) && r.method() === 'DELETE',
    );
    await confirm.getByRole('button', { name: 'Remove from the list' }).click();
    await del;
    await expect(page.getByText(NUMBER.masked)).toHaveCount(0);
    expect(card).toBeTruthy();
    expect(api.errors).toEqual([]);
  });

  test('Task Center › Calls opens each call’s task', async ({ page, context, baseURL }) => {
    await openCalls(page, context, baseURL!, { path: '/tasks/calls' });
    const list = page.getByRole('list', { name: 'Calls' });
    await expect(list.getByRole('listitem')).toHaveCount(6);
    await list.getByRole('link').filter({ hasText: 'the bakery' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${PD.live}$`));
  });
});

/* ------------------------------------------------------------------ settings */

test.describe('settings — voice and phone', () => {
  for (const { theme, locale, name } of variants(false)) {
    test(`Settings › Voice, Profile phone, Privacy do-not-call — ${name}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await openCalls(page, context, baseURL!, {
        locale,
        theme,
        path: '/settings#voice',
        phaseD: { phone: 'unverified' },
      });
      const voice = page.locator('#voice');
      await expect(
        voice.getByRole('heading', { level: 3, name: catalogs[locale].settings.voice.voices }),
      ).toBeVisible();
      await region(voice, testInfo, `settings--voice--${name}`);
      await expectNoSeriousA11yViolations(page);
      await region(page.locator('#profile'), testInfo, `settings--phone--${name}`);
      await region(page.locator('#privacy'), testInfo, `settings--privacy--${name}`);
      expect(api.errors).toEqual([]);
    });
  }

  test('voice preferences save: conversation mode, rate, pause, voice per language, preview', async ({
    page,
    context,
    baseURL,
  }) => {
    const hydration: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /hydrat/i.test(m.text())) hydration.push(m.text());
    });
    await open(page, context, baseURL!, { path: '/settings#voice', conversation: false });
    // The device's voices appear after hydration (the server knows none): no mismatch.
    await expect(page.getByRole('heading', { name: 'Voices' })).toBeVisible();
    expect(hydration).toEqual([]);
    const patch = () =>
      page.waitForRequest((r) => r.url().endsWith('/api/v1/me') && r.method() === 'PATCH');
    let request = patch();
    await page.getByRole('switch', { name: 'Talk in conversations' }).click();
    expect((await request).postDataJSON()).toEqual({
      preferences: { voice: { conversationMode: true } },
    });
    // Keyboard on the slider: one PATCH once it settles.
    const rate = page.getByRole('slider', { name: 'Speaking rate' });
    await expect(rate).toHaveAttribute('aria-valuetext', '1.0×');
    request = patch();
    await rate.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect((await request).postDataJSON()).toEqual({
      preferences: { voice: { speakingRate: 1.2 } },
    });
    await expect(rate).toHaveAttribute('aria-valuetext', '1.2×');
    const pause = page.getByRole('slider', { name: 'Pause before sending' });
    request = patch();
    await pause.focus();
    await page.keyboard.press('End');
    expect((await request).postDataJSON()).toEqual({
      preferences: { voice: { endOfSpeechSilenceMs: 4000 } },
    });
    await expect(pause).toHaveAttribute('aria-valuetext', '4.0 s');
    // A voice per language, from this device's voices (online ones marked).
    const german = page.getByRole('combobox', { name: loose('Deutsch voice') });
    await expect(german.locator('option')).toHaveText([
      'Device default',
      'Anna',
      loose('Google Deutsch (online)'),
    ]);
    request = patch();
    await german.selectOption('mock-de-anna');
    expect((await request).postDataJSON()).toEqual({
      preferences: { voice: { voiceNames: { de: 'mock-de-anna' } } },
    });
    await page.getByRole('button', { name: loose('Preview the Deutsch voice') }).click();
    const s = speech(page);
    await expect
      .poll(async () => (await s.spoken()).at(-1))
      .toMatchObject({
        text: 'Hallo, ich bin JARVIS. So klinge ich.',
        lang: 'de-DE',
        voice: 'mock-de-anna',
        rate: 1.2,
      });
    await expect(page.getByText('Voices marked “online”', { exact: false })).toBeVisible();
  });

  test('phone number: validated, saved as E.164, verified by a call with a code', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const api = await openCalls(page, context, baseURL!, {
      path: '/settings#profile',
      phaseD: { phone: 'none' },
    });
    const field = page.getByRole('textbox', { name: 'Phone number' });
    await field.fill('030 123');
    await field.press('Tab');
    await expect(
      page.getByText('Write the number with its country code, for example +49 30 1234567.'),
    ).toBeVisible();
    const patch = page.waitForRequest(
      (r) => r.url().endsWith('/api/v1/me') && r.method() === 'PATCH',
    );
    await field.fill('0049 (170) 123-4589');
    await field.press('Enter');
    expect((await patch).postDataJSON()).toEqual({ phoneNumber: '+491701234589' });
    await expect(page.getByText('Not verified')).toBeVisible();
    await page.getByRole('button', { name: 'Verify by phone call' }).click();
    await expect(
      page.getByText(/JARVIS is calling .*\+49 170 ••• •• 89.* and will read out a 6-digit code\./),
    ).toBeVisible();
    const code = page.getByRole('textbox', { name: 'Code from the call' });
    await code.fill('111111');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText(/That code isn’t right\. 4 tries left\./)).toBeVisible();
    await region(page.locator('#profile'), testInfo, 'settings--phone-code--light--en');
    await code.fill(MOCK_VERIFICATION_CODE);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText(/^Verified /)).toBeVisible();
    await expect(page.getByText('Your phone number is verified.')).toBeVisible();
    expect(api.state.me.phoneNumberVerifiedAt).not.toBeNull();
    expect(api.errors).toEqual([]);
  });
});
