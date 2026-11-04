/**
 * Phase B against the real stack — no mocks anywhere: web (Next.js) → API (Fastify, RLS,
 * local object storage) → worker (offline planner, policy, executor, scheduler, webhook
 * delivery) → fixture web page, dev SMTP mailbox and a webhook receiver started by this file.
 *
 *   1. follow-up: a summary, then "email it to me" in the same conversation → exactly one email
 *   2. clarifying question: "email me" asks what to say; the answer sends exactly that
 *   3. attachments: upload a PDF, ask for a summary, the owner downloads the same bytes
 *   4. schedules: a schedule for the next minute fires exactly once (source "schedule")
 *   5. webhooks: a local endpoint receives a correctly signed, metadata-only task.completed
 *   6. skills: a disabled skill refuses the request with the localized reason (en, de, ar)
 *   7. retention: the preference is saved, survives a reload and is shown on Memory
 *
 * Needs the same environment as vertical-slice.spec.ts plus, on the API and worker:
 * WEBHOOK_ALLOW_INSECURE_HOSTS=127.0.0.1:<E2E_WEBHOOK_PORT> (default 4610), a storage driver
 * (STORAGE_DRIVER=local outside production) and, for a quick schedule test, a short
 * SCHEDULER_TICK_MS (the default 15 s also works within the timeout).
 * Runs on the desktop project only: the tests share one account.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const fixtureUrl = process.env.E2E_FIXTURE_URL ?? 'http://127.0.0.1:4599';
const mailboxUrl = process.env.E2E_MAILBOX_URL ?? 'http://127.0.0.1:2580';
const mailboxPort = process.env.E2E_MAILBOX_SMTP_PORT ?? '2525';
const webhookPort = Number(process.env.E2E_WEBHOOK_PORT ?? 4610);
const shots = process.env.E2E_SCREENSHOTS_DIR ?? 'test-results/screenshots';

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD are not set (real backend only)');
test.describe.configure({ mode: 'serial' });

/* ------------------------------------------------------------------ helpers */

interface MailboxMessage {
  id: number;
  to: string[];
  subject: string;
}

async function mailbox(page: Page): Promise<MailboxMessage[]> {
  const res = await page.request.get(`${mailboxUrl}/messages`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as MailboxMessage[];
}

async function rawMessage(page: Page, id: number): Promise<string> {
  const res = await page.request.get(`${mailboxUrl}/messages/${id}`);
  return ((await res.json()) as { raw: string }).raw;
}

/** New messages since `before`, waiting until at least `count` arrived (then a short settle). */
async function newMail(page: Page, before: MailboxMessage[], count = 1) {
  const fresh = async () => (await mailbox(page)).filter((m) => !before.some((b) => b.id === m.id));
  await expect
    .poll(async () => (await fresh()).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(count);
  await page.waitForTimeout(1_500); // a duplicate would arrive right behind the first
  return fresh();
}

/** JSON from the API through the web origin (session cookie, same-origin mutations). */
async function api<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotent?: boolean } = {},
): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body, idempotent }) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (idempotent) headers['idempotency-key'] = crypto.randomUUID();
      const res = await fetch(`/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    { method, path, body, idempotent: opts.idempotent ?? false },
  ) as Promise<{ status: number; json: T }>;
}

interface Detail {
  id: string;
  status: string;
  outcome?: string | null;
  conversationId?: string;
  scheduleId?: string | null;
  source: string;
  question?: { text: string; missing: string[] } | null;
  steps: { toolId: string; status: string; output: Record<string, unknown> | null }[];
  approvals: { status: string; details: { kind: string; to?: string[]; subject?: string } }[];
  attachments?: { id: string; filename: string; sizeBytes: number; mediaType: string }[];
  error: { code: string; reason?: string; params?: Record<string, unknown> } | null;
  resultSummary: string | null;
}

async function taskDetail(page: Page, id: string): Promise<Detail> {
  return (await api<Detail>(page, 'GET', `/v1/tasks/${id}`)).json;
}

async function waitForStatus(page: Page, id: string, statuses: string[], timeout = 45_000) {
  await expect
    .poll(async () => (await taskDetail(page, id)).status, { timeout })
    .toMatch(new RegExp(`^(${statuses.join('|')})$`));
  return taskDetail(page, id);
}

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email!);
  await page.locator('input[name="password"]').fill(password!);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

/** Idempotent: web access on, the dev mailbox connected, every skill this file uses on. */
async function ensureSetup(page: Page) {
  const conns = await api<{ items: { provider: string; status: string }[] }>(
    page,
    'GET',
    '/v1/connections',
  );
  const has = (p: string) =>
    conns.json.items?.some((c) => c.provider === p && c.status === 'active') ?? false;
  if (!has('web') || !has('smtp')) {
    await page.goto('/connections');
    await expect(page.getByText('Loading connections…')).toHaveCount(0);
    const enableWeb = page.getByRole('button', { name: 'Enable web access' });
    if (await enableWeb.isVisible()) {
      await enableWeb.click();
      await expect(page.getByText('Web access is on.')).toBeVisible();
    }
    const connect = page.getByRole('button', { name: 'Verify and connect' });
    if (await connect.isVisible()) {
      await page.getByLabel('Security').selectOption('none');
      await page.getByLabel('SMTP server').fill('127.0.0.1');
      await page.getByLabel('Port').fill(mailboxPort);
      await page.getByLabel('From address').fill(email!);
      await connect.click();
      await expect(page.getByText(/^Email connected as/)).toBeVisible({ timeout: 20_000 });
    }
  }
  for (const skill of ['web-research', 'email-management', 'document-analysis']) {
    await api(page, 'PATCH', `/v1/skills/${skill}`, { enabled: true });
  }
  await api(page, 'PATCH', '/v1/me', { locale: 'en' });
}

/** Submits from Home and returns the new task id (the composer navigates to the detail). */
async function submitTask(page: Page, request: string): Promise<string> {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: /Ask JARVIS/ });
  await composer.fill(request);
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  return page.url().split('/').pop()!;
}

/** Sends the follow-up / answer composer on the current task page; returns the new task id. */
async function sendFollowUp(page: Page, fieldName: RegExp | string, text: string) {
  const field = page.getByRole('textbox', { name: fieldName });
  await field.fill(text);
  const response = page.waitForResponse(
    (r) =>
      /\/api\/v1\/conversations\/[0-9a-f-]+\/messages$/.test(r.url()) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send follow-up' }).click();
  const res = await response;
  expect(res.status()).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

async function approveEmail(page: Page, taskId: string) {
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('button', { name: 'Review and decide' }).click({ timeout: 30_000 });
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Approve and send this email' }).click();
}

/** A one-page PDF 1.4 with a real Helvetica text layer and a correct xref table. */
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = [
    'BT',
    '/F1 12 Tf',
    '14 TL',
    '72 720 Td',
    ...lines.map((l) => `(${esc(l)}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Standard Webhooks v1 verification, written from the spec (not the server's code). */
function verifyStandardWebhook(secret: string, headers: IncomingHttpHeaders, body: string) {
  const id = String(headers['webhook-id'] ?? '');
  const timestamp = String(headers['webhook-timestamp'] ?? '');
  const signatures = String(headers['webhook-signature'] ?? '').split(' ');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  const valid = signatures.some((s) => {
    const [version, sig] = s.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  return { id, valid, fresh: Number.isFinite(age) && age < 300 };
}

/* ------------------------------------------------------------------ session */

// One signed-in session shared by the serial tests (repeated logins would trip the API's
// per-IP login rate limit, which is working as intended).
let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== 'desktop') return;
  const { baseURL, viewport } = testInfo.project.use;
  page = await (await browser.newContext({ baseURL, viewport })).newPage();
  await signIn(page);
  await ensureSetup(page);
});

test.afterAll(async () => {
  await page?.context().close();
});

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'shares one account; runs on desktop only');
});

/* ------------------------------------------------------------------ 1 */

test('follow-up: "email it to me" after a summary sends exactly one email of that summary', async () => {
  test.setTimeout(120_000);
  const first = await submitTask(page, `Summarize ${fixtureUrl}/article`);
  const summary = await waitForStatus(page, first, ['COMPLETED']);
  expect(summary.outcome).toBe('answer');
  expect(summary.steps.map((s) => s.toolId)).toEqual(['web.fetch', 'text.summarize']);

  await page.goto(`/tasks/${first}`);
  const before = await mailbox(page);
  const second = await sendFollowUp(page, 'Follow-up to JARVIS', 'email it to me');
  await expect(page.getByText('email it to me').first()).toBeVisible();

  const planned = await waitForStatus(page, second, ['AWAITING_APPROVAL']);
  expect(planned.conversationId).toBe(summary.conversationId);
  expect(planned.steps.map((s) => s.toolId)).toEqual(['conversation.recall', 'email.send']);
  const approval = planned.approvals.find((a) => a.status === 'PENDING')!;
  expect(approval.details).toMatchObject({ kind: 'email', to: [email] });
  await page.goto(`/tasks/${first}`);
  await expect(page.getByRole('heading', { name: 'Since then' })).toBeVisible();
  await page.screenshot({
    path: `${shots}/real-b--followup-thread--light--en--desktop.png`,
    fullPage: true,
  });

  await approveEmail(page, second);
  const done = await waitForStatus(page, second, ['COMPLETED']);
  expect(done.outcome).toBe('action');
  const sent = await newMail(page, before);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toEqual([email]);
  // The email carries the earlier summary (its first words), not something new.
  const recalled = String(done.steps[0]?.output?.excerpt ?? '');
  const raw = await rawMessage(page, sent[0]!.id);
  const firstWords = recalled.replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  expect(firstWords.length).toBeGreaterThan(5);
  expect(raw.replace(/=\r?\n/g, '').replace(/\s+/g, ' ')).toContain(firstWords);

  // The conversation history lists it with both requests.
  await page.goto('/tasks/conversations');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const conv = await api<{ turns: unknown[]; canFollowUp: boolean }>(
    page,
    'GET',
    `/v1/conversations/${summary.conversationId}`,
  );
  expect(conv.status).toBe(200);
  expect(conv.json.turns.length).toBeGreaterThanOrEqual(2);
  expect(conv.json.canFollowUp).toBe(true);
  await page.screenshot({
    path: `${shots}/real-b--conversations--light--en--desktop.png`,
    fullPage: true,
  });
});

/* ------------------------------------------------------------------ 2 */

test('clarifying question: "email me" asks what to say, and the answer is what gets sent', async () => {
  test.setTimeout(120_000);
  const asked = await submitTask(page, 'email me');
  const question = await waitForStatus(page, asked, ['COMPLETED']);
  expect(question.outcome).toBe('question');
  expect(question.question?.missing).toEqual(['email_content']);
  expect(question.steps.map((s) => s.toolId)).toEqual(['assistant.clarify']);

  await page.goto(`/tasks/${asked}`);
  await expect(page.getByRole('heading', { name: 'JARVIS has a question' })).toBeVisible();
  await expect(page.getByText('What should the email say?').first()).toBeVisible();
  await expect(page.getByText('Needs your answer').first()).toBeVisible();
  await page.screenshot({
    path: `${shots}/real-b--question--light--en--desktop.png`,
    fullPage: true,
  });

  const before = await mailbox(page);
  const answer = 'The dentist moved my appointment to Friday at 3 pm.';
  const reply = await sendFollowUp(page, 'Your answer', answer);
  const planned = await waitForStatus(page, reply, ['AWAITING_APPROVAL']);
  expect(planned.steps.map((s) => s.toolId)).toEqual(['email.send']);
  expect(planned.approvals.find((a) => a.status === 'PENDING')!.details.to).toEqual([email]);
  await approveEmail(page, reply);
  await waitForStatus(page, reply, ['COMPLETED']);
  const sent = await newMail(page, before);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toEqual([email]);
  expect((await rawMessage(page, sent[0]!.id)).replace(/=\r?\n/g, '')).toContain(
    'moved my appointment to Friday at 3 pm',
  );

  // The question is now shown as answered.
  await page.goto(`/tasks/${asked}`);
  await expect(page.getByText('Answered').first()).toBeVisible();
});

/* ------------------------------------------------------------------ 3 */

test('attachments: a PDF is uploaded, summarized from its text, and only its owner downloads it', async () => {
  test.setTimeout(120_000);
  const pdf = makePdf([
    'Quarterly report of the Riverside library.',
    'Visitor numbers grew by twelve percent in the third quarter.',
    'The reading room opens on Sundays from January.',
    'Four new staff members joined the children department.',
  ]);
  await page.goto('/');
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/attachments') && r.request().method() === 'POST',
  );
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'riverside-report.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  const upload = await uploaded;
  expect(upload.status()).toBe(201);
  expect(await upload.json()).toMatchObject({
    filename: 'riverside-report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: pdf.length,
  });
  await expect(page.getByText('riverside-report.pdf').first()).toBeVisible();
  await expect(page.getByText('Uploading…')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/real-b--composer-file--light--en--desktop.png` });
  await page.getByRole('textbox', { name: /Ask JARVIS/ }).fill('Summarize the attached document');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const id = page.url().split('/').pop()!;

  const done = await waitForStatus(page, id, ['COMPLETED']);
  expect(done.outcome).toBe('answer');
  expect(done.steps.map((s) => s.toolId)).toEqual(['document.analyze']);
  expect(done.attachments).toHaveLength(1);
  const file = done.attachments![0]!;
  expect(file).toMatchObject({ filename: 'riverside-report.pdf', mediaType: 'application/pdf' });
  const output = done.steps[0]!.output!;
  expect(String(output.text ?? output.result)).toMatch(/Visitor numbers grew by twelve percent/);
  await page.reload();
  await expect(page.getByText(/Visitor numbers grew by twelve percent/).first()).toBeVisible();
  await expect(page.getByText('riverside-report.pdf').first()).toBeVisible();
  await page.screenshot({
    path: `${shots}/real-b--document--light--en--desktop.png`,
    fullPage: true,
  });

  // The owner downloads exactly the uploaded bytes, as an attachment that never renders inline.
  const download = await page.request.get(`/api/v1/attachments/${file.id}/content`);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(download.headers()['x-content-type-options']).toBe('nosniff');
  expect(Buffer.compare(await download.body(), pdf)).toBe(0);
  // Without the session it is not reachable at all.
  const anonymous = await page.request.fetch(`/api/v1/attachments/${file.id}/content`, {
    headers: { cookie: '' },
  });
  expect([401, 404]).toContain(anonymous.status());
});

/* ------------------------------------------------------------------ 4 */

test('schedules: a schedule for the next minute fires exactly once', async () => {
  test.setTimeout(240_000);
  // At least 30 s ahead, so the occurrence is still in the future when the server computes it.
  const at = new Date(Math.floor((Date.now() + 90_000) / 60_000) * 60_000);
  const hhmm = at.toISOString().slice(11, 16);
  const title = `E2E schedule ${Date.now()}`;

  await page.goto('/tasks/scheduled');
  await page.getByRole('button', { name: 'New schedule' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(title);
  await dialog
    .getByLabel('What should JARVIS do each time?')
    .fill(`Summarize ${fixtureUrl}/article`);
  await dialog.getByLabel('Time zone').selectOption('UTC');
  await dialog.getByLabel('Time', { exact: true }).fill(hhmm);
  await expect(dialog.getByRole('heading', { name: 'Next runs' })).toBeVisible();
  await expect(dialog.locator('ol time').first()).toBeVisible();
  await page.screenshot({ path: `${shots}/real-b--schedule-editor--light--en--desktop.png` });
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByText('Schedule created.')).toBeVisible();

  const list = await api<{ items: { id: string; title: string; nextRunAt: string | null }[] }>(
    page,
    'GET',
    '/v1/schedules',
  );
  const schedule = list.json.items.find((s) => s.title === title)!;
  expect(schedule).toBeTruthy();
  expect(new Date(schedule.nextRunAt!).getTime()).toBe(at.getTime());

  try {
    interface Run {
      status: string;
      occurrenceAt: string;
      task: { id: string } | null;
    }
    const runs = async () =>
      (await api<{ runs: Run[] }>(page, 'GET', `/v1/schedules/${schedule.id}`)).json.runs;
    await expect
      .poll(async () => (await runs()).length, { timeout: 150_000, intervals: [2_000] })
      .toBe(1);
    // Several more scheduler ticks: still exactly one run and one task.
    await page.waitForTimeout(10_000);
    const [run] = await runs();
    expect(await runs()).toHaveLength(1);
    expect(run!.status).toBe('created');
    expect(new Date(run!.occurrenceAt).getTime()).toBe(at.getTime());
    const task = await waitForStatus(page, run!.task!.id, ['COMPLETED']);
    expect(task).toMatchObject({ source: 'schedule', scheduleId: schedule.id });
    const tasks = await api<{ items: { scheduleId?: string | null }[] }>(
      page,
      'GET',
      '/v1/tasks?limit=50',
    );
    expect(tasks.json.items.filter((t) => t.scheduleId === schedule.id)).toHaveLength(1);
    await page.goto('/tasks/scheduled');
    await expect(page.getByText(title).first()).toBeVisible();
    await page.screenshot({
      path: `${shots}/real-b--scheduled--light--en--desktop.png`,
      fullPage: true,
    });
  } finally {
    await api(page, 'DELETE', `/v1/schedules/${schedule.id}`);
  }
});

/* ------------------------------------------------------------------ 5 */

test('webhooks: a local endpoint receives a correctly signed, metadata-only task.completed', async () => {
  test.setTimeout(120_000);
  const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(webhookPort, '127.0.0.1', resolve));
  let endpointId: string | null = null;
  // A path of its own, so endpoints left by other runs (same host) never match.
  const hookUrl = `http://127.0.0.1:${webhookPort}/jarvis-e2e-${Date.now()}`;
  try {
    await page.goto('/connections');
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Endpoint URL').fill(hookUrl);
    await form.getByRole('button', { name: 'Clear' }).click();
    await form.getByLabel('Task completed').check();
    await form.getByRole('button', { name: 'Add endpoint' }).click();
    const secretDialog = page.getByRole('dialog', { name: 'Save your signing secret' });
    await expect(secretDialog).toBeVisible();
    const secret = (await secretDialog.locator('code').first().textContent())!.trim();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
    await page.screenshot({ path: `${shots}/real-b--webhook-secret--light--en--desktop.png` });
    await secretDialog.getByRole('button', { name: 'I’ve saved it' }).click();

    const endpoints = await api<{ items: { id: string; url: string }[] }>(
      page,
      'GET',
      '/v1/webhooks',
    );
    endpointId = endpoints.json.items.find((e) => e.url === hookUrl)!.id;

    const id = await submitTask(page, `Summarize ${fixtureUrl}/article`);
    await waitForStatus(page, id, ['COMPLETED']);
    await expect
      .poll(() => received.filter((r) => r.path === new URL(hookUrl).pathname).length, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1_500);

    // Only the subscribed event, once.
    const path = new URL(hookUrl).pathname;
    const events = received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, payload: JSON.parse(r.body) }));
    const completed = events.filter((e) => e.payload.data?.taskId === id);
    expect(completed).toHaveLength(1);
    const delivery = completed[0]!;
    expect(delivery.payload.type).toBe('task.completed');
    expect(delivery.headers['content-type']).toMatch(/^application\/json/);
    const check = verifyStandardWebhook(secret, delivery.headers, delivery.body);
    expect(check.valid).toBe(true);
    expect(check.fresh).toBe(true);
    expect(check.id).toMatch(/^msg_/);
    // A different secret does not verify.
    expect(
      verifyStandardWebhook(
        `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
        delivery.headers,
        delivery.body,
      ).valid,
    ).toBe(false);
    // Metadata only: no request text, titles, summaries, URLs or addresses anywhere in the body.
    expect(delivery.body).not.toContain('article');
    expect(delivery.body).not.toContain(fixtureUrl);
    expect(delivery.body).not.toContain(email!);
    expect(delivery.body).not.toMatch(/Riverside|Summarize 127/);
    expect(Object.keys(delivery.payload.data).sort()).toEqual([
      'completedAt',
      'conversationId',
      'createdAt',
      'error',
      'outcome',
      'riskLevel',
      'scheduleId',
      'source',
      'status',
      'taskId',
      'toolIds',
    ]);

    await page.goto('/connections');
    const card = page.locator('article').filter({ hasText: hookUrl });
    await card.getByRole('button', { name: /Delivery log/ }).click();
    await expect(card.getByText('HTTP 204').first()).toBeVisible();
    await page.screenshot({
      path: `${shots}/real-b--webhooks--light--en--desktop.png`,
      fullPage: true,
    });
  } finally {
    if (endpointId) await api(page, 'DELETE', `/v1/webhooks/${endpointId}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/* ------------------------------------------------------------------ 6 */

test('skills: with web research turned off the request is refused with the localized reason', async () => {
  test.setTimeout(120_000);
  await page.goto('/settings#skills');
  const toggle = page.getByRole('switch', { name: /Web research/ });
  await expect(toggle).toBeVisible();
  try {
    if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(
      page.getByText('Turned off. JARVIS won’t plan or run its actions.').first(),
    ).toBeVisible();
    await page.screenshot({
      path: `${shots}/real-b--skills-off--light--en--desktop.png`,
      fullPage: true,
    });

    const id = await submitTask(page, `Summarize ${fixtureUrl}/article`);
    const failed = await waitForStatus(page, id, ['FAILED']);
    expect(failed.error).toMatchObject({
      code: 'POLICY_DENIED',
      reason: 'SKILL_DISABLED',
      params: { skill: 'web-research' },
    });
    expect(failed.steps[0]).toMatchObject({ toolId: 'web.fetch', status: 'BLOCKED' });
    await page.reload();
    await expect(page.getByText(/turned off in Settings/).first()).toBeVisible();
    await page.screenshot({
      path: `${shots}/real-b--skill-denied--light--en--desktop.png`,
      fullPage: true,
    });

    // The same task in German and Arabic: the reason comes from the client catalogs.
    await api(page, 'PATCH', '/v1/me', { locale: 'de' });
    await page.reload();
    await expect(page.getByText(/in den Einstellungen ausgeschaltet/).first()).toBeVisible();
    await api(page, 'PATCH', '/v1/me', { locale: 'ar' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText(/متوقفة في الإعدادات/).first()).toBeVisible();
    await page.screenshot({
      path: `${shots}/real-b--skill-denied--light--ar--desktop.png`,
      fullPage: true,
    });
  } finally {
    await api(page, 'PATCH', '/v1/me', { locale: 'en' });
    const on = await api<{ enabled: boolean }>(page, 'PATCH', '/v1/skills/web-research', {
      enabled: true,
    });
    expect(on.json.enabled).toBe(true);
  }
});

/* ------------------------------------------------------------------ 7 */

test('retention: the preference is saved, survives a reload and is explained on Memory', async () => {
  try {
    await page.goto('/settings#privacy');
    const memories = page.getByLabel('Keep memories');
    const history = page.getByLabel('Keep task history');
    await memories.selectOption('30');
    await expect
      .poll(
        async () =>
          (await api<{ preferences: { retention: unknown } }>(page, 'GET', '/v1/me')).json
            .preferences.retention,
      )
      .toEqual({ memoryDays: 30, taskHistoryDays: null });
    await history.selectOption('365');
    await expect
      .poll(
        async () =>
          (await api<{ preferences: { retention: unknown } }>(page, 'GET', '/v1/me')).json
            .preferences.retention,
      )
      .toEqual({ memoryDays: 30, taskHistoryDays: 365 });

    await page.reload();
    await expect(page.getByLabel('Keep memories')).toHaveValue('30');
    await expect(page.getByLabel('Keep task history')).toHaveValue('365');
    await page.getByLabel('Keep memories').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/real-b--privacy-retention--light--en--desktop.png` });

    await page.goto('/memory');
    await expect(
      page
        .getByText(
          /Memories that haven’t changed for \u2068?30 days\u2069? are deleted automatically, once a day/,
        )
        .first(),
    ).toBeVisible();
  } finally {
    await api(page, 'PATCH', '/v1/me', {
      preferences: { retention: { memoryDays: null, taskHistoryDays: null } },
    });
  }
});
