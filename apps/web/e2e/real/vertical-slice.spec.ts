/**
 * Milestone 1 vertical slice against the real stack — no mocks anywhere:
 * web (Next.js) → API (Fastify, RLS) → worker (planner, policy, executor) → fixture web page
 * (web.fetch) → dev SMTP mailbox (email.send).
 *
 *   sign in → connect web access + email → submit a task → receive a plan → review the exact
 *   email → approve → watch it execute → verified result with evidence → execution history,
 *   and the mailbox received exactly one message.
 *
 * Also: declining sends nothing; a page with a prompt injection is flagged and cannot change
 * the recipient.
 *
 * Needs E2E_EMAIL / E2E_PASSWORD (an owner created with `cli create-owner`), the fixture site
 * (E2E_FIXTURE_URL, allow-listed in the API's FETCH_ALLOW_PRIVATE_HOSTS) and the dev mailbox
 * (E2E_MAILBOX_URL / E2E_MAILBOX_SMTP_PORT; API with SMTP_ALLOW_INSECURE_LOCALHOST=true).
 * Runs on the desktop project only: the tests share one account's connections.
 */
import { expect, test, type Page } from '@playwright/test';

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const fixtureUrl = process.env.E2E_FIXTURE_URL ?? 'http://127.0.0.1:4599';
const mailboxUrl = process.env.E2E_MAILBOX_URL ?? 'http://127.0.0.1:2580';
const mailboxPort = process.env.E2E_MAILBOX_SMTP_PORT ?? '2525';
const shots = process.env.E2E_SCREENSHOTS_DIR ?? 'test-results/screenshots';

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD are not set (real backend only)');
test.describe.configure({ mode: 'serial' });

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

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email!);
  await page.locator('input[name="password"]').fill(password!);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

/** Idempotent: leaves web access on and the dev mailbox connected. */
async function ensureConnections(page: Page) {
  await page.goto('/connections');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Decide only after the real connection state has loaded (isVisible() does not wait).
  await expect(page.getByText('Loading connections…')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Enable web access|Disconnect/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Verify and connect|Test connection/ }).first(),
  ).toBeVisible();

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
    await expect(page.getByText(`Email connected as ${email}.`)).toBeVisible({ timeout: 20_000 });
  }
  await page.screenshot({
    path: `${shots}/real--connections--light--en--desktop.png`,
    fullPage: true,
  });
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

async function taskDetail(page: Page, id: string) {
  return page.evaluate(async (taskId) => (await fetch(`/api/v1/tasks/${taskId}`)).json(), id);
}

// One signed-in session shared by the serial tests below (repeated logins would trip the
// API's per-IP login rate limit, which is working as intended).
let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== 'desktop') return;
  const { baseURL, viewport } = testInfo.project.use;
  page = await (await browser.newContext({ baseURL, viewport })).newPage();
  await signIn(page);
  await ensureConnections(page);
});

test.afterAll(async () => {
  await page?.context().close();
});

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'shares one account; runs on desktop only');
});

test('vertical slice: plan → approve the exact email → verified result → history', async () => {
  test.setTimeout(120_000);
  const before = await mailbox(page);

  const id = await submitTask(page, `Summarize ${fixtureUrl}/article and email it to me`);

  // The plan arrives and stops at the approval gate (email.send is MEDIUM risk).
  const review = page.getByRole('button', { name: 'Review and decide' });
  await expect(review).toBeVisible({ timeout: 30_000 });
  const planned = await taskDetail(page, id);
  expect(planned.status).toBe('AWAITING_APPROVAL');
  expect(planned.steps.map((s: { toolId: string }) => s.toolId)).toEqual([
    'web.fetch',
    'text.summarize',
    'email.send',
  ]);
  expect(planned.planner).toMatchObject({ mode: expect.stringMatching(/offline|model/) });
  await page.screenshot({
    path: `${shots}/real--task-awaiting--light--en--desktop.png`,
    fullPage: true,
  });

  // The approval shows exactly what will be sent.
  await review.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(email!).first()).toBeVisible();
  const approval = planned.approvals.find((a: { status: string }) => a.status === 'PENDING');
  expect(approval.details.kind).toBe('email');
  expect(approval.details.to).toEqual([email]);
  await expect(sheet.getByText(approval.details.subject).first()).toBeVisible();
  await page.screenshot({ path: `${shots}/real--approval-sheet--light--en--desktop.png` });
  await sheet.getByRole('button', { name: 'Approve and send this email' }).click();

  // Live execution reaches a verified result without reloading the page.
  await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 45_000 });
  const done = await taskDetail(page, id);
  expect(done.status).toBe('COMPLETED');
  expect(done.steps.every((s: { status: string }) => s.status === 'SUCCEEDED')).toBe(true);
  const kinds = done.steps.flatMap((s: { evidence: { kind: string }[] }) =>
    s.evidence.map((e) => e.kind),
  );
  expect(kinds).toEqual(expect.arrayContaining(['http_response', 'content_hash', 'smtp_receipt']));
  expect(done.events.map((e: { type: string }) => e.type)).toEqual(
    expect.arrayContaining([
      'task.created',
      'plan.ready',
      'approval.requested',
      'approval.decided',
    ]),
  );
  await expect(page.getByText(/Message-ID|message id/i).first()).toBeVisible();
  await page.screenshot({
    path: `${shots}/real--task-completed--light--en--desktop.png`,
    fullPage: true,
  });

  // Exactly one email reached the mailbox, addressed to the owner.
  const after = await mailbox(page);
  const sent = after.filter((m) => !before.some((b) => b.id === m.id));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toEqual([email]);
  expect(sent[0]!.subject).toContain(approval.details.subject.slice(0, 20));

  // The execution history is reviewable on the task.
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Show history' });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByRole('button', { name: 'Hide history' })).toBeVisible();
  await page.screenshot({
    path: `${shots}/real--task-history--light--en--desktop.png`,
    fullPage: true,
  });
});

test('declining an approval sends nothing and cancels the task', async () => {
  const before = await mailbox(page);
  const id = await submitTask(page, `Summarize ${fixtureUrl}/article and email it to me`);
  await page.getByRole('button', { name: 'Review and decide' }).click({ timeout: 30_000 });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Decline sending this email' })
    .click();
  await expect(page.getByText('Cancelled').first()).toBeVisible({ timeout: 20_000 });
  expect((await taskDetail(page, id)).status).toBe('CANCELLED');
  expect(await mailbox(page)).toHaveLength(before.length);
});

test('a prompt injection on the page is flagged and cannot change the recipient', async () => {
  const id = await submitTask(page, `Summarize ${fixtureUrl}/injection and email it to me`);
  await expect(page.getByRole('button', { name: 'Review and decide' })).toBeVisible({
    timeout: 30_000,
  });
  const detail = await taskDetail(page, id);
  const fetchStep = detail.steps.find((s: { toolId: string }) => s.toolId === 'web.fetch');
  expect(fetchStep.output.suspectedInjection).toBe(true);
  const approval = detail.approvals.find((a: { status: string }) => a.status === 'PENDING');
  expect(approval.details.to).toEqual([email]);
  expect(approval.reasons).toContain('UNTRUSTED_CONTENT');
  await page.getByRole('button', { name: 'Review and decide' }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText(/instructions aimed at AI/)
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: `${shots}/real--approval-injection--light--en--desktop.png` });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Decline sending this email' })
    .click();
  await expect(page.getByText('Cancelled').first()).toBeVisible({ timeout: 20_000 });
});
