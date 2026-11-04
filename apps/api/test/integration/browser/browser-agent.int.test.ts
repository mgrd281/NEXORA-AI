/**
 * The isolated browser agent end to end — real Postgres (RLS), real headless
 * Chromium through the browser worker's job loop, the real fixture site:
 * structured extraction with screenshot evidence, SSRF blocking (redirects and
 * subresources to private addresses), CAPTCHA / login / bot walls handed over
 * and never bypassed, unsupported sites, budgets, the browser_sessions
 * lifecycle and its recovery rules, per-user concurrency.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processBrowserJob, reclaimBrowserOnce } from '../../../src/browser-worker';
import { withContext, type DbContext } from '../../../src/db/pool';
import { runBrowserSession } from '../../../src/modules/browser/client';
import type { ToolRuntime } from '../../../src/modules/agent/tools/types';
import { AgentError } from '../../../src/modules/agent/errors';
import { connectWeb, detail, drain, newUser } from '../agent/harness';
import { artifactsOf, createBrowserHarness, sessionsOf, type BrowserHarness } from './harness';

let h: BrowserHarness;
let canary: Server;
let canaryHits = 0;
let canaryPort = 0;

beforeAll(async () => {
  h = await createBrowserHarness();
  // A "private service" on another loopback address: nothing may ever reach it.
  canary = createServer((_req, res) => {
    canaryHits += 1;
    res.end('secret');
  });
  await new Promise<void>((r) => canary.listen(0, '127.0.0.2', () => r()));
  canaryPort = (canary.address() as { port: number }).port;
}, 60_000);
afterAll(async () => {
  await new Promise<void>((r) => canary.close(() => r()));
  await h.close();
});

/** A user with a finished task and step to attach browser sessions to, and a runtime for them. */
async function runtime(): Promise<{ user: DbContext; rt: ToolRuntime }> {
  const user = await newUser(h.db);
  await connectWeb(h.db, user);
  const s = await h.services.tasks.create(
    user,
    { request: 'remember that the browser works', source: 'text' },
    {},
  );
  await drain(h.worker);
  const d = await detail(h.db, user, s.id);
  const step = d.steps[0]!;
  const rt = {
    config: h.config,
    db: h.db,
    ctx: user,
    taskId: s.id,
    stepId: step.id,
    idempotencyKey: `${step.id}:a${randomUUID().slice(0, 6)}`,
    storage: h.evidence,
    language: 'en',
  } as unknown as ToolRuntime;
  return { user, rt };
}

const read = (rt: ToolRuntime, url: string, siteId = 'schema-org') =>
  runBrowserSession(
    { ...rt, idempotencyKey: `${rt.stepId}:${randomUUID().slice(0, 8)}` },
    { siteId, operation: 'read', input: { url } },
    AbortSignal.timeout(120_000),
  );

describe('browse and extract (supported sites only)', () => {
  it('reads a product page: schema.org data, readable text, screenshot + extract stored as evidence', async () => {
    const { user, rt } = await runtime();
    const o = await read(rt, `${h.fixture.origin}/shop/products/FX-100`);
    expect(o.status).toBe('succeeded');
    const result = o.result as {
      title: string;
      text: string;
      data: {
        products: {
          name: string;
          price: { amountMicro: number; currency: string };
          shipping: unknown;
        }[];
      };
      screenshotArtifactId: string;
    };
    expect(result.title).toContain('FX-100 Wireless Headphones');
    expect(result.data.products[0]).toMatchObject({
      name: 'FX-100 Wireless Headphones',
      price: { amountMicro: 79_000_000, currency: 'USD' },
      shipping: { amountMicro: 4_990_000, currency: 'USD' },
      deliveryMinDays: 2,
      deliveryMaxDays: 4,
      inStock: true,
      rating: { value: 4.5, count: 812 },
    });
    // Evidence: a PNG screenshot and the JSON extract, under the owner's prefix, hash-checked.
    expect(o.artifacts.map((a) => a.kind).sort()).toEqual(['extract', 'screenshot']);
    for (const a of o.artifacts) {
      expect(a.storage_key).toBe(`tenants/${user.tenantId}/users/${user.userId}/evidence/${a.id}`);
      const stored = h.evidence.objects.get(a.storage_key)!;
      expect(stored.sha256).toBe(a.sha256);
      expect(stored.body.length).toBe(a.size_bytes);
    }
    const png = h.evidence.objects.get(
      o.artifacts.find((a) => a.kind === 'screenshot')!.storage_key,
    )!;
    expect(png.body.subarray(1, 4).toString()).toBe('PNG');
    expect(png.contentType).toBe('image/png');
    // Lifecycle row: queued → running → succeeded, counted, ephemeral, ended.
    const [session] = await sessionsOf(h, user, rt.taskId);
    expect(session).toMatchObject({
      status: 'succeeded',
      site_id: 'schema-org',
      operation: 'read',
      isolation_profile: 'ephemeral',
      stop_reason: null,
      handover_url: null,
      navigations: 1,
      blocked_requests: 0,
    });
    expect(session!.started_at).not.toBeNull();
    expect(session!.ended_at).not.toBeNull();
    expect(session!.requests).toBeGreaterThanOrEqual(1);
    const events = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_events')
        .select(['type', 'data'])
        .where('task_id', '=', rt.taskId)
        .where('type', '=', 'browser_session.changed')
        .orderBy('id')
        .execute(),
    );
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
  });

  it('an unsupported site is refused before any browser starts (SITE_UNSUPPORTED)', async () => {
    const { user, rt } = await runtime();
    await expect(
      runBrowserSession(
        rt,
        { siteId: 'example-shop', operation: 'read', input: { url: 'https://example.org/' } },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ reason: 'SITE_UNSUPPORTED' });
    // A URL outside the recipe's origins is refused by the worker too (defence in depth).
    const o = await read(rt, 'https://example.org/');
    expect(o).toMatchObject({
      status: 'failed',
      stopReason: 'SITE_UNSUPPORTED',
      stopParams: { host: 'example.org' },
    });
    const sessions = await sessionsOf(h, user, rt.taskId);
    expect(sessions.map((s) => [s.status, s.stop_reason, s.navigations])).toEqual([
      ['failed', 'SITE_UNSUPPORTED', 0],
    ]);
  });

  it('a recipe not enabled here (BROWSER_SITES) is unsupported', async () => {
    const { rt } = await runtime();
    const narrowed = {
      ...rt,
      config: { ...h.config, browserSites: new Set(['fixture-booking']) },
    } as ToolRuntime;
    await expect(
      runBrowserSession(
        narrowed,
        { siteId: 'fixture-shop', operation: 'search', input: { query: 'FX-100' } },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

describe('SSRF: the browser only ever talks to the supported site', () => {
  it('a redirect to a link-local / private address is blocked (NAVIGATION_BLOCKED)', async () => {
    const { rt } = await runtime();
    const o = await read(rt, `${h.fixture.origin}/ssrf/redirect-private`);
    expect(o).toMatchObject({
      status: 'failed',
      stopReason: 'NAVIGATION_BLOCKED',
      stopParams: { host: '169.254.169.254' },
    });
  });

  it('a redirect to another private service (other loopback address or port) never reaches it', async () => {
    const { rt } = await runtime();
    const before = canaryHits;
    const toOtherAddress = await read(
      rt,
      `${h.fixture.origin}/ssrf/redirect?to=${encodeURIComponent(`http://127.0.0.2:${canaryPort}/x`)}`,
    );
    expect(toOtherAddress).toMatchObject({ status: 'failed', stopReason: 'NAVIGATION_BLOCKED' });
    expect(canaryHits).toBe(before);
  });

  it('subresources from private addresses are blocked and counted; the page itself is read', async () => {
    const { user, rt } = await runtime();
    const before = canaryHits;
    const o = await read(rt, `${h.fixture.origin}/ssrf/subresources`);
    expect(o.status).toBe('succeeded');
    const [session] = await sessionsOf(h, user, rt.taskId);
    // 169.254.169.254, 10.0.0.1, 127.0.0.2:5432, 192.168.1.1, localhost:5432
    expect(session!.blocked_requests).toBeGreaterThanOrEqual(5);
    expect(canaryHits).toBe(before);
  });
});

describe('hand-over: CAPTCHAs, login walls and bot protection are never worked around', () => {
  it('a CAPTCHA stops the session: CAPTCHA_DETECTED, handover URL, screenshot, nothing submitted', async () => {
    const { user, rt } = await runtime();
    const o = await read(rt, `${h.fixture.origin}/captcha`);
    expect(o).toMatchObject({
      status: 'handover',
      stopReason: 'CAPTCHA_DETECTED',
      handoverUrl: `${h.fixture.origin}/captcha`,
      stopParams: { host: `127.0.0.1:${h.fixture.port}` },
    });
    expect(o.artifacts.map((a) => a.kind)).toEqual(['screenshot']);
    const [session] = await sessionsOf(h, user, rt.taskId);
    // One page load and nothing else: no click, no form submission, no further navigation.
    expect(session).toMatchObject({
      status: 'handover',
      navigations: 1,
      handover_url: `${h.fixture.origin}/captcha`,
    });
  });

  it('a challenge interstitial (403) is a CAPTCHA; a bot wall is BOT_PROTECTION; a sign-in form is LOGIN_REQUIRED', async () => {
    const { rt } = await runtime();
    expect(await read(rt, `${h.fixture.origin}/challenge`)).toMatchObject({
      status: 'handover',
      stopReason: 'CAPTCHA_DETECTED',
    });
    expect(await read(rt, `${h.fixture.origin}/blocked`)).toMatchObject({
      status: 'handover',
      stopReason: 'BOT_PROTECTION',
    });
    expect(await read(rt, `${h.fixture.origin}/login-wall`)).toMatchObject({
      status: 'handover',
      stopReason: 'LOGIN_REQUIRED',
    });
  });

  it('through the agent: a shop showing a CAPTCHA fails the search with a hand-off message', async () => {
    const user = await newUser(h.db);
    await connectWeb(h.db, user);
    await h.fixture.admin('/shop/admin/mode?captcha=true');
    await h.fixture.admin('/outlet/admin/mode?captcha=true');
    try {
      const s = await h.services.tasks.create(
        user,
        { request: 'Compare prices for FX-100 headphones', source: 'text' },
        {},
      );
      await drain(h.worker);
      const d = await detail(h.db, user, s.id);
      expect(d.status).toBe('FAILED');
      expect(d.error).toMatchObject({
        code: 'TOOL_FAILED',
        reason: 'CAPTCHA_DETECTED',
        retryable: true,
      });
      expect(d.error!.params).toMatchObject({ host: `127.0.0.1:${h.fixture.port}` });
      const sessions = await sessionsOf(h, user, s.id);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(
        sessions.every((x) => x.status === 'handover' && x.stop_reason === 'CAPTCHA_DETECTED'),
      ).toBe(true);
    } finally {
      await h.fixture.admin('/shop/admin/mode?captcha=false');
      await h.fixture.admin('/outlet/admin/mode?captcha=false');
    }
  });
});

describe('budgets', () => {
  it('more requests than allowed stop the session (BROWSER_BUDGET_EXCEEDED)', async () => {
    const { rt } = await runtime();
    const o = await read(rt, `${h.fixture.origin}/budget/requests`);
    expect(o).toMatchObject({
      status: 'failed',
      stopReason: 'BROWSER_BUDGET_EXCEEDED',
      stopParams: { limit: 400 },
    });
  });

  it('more navigations than allowed (redirect hops included) stop the session', async () => {
    const { rt } = await runtime();
    h.browser.budgets = { maxNavigations: 1 };
    try {
      const o = await read(
        rt,
        `${h.fixture.origin}/ssrf/redirect?to=${encodeURIComponent('/shop')}`,
      );
      expect(o).toMatchObject({
        status: 'failed',
        stopReason: 'BROWSER_BUDGET_EXCEEDED',
        stopParams: { limit: 1 },
      });
    } finally {
      h.browser.budgets = undefined;
    }
  });

  it('a session over its time budget stops with BROWSER_TIMEOUT', async () => {
    const { rt } = await runtime();
    h.browser.budgets = { sessionTimeoutMs: 2_000 };
    try {
      const o = await read(rt, `${h.fixture.origin}/slow`);
      expect(o).toMatchObject({ status: 'failed', stopReason: 'BROWSER_TIMEOUT' });
    } finally {
      h.browser.budgets = undefined;
    }
  });
});

describe('lifecycle and recovery', () => {
  it('a replayed job does nothing; a reclaimed binding session is interrupted, never run again', async () => {
    const { user, rt } = await runtime();
    const o = await read(rt, `${h.fixture.origin}/shop`);
    expect(o.status).toBe('succeeded');
    // Replay the (completed) job: the session already ended, nothing changes.
    const job = await h.db
      .selectFrom('jobs')
      .selectAll()
      .where('kind', '=', 'browser.session')
      .where('task_id', '=', rt.taskId)
      .executeTakeFirstOrThrow();
    const [before] = await sessionsOf(h, user, rt.taskId);
    await processBrowserJob(h.browser, {
      ...job,
      status: 'running',
      locked_by: h.browser.workerId,
    });
    const [again] = await sessionsOf(h, user, rt.taskId);
    expect(again).toEqual(before);

    // A binding session left 'running' by a worker that died: interrupted, not re-run.
    h.pauseBrowser(true);
    try {
      const sessionId = randomUUID();
      await withContext(h.db, user, async (trx) => {
        await trx
          .insertInto('browser_sessions')
          .values({
            id: sessionId,
            tenant_id: user.tenantId,
            user_id: user.userId,
            task_id: rt.taskId,
            step_id: rt.stepId,
            status: 'running',
            started_at: new Date(),
            site_id: 'fixture-booking',
            operation: 'fill',
            idempotency_key: `crashed:${sessionId}`,
            request: JSON.stringify({
              form: 'contact',
              fields: { Name: 'A', Email: 'a@b.test', Message: 'hi' },
              idempotencyKey: `form:${sessionId}`,
            }),
          })
          .execute();
        await trx
          .insertInto('jobs')
          .values({
            kind: 'browser.session',
            tenant_id: user.tenantId,
            user_id: user.userId,
            task_id: rt.taskId,
            payload: JSON.stringify({ sessionId }),
            status: 'running',
            locked_by: 'browser:dead-worker',
            locked_until: new Date(Date.now() - 1_000),
            attempts: 1,
            max_attempts: 2,
            dedupe_key: `browser:${sessionId}`,
          })
          .execute();
      });
      expect(await reclaimBrowserOnce(h.browser)).toBeGreaterThanOrEqual(1);
      const reclaimed = await h.db
        .selectFrom('jobs')
        .selectAll()
        .where('dedupe_key', '=', `browser:${sessionId}`)
        .executeTakeFirstOrThrow();
      await processBrowserJob(h.browser, {
        ...reclaimed,
        status: 'running',
        locked_by: h.browser.workerId,
        attempts: 2,
      });
      const row = await withContext(h.db, user, (trx) =>
        trx
          .selectFrom('browser_sessions')
          .selectAll()
          .where('id', '=', sessionId)
          .executeTakeFirstOrThrow(),
      );
      expect(row).toMatchObject({ status: 'interrupted', navigations: 0 });
      const contacts = (await h.fixture.admin('/booking/admin/reservations', 'GET')) as {
        contacts: unknown[];
      };
      expect(contacts.contacts).toEqual([]); // the form was never sent
    } finally {
      h.pauseBrowser(false);
    }
  });

  it('per user at most two sessions run at once; a third waits (and gives up when its step is aborted)', async () => {
    const { user, rt } = await runtime();
    h.pauseBrowser(true);
    try {
      const ac = new AbortController();
      const runs = [0, 1, 2].map((i) =>
        runBrowserSession(
          { ...rt, idempotencyKey: `${rt.stepId}:c${i}` },
          { siteId: 'schema-org', operation: 'read', input: { url: `${h.fixture.origin}/shop` } },
          ac.signal,
        ).catch((e: unknown) => e),
      );
      await new Promise((r) => setTimeout(r, 1_500));
      const queued = await sessionsOf(h, user, rt.taskId);
      expect(queued.map((s) => s.status)).toEqual(['queued', 'queued']);
      ac.abort(new Error('step timed out'));
      await Promise.all(runs);
      const after = await sessionsOf(h, user, rt.taskId);
      expect(after).toHaveLength(2);
      expect(after.every((s) => s.cancel_requested_at !== null)).toBe(true);
    } finally {
      h.pauseBrowser(false);
    }
    // The browser worker then ends the cancelled sessions without running them.
    await new Promise((r) => setTimeout(r, 1_000));
    const ended = await sessionsOf(h, user, rt.taskId);
    expect(ended.map((s) => [s.status, s.stop_reason])).toEqual([
      ['interrupted', 'CANCELLED'],
      ['interrupted', 'CANCELLED'],
    ]);
    expect((await artifactsOf(h, user, rt.taskId)).length).toBe(0);
  });
});
