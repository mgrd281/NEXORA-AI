/**
 * Phase C read models over HTTP (docs/architecture/phase-c.md §3.3, §3.8):
 * orders, bookings and evidence (owner-only, keyset pages, download headers),
 * email watches (list / stop), TaskDetail.browserSessions, Home "Upcoming"
 * and the calendar routes against the mock providers, the purchase-limit
 * preference, account export v4 (no token ever) and account deletion (the
 * Google grant is revoked at the provider).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CALENDAR_LIMITS,
  COMMERCE_LIMITS,
  routes,
  type RouteName,
  type Booking,
  type BrowserSession,
  type EmailWatch,
  type EvidenceArtifact,
  type HomeSnapshot,
  type Me,
  type Order,
  type TaskDetail,
  type UpcomingEvents,
} from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { assertAllRoutesRegistered } from '../../../src/http/route';
import { drainRevocations } from '../../../src/modules/integrations/revocation';
import { clearUpcomingCache } from '../../../src/modules/integrations/upcoming';
import { TEST_PASSWORD } from '../helpers';
import {
  addMailbox,
  connectOAuth,
  createOAuthHarness,
  seedBooking,
  seedBrowserSession,
  seedEvidence,
  seedOrder,
  seedStepTask,
  seedWatch,
  startOAuth,
  type OAuthHarness,
} from './phase-c-support';
import { createHarness, newClient, ownerQuery, type Client } from './support';

let h: OAuthHarness;
beforeAll(async () => {
  h = await createOAuthHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  clearUpcomingCache();
  h.google.clearFailures();
  h.microsoft.clearFailures();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake screenshot bytes'),
]);
const ICS = Buffer.from(
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Check-up\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
);
const errorOf = (res: { json: <T>() => T }) =>
  res.json<{ error: { code: string; details?: Record<string, unknown> } }>().error;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe('route table', () => {
  it('has a handler for every contract route, as a production boot requires', () => {
    expect(() => assertAllRoutesRegistered(h.app, { production: true })).not.toThrow();
    const phaseC: RouteName[] = [
      'listConnectionProviders',
      'startOAuthConnection',
      'completeOAuthConnection',
      'listUpcomingEvents',
      'listCalendarEvents',
      'listEmailWatches',
      'deleteEmailWatch',
      'listOrders',
      'getOrder',
      'listBookings',
      'getBooking',
      'getEvidence',
      'downloadEvidence',
    ];
    for (const name of phaseC) expect(routes[name], name).toBeDefined();
  });
});

describe('orders', () => {
  it('lists newest first with keyset pages and a status filter, each with its evidence', async () => {
    const c = await newClient(h);
    const t = await seedStepTask(h, c.user);
    const session = await seedBrowserSession(h, c.user, t);
    const cart = await seedEvidence(h, c.user, t, session, 'screenshot', PNG);
    const confirmation = await seedEvidence(h, c.user, t, session, 'extract', Buffer.from('{}'));
    const placed = await seedOrder(h, c.user, {
      task: t,
      createdAt: ago(3),
      cartArtifactId: cart,
      confirmationArtifactId: confirmation,
    });
    const failed = await seedOrder(h, c.user, { status: 'failed', createdAt: ago(2) });
    const unknown = await seedOrder(h, c.user, { status: 'unknown', createdAt: ago(1) });

    const first = await c.request('GET', '/v1/orders?limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{ items: Order[]; nextCursor: string | null }>();
    expect(page1.items.map((o) => o.id)).toEqual([unknown, failed]);
    expect(page1.items[0]).toMatchObject({
      status: 'unknown',
      failureReason: 'ORDER_UNKNOWN',
      merchantOrderId: null,
    });
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await c.request('GET', `/v1/orders?limit=2&cursor=${page1.nextCursor}`)).json<{
      items: Order[];
      nextCursor: string | null;
    }>();
    expect(page2.items.map((o) => o.id)).toEqual([placed]);
    expect(page2.nextCursor).toBeNull();
    const order = page2.items[0]!;
    expect(order).toMatchObject({
      taskId: t.taskId,
      siteId: 'fixture-shop',
      merchantName: 'Fixture Audio',
      status: 'placed',
      subtotal: { amountMicro: 79_000_000, currency: 'USD' },
      shipping: { amountMicro: 4_990_000, currency: 'USD' },
      tax: null,
      total: { amountMicro: 83_990_000, currency: 'USD' },
      failureReason: null,
    });
    expect(order.items).toEqual([
      {
        title: 'FX-100 headphones',
        quantity: 1,
        unitPrice: { amountMicro: 79_000_000, currency: 'USD' },
        lineTotal: { amountMicro: 79_000_000, currency: 'USD' },
        productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
      },
    ]);
    expect(order.evidence.map((e) => [e.id, e.kind, e.downloadPath])).toEqual([
      [cart, 'screenshot', `/v1/evidence/${cart}/content`],
      [confirmation, 'extract', `/v1/evidence/${confirmation}/content`],
    ]);
    // Internal values stay on the server.
    expect(first.body).not.toMatch(/idempotency|action_?hash|approval_?id|storage_?key/i);

    const filtered = (await c.request('GET', '/v1/orders?status=failed')).json<{
      items: Order[];
    }>();
    expect(filtered.items.map((o) => o.id)).toEqual([failed]);
    expect(filtered.items[0]!.failureReason).toBe('PRICE_CHANGED');
    expect((await c.request('GET', '/v1/orders?status=shipped')).statusCode).toBe(400);
    expect((await c.request('GET', '/v1/orders?cursor=bogus')).statusCode).toBe(400);

    const one = await c.request('GET', `/v1/orders/${placed}`);
    expect(one.statusCode).toBe(200);
    expect(one.json<Order>()).toEqual(order);
  });

  it('keeps an order whose task was deleted (its evidence follows the task)', async () => {
    const c = await newClient(h);
    const t = await seedStepTask(h, c.user);
    const session = await seedBrowserSession(h, c.user, t);
    const cart = await seedEvidence(h, c.user, t, session, 'screenshot', PNG);
    const id = await seedOrder(h, c.user, { task: t, cartArtifactId: cart });
    await withContext(h.db, c.user, (trx) =>
      trx.deleteFrom('tasks').where('id', '=', t.taskId).execute(),
    );
    const order = (await c.request('GET', `/v1/orders/${id}`)).json<Order>();
    expect(order).toMatchObject({ id, taskId: null, status: 'placed', evidence: [] });
  });

  it('is owner-only: another user gets 404 and an empty list', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const id = await seedOrder(h, alice.user);
    expect((await bob.request('GET', `/v1/orders/${id}`)).statusCode).toBe(404);
    expect((await bob.request('GET', '/v1/orders')).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await bob.request('GET', `/v1/orders/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('bookings', () => {
  it('lists newest first with keyset pages and a status filter, each with its evidence', async () => {
    const c = await newClient(h);
    const t = await seedStepTask(h, c.user, 'booking.book');
    const session = await seedBrowserSession(h, c.user, t, {
      siteId: 'fixture-booking',
      operation: 'book',
    });
    const shot = await seedEvidence(h, c.user, t, session, 'screenshot', PNG);
    const ics = await seedEvidence(h, c.user, t, session, 'ics', ICS);
    const confirmed = await seedBooking(h, c.user, {
      task: t,
      createdAt: ago(2),
      confirmationArtifactId: shot,
      icsArtifactId: ics,
      priceMicro: 45_000_000,
    });
    const taken = await seedBooking(h, c.user, { status: 'failed', createdAt: ago(1) });

    const page1 = (await c.request('GET', '/v1/bookings?limit=1')).json<{
      items: Booking[];
      nextCursor: string | null;
    }>();
    expect(page1.items.map((b) => b.id)).toEqual([taken]);
    expect(page1.items[0]).toMatchObject({ status: 'failed', failureReason: 'SLOT_TAKEN' });
    const page2 = (await c.request('GET', `/v1/bookings?limit=1&cursor=${page1.nextCursor}`)).json<{
      items: Booking[];
      nextCursor: string | null;
    }>();
    expect(page2.nextCursor).toBeNull();
    expect(page2.items[0]).toMatchObject({
      id: confirmed,
      taskId: t.taskId,
      siteName: 'Fixture Dental',
      service: 'Check-up',
      status: 'confirmed',
      start: '2026-11-10T09:00:00.000Z',
      end: '2026-11-10T09:30:00.000Z',
      timeZone: 'Europe/Berlin',
      reference: 'FXD-42',
      price: { amountMicro: 45_000_000, currency: 'USD' },
      binding: true,
      calendarEventId: null,
      failureReason: null,
    });
    expect(page2.items[0]!.evidence.map((e) => [e.id, e.kind, e.mediaType])).toEqual([
      [shot, 'screenshot', 'image/png'],
      [ics, 'ics', 'text/calendar'],
    ]);
    const confirmedOnly = (await c.request('GET', '/v1/bookings?status=confirmed')).json<{
      items: Booking[];
    }>();
    expect(confirmedOnly.items.map((b) => b.id)).toEqual([confirmed]);
    expect((await c.request('GET', `/v1/bookings/${confirmed}`)).json<Booking>()).toEqual(
      page2.items[0],
    );
  });

  it('is owner-only: another user gets 404 and an empty list', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const id = await seedBooking(h, alice.user);
    expect((await bob.request('GET', `/v1/bookings/${id}`)).statusCode).toBe(404);
    expect((await bob.request('GET', '/v1/bookings')).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('evidence', () => {
  it('returns metadata and streams the file to its owner as a sandboxed, uncached attachment', async () => {
    const c = await newClient(h);
    const t = await seedStepTask(h, c.user);
    const session = await seedBrowserSession(h, c.user, t);
    const id = await seedEvidence(h, c.user, t, session, 'screenshot', PNG);
    const meta = await c.request('GET', `/v1/evidence/${id}`);
    expect(meta.statusCode).toBe(200);
    expect(meta.json<EvidenceArtifact>()).toMatchObject({
      id,
      kind: 'screenshot',
      mediaType: 'image/png',
      sizeBytes: PNG.length,
      sha256: createHash('sha256').update(PNG).digest('hex'),
      pageUrl: 'http://127.0.0.1:4599/shop/checkout',
      taskId: t.taskId,
      browserSessionId: session,
      downloadPath: `/v1/evidence/${id}/content`,
    });
    expect(meta.body).not.toMatch(/storage|tenants\//);

    const file = await c.request('GET', `/v1/evidence/${id}/content`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'content-disposition': `attachment; filename="jarvis-evidence-${id}.png"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    });
    const audits = await ownerQuery<{ target_id: string }>(
      `select target_id from audit_events where action = 'evidence.downloaded' and tenant_id = $1`,
      [c.user.tenantId],
    );
    expect(audits.map((a) => a.target_id)).toEqual([id]);

    const ics = await seedEvidence(h, c.user, t, session, 'ics', ICS);
    const icsFile = await c.request('GET', `/v1/evidence/${ics}/content`);
    expect(icsFile.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(icsFile.headers['content-disposition']).toBe(
      `attachment; filename="jarvis-evidence-${ics}.ics"`,
    );
  });

  it('is owner-only (404 for metadata and content)', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const t = await seedStepTask(h, alice.user);
    const session = await seedBrowserSession(h, alice.user, t);
    const id = await seedEvidence(h, alice.user, t, session, 'screenshot', PNG);
    expect((await bob.request('GET', `/v1/evidence/${id}`)).statusCode).toBe(404);
    const stolen = await bob.request('GET', `/v1/evidence/${id}/content`);
    expect(stolen.statusCode).toBe(404);
    expect(stolen.rawPayload.includes(PNG)).toBe(false);
  });

  it('says honestly when a file cannot be served here', async () => {
    const c = await newClient(h);
    const t = await seedStepTask(h, c.user);
    const session = await seedBrowserSession(h, c.user, t);
    const otherDriver = await seedEvidence(h, c.user, t, session, 'screenshot', PNG, {
      driver: 's3',
      store: false,
    });
    const res = await c.request('GET', `/v1/evidence/${otherDriver}/content`);
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'EVIDENCE_NOT_AVAILABLE' },
    });
    const gone = await seedEvidence(h, c.user, t, session, 'extract', Buffer.from('{}'), {
      store: false,
    });
    expect((await c.request('GET', `/v1/evidence/${gone}/content`)).statusCode).toBe(404);

    const noStorage = await createHarness({ storage: null });
    try {
      const d = await newClient(noStorage);
      const t2 = await seedStepTask(noStorage, d.user);
      const s2 = await seedBrowserSession(noStorage, d.user, t2);
      const a2 = await seedEvidence(noStorage, d.user, t2, s2, 'screenshot', PNG, { store: false });
      const r2 = await d.request('GET', `/v1/evidence/${a2}/content`);
      expect(r2.statusCode).toBe(503);
      expect(errorOf(r2).details?.reason).toBe('EVIDENCE_NOT_AVAILABLE');
      // The metadata stays readable (the task shows what was captured).
      expect((await d.request('GET', `/v1/evidence/${a2}`)).statusCode).toBe(200);
    } finally {
      await noStorage.close();
    }
  });
});

describe('TaskDetail.browserSessions', () => {
  it('lists the task’s sessions oldest first with their files (no recipe request or result)', async () => {
    const c = await newClient(h);
    const t = await seedStepTask(h, c.user);
    const first = await seedBrowserSession(h, c.user, t, {
      status: 'handover',
      operation: 'search',
      createdAt: ago(2),
    });
    const second = await seedBrowserSession(h, c.user, t, { createdAt: ago(1) });
    const shot = await seedEvidence(h, c.user, t, second, 'screenshot', PNG);
    const detail = (await c.request('GET', `/v1/tasks/${t.taskId}`)).json<TaskDetail>();
    const sessions = detail.browserSessions as BrowserSession[];
    expect(sessions.map((s) => s.id)).toEqual([first, second]);
    expect(sessions[0]).toMatchObject({
      taskId: t.taskId,
      stepId: t.stepId,
      siteId: 'fixture-shop',
      operation: 'search',
      status: 'handover',
      stopReason: 'CAPTCHA_DETECTED',
      handoverUrl: 'http://127.0.0.1:4599/captcha',
      navigations: 3,
      requests: 41,
      blockedRequests: 2,
      artifacts: [],
    });
    expect(sessions[1]!.artifacts.map((a) => a.id)).toEqual([shot]);
    expect(JSON.stringify(sessions)).not.toMatch(/cartId|FX-1|idempotency/);

    const plain = await seedStepTask(h, c.user, 'web.fetch');
    const none = (await c.request('GET', `/v1/tasks/${plain.taskId}`)).json<TaskDetail>();
    expect(none.browserSessions).toEqual([]);
  });
});

describe('email watches', () => {
  it('lists live watches first and stops one (kept as stopped, idempotent, owner-only)', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    const older = await seedWatch(h, c.user, connection.id, { createdAt: ago(10) });
    const newer = await seedWatch(h, c.user, connection.id, { createdAt: ago(5) });
    const ended = await seedWatch(h, c.user, connection.id, { createdAt: ago(1) });
    await withContext(h.db, c.user, (trx) =>
      trx
        .updateTable('email_watches')
        .set({ status: 'expired', next_check_at: null })
        .where('id', '=', ended)
        .execute(),
    );
    const list = (await c.request('GET', '/v1/email/watches')).json<{ items: EmailWatch[] }>();
    expect(list.items.map((w) => [w.id, w.status])).toEqual([
      [newer, 'watching'],
      [older, 'watching'],
      [ended, 'expired'],
    ]);
    expect(list.items[0]).toMatchObject({
      provider: 'google',
      connectionId: connection.id,
      subject: 'Quote for the kitchen',
      replyAt: null,
      replyFrom: null,
    });

    const bob = await newClient(h);
    expect((await bob.request('DELETE', `/v1/email/watches/${newer}`)).statusCode).toBe(404);
    expect((await bob.request('GET', '/v1/email/watches')).json()).toEqual({ items: [] });

    expect((await c.request('DELETE', `/v1/email/watches/${newer}`)).statusCode).toBe(204);
    expect((await c.request('DELETE', `/v1/email/watches/${newer}`)).statusCode).toBe(204);
    // An ended watch stays as it ended.
    expect((await c.request('DELETE', `/v1/email/watches/${ended}`)).statusCode).toBe(204);
    expect((await c.request('DELETE', `/v1/email/watches/${randomUUID()}`)).statusCode).toBe(404);
    const after = (await c.request('GET', '/v1/email/watches')).json<{ items: EmailWatch[] }>();
    expect(after.items.map((w) => [w.id, w.status, w.nextCheckAt])).toEqual([
      [older, 'watching', expect.any(String)],
      [ended, 'expired', null],
      [newer, 'stopped', null],
    ]);
  });
});

describe('Home "Upcoming" and the calendar routes', () => {
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  it('is null — the section is not shown — without a connection granting calendar.read', async () => {
    const c = await newClient(h);
    let home = (await c.request('GET', '/v1/home')).json<HomeSnapshot>();
    expect(home.upcoming).toBeNull();
    expect((await c.request('GET', '/v1/calendar/upcoming')).json()).toEqual({ upcoming: null });
    const events = await c.request(
      'GET',
      `/v1/calendar/events?from=${encodeURIComponent(soon(0))}&to=${encodeURIComponent(soon(24))}`,
    );
    expect(events.statusCode).toBe(409);
    expect(errorOf(events)).toMatchObject({
      code: 'CONNECTION_REQUIRED',
      details: { reason: 'CALENDAR_NOT_CONNECTED' },
    });

    // A mail-only Google account is no calendar either.
    const mailbox = addMailbox(h, c);
    await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    home = (await c.request('GET', '/v1/home')).json<HomeSnapshot>();
    expect(home.upcoming).toBeNull();
  });

  it('shows the next events of a connected calendar, live from the provider', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    h.google.addEvent(mailbox, { title: 'Dentist', start: soon(3), end: soon(4) });
    h.google.addEvent(mailbox, { title: 'Standup', start: soon(1), end: soon(1.5) });
    h.google.addEvent(mailbox, {
      title: 'Far away',
      start: soon(24 * (CALENDAR_LIMITS.upcomingDays + 2)),
      end: soon(24 * (CALENDAR_LIMITS.upcomingDays + 2) + 1),
    });
    const { connection } = await connectOAuth(h, c, 'google', ['calendar.read'], { mailbox });

    const res = await c.request('GET', '/v1/home');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const upcoming = res.json<HomeSnapshot>().upcoming!;
    expect(upcoming.events.map((e) => e.title)).toEqual(['Standup', 'Dentist']);
    expect(upcoming.events[0]).toMatchObject({ provider: 'google', connectionId: connection.id });
    expect(upcoming.sources).toEqual([
      {
        connectionId: connection.id,
        provider: 'google',
        accountIdentifier: mailbox,
        status: 'ok',
      },
    ]);
    const route = (await c.request('GET', '/v1/calendar/upcoming')).json<{
      upcoming: UpcomingEvents;
    }>();
    expect(route.upcoming.events.map((e) => e.title)).toEqual(['Standup', 'Dentist']);

    const list = await c.request(
      'GET',
      `/v1/calendar/events?from=${encodeURIComponent(soon(0))}&to=${encodeURIComponent(soon(48))}`,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { title: string }[] }>().items.map((e) => e.title)).toEqual([
      'Standup',
      'Dentist',
    ]);
    const tooWide = await c.request(
      'GET',
      `/v1/calendar/events?from=${encodeURIComponent(soon(0))}&to=${encodeURIComponent(
        soon(24 * (CALENDAR_LIMITS.listMaxDays + 1)),
      )}`,
    );
    expect(tooWide.statusCode).toBe(400);
    expect((await c.request('GET', '/v1/calendar/events?from=yesterday&to=x')).statusCode).toBe(
      400,
    );
  });

  it('reports a source that is expired or does not answer, and Home still loads in time', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    h.microsoft.addEvent(mailbox, { title: 'Review', start: soon(2), end: soon(3) });
    const google = await connectOAuth(h, c, 'google', ['calendar.read'], { mailbox });
    await connectOAuth(h, c, 'microsoft', ['calendar.read'], { mailbox });
    await withContext(h.db, c.user, (trx) =>
      trx
        .updateTable('connections')
        .set({ status: 'expired', status_reason: 'GRANT_INVALID' })
        .where('id', '=', google.connection.id)
        .execute(),
    );
    let upcoming = (await c.request('GET', '/v1/home')).json<HomeSnapshot>().upcoming!;
    expect(upcoming.sources.map((s) => [s.provider, s.status])).toEqual([
      ['google', 'expired'],
      ['microsoft', 'ok'],
    ]);
    expect(upcoming.events.map((e) => e.title)).toEqual(['Review']);

    // Microsoft hangs: Home answers within the budget and says so.
    clearUpcomingCache();
    h.microsoft.failNext(
      { method: 'GET', path: /calendarView|events/ },
      { status: 200, delayMs: CALENDAR_LIMITS.homeTimeoutMs + 3_000, passThrough: true },
    );
    const t0 = Date.now();
    const res = await c.request('GET', '/v1/home');
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(CALENDAR_LIMITS.homeTimeoutMs + 2_000);
    upcoming = res.json<HomeSnapshot>().upcoming!;
    expect(upcoming.sources.map((s) => [s.provider, s.status])).toEqual([
      ['google', 'expired'],
      ['microsoft', 'unavailable'],
    ]);
    expect(upcoming.events).toEqual([]);

    // The calendar list with no source answering is an honest 503 (the only active source,
    // Microsoft, fails; the expired Google one cannot answer either).
    h.microsoft.clearFailures();
    h.microsoft.failNext(
      { method: 'GET', path: /calendarView|events/ },
      h.microsoft.errors.unavailable(503),
      5,
    );
    const list = await c.request(
      'GET',
      `/v1/calendar/events?from=${encodeURIComponent(soon(0))}&to=${encodeURIComponent(soon(24))}`,
    );
    expect(list.statusCode).toBe(503);
    expect(errorOf(list)).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'CALENDAR_UNAVAILABLE' },
    });
  });
});

describe('PATCH /v1/me — monthly purchase limit', () => {
  it('defaults to 0 (purchases off), accepts whole cents within the limit and audits the change', async () => {
    const c = await newClient(h);
    const me = (await c.request('GET', '/v1/me')).json<Me>();
    expect(me.preferences.spending.monthlyPurchaseLimitUsd).toBe(0);

    const set = await c.request('PATCH', '/v1/me', {
      preferences: { spending: { monthlyPurchaseLimitUsd: 149.99 } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<Me>().preferences.spending).toEqual({
      monthlyAiBudgetUsd: me.preferences.spending.monthlyAiBudgetUsd,
      monthlyPurchaseLimitUsd: 149.99,
    });
    // Changing the AI budget keeps the purchase limit (and vice versa).
    const budget = await c.request('PATCH', '/v1/me', {
      preferences: { spending: { monthlyAiBudgetUsd: 7 } },
    });
    expect(budget.json<Me>().preferences.spending).toEqual({
      monthlyAiBudgetUsd: 7,
      monthlyPurchaseLimitUsd: 149.99,
    });
    const max = await c.request('PATCH', '/v1/me', {
      preferences: {
        spending: { monthlyPurchaseLimitUsd: COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax },
      },
    });
    expect(max.statusCode).toBe(200);

    const audits = await ownerQuery<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_events where action = 'account.updated' and tenant_id = $1 order by id`,
      [c.user.tenantId],
    );
    expect(audits.map((a) => a.metadata.purchaseLimitChanged ?? false)).toEqual([
      true,
      false,
      true,
    ]);
    // Never the amounts.
    expect(JSON.stringify(audits)).not.toMatch(/149\.99|10000/);
  });

  it('refuses negative, too large and sub-cent limits', async () => {
    const c = await newClient(h);
    for (const value of [-1, COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax + 0.01, 12.345, '50']) {
      const res = await c.request('PATCH', '/v1/me', {
        preferences: { spending: { monthlyPurchaseLimitUsd: value } },
      });
      expect(res.statusCode, String(value)).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    }
    const subCent = await c.request('PATCH', '/v1/me', {
      preferences: { spending: { monthlyPurchaseLimitUsd: 12.345 } },
    });
    expect(errorOf(subCent).details).toMatchObject({
      issues: [{ path: 'preferences.spending.monthlyPurchaseLimitUsd' }],
    });
    const me = (await c.request('GET', '/v1/me')).json<Me>();
    expect(me.preferences.spending.monthlyPurchaseLimitUsd).toBe(0);
  });
});

describe('account export v4 and deletion', () => {
  async function seedEverything(c: Client) {
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read', 'calendar.read'], {
      mailbox,
    });
    // An unfinished authorization (credentials in flight): never exported.
    await startOAuth(c, 'microsoft', ['calendar.read']);
    const watch = await seedWatch(h, c.user, connection.id);
    const t = await seedStepTask(h, c.user);
    const session = await seedBrowserSession(h, c.user, t);
    const shot = await seedEvidence(h, c.user, t, session, 'screenshot', PNG);
    const order = await seedOrder(h, c.user, { task: t, cartArtifactId: shot });
    const booking = await seedBooking(h, c.user, { task: t });
    return { mailbox, connection, watch, t, session, shot, order, booking };
  }

  it('exports Phase C data with evidence bytes — and never a token, envelope, verifier or account id', async () => {
    const c = await newClient(h);
    const s = await seedEverything(c);
    const res = await c.request('POST', '/v1/account/export');
    expect(res.statusCode).toBe(200);
    const doc = res.json<{
      version: number;
      connections: Record<string, unknown>[];
      emailWatches: EmailWatch[];
      orders: Order[];
      bookings: Booking[];
      browserSessions: (BrowserSession & { request: unknown; result: unknown })[];
      evidence: (EvidenceArtifact & { content: { data: string } | null })[];
    }>();
    expect(doc.version).toBe(4);
    expect(doc.connections).toHaveLength(1);
    expect(doc.connections[0]).toMatchObject({
      id: s.connection.id,
      provider: 'google',
      accountIdentifier: s.mailbox,
      capabilities: ['mail.read', 'calendar.read'],
      statusReason: null,
    });
    expect(doc.connections[0]!.scopes).toEqual(s.connection.scopes);
    expect(doc.emailWatches.map((w) => w.id)).toEqual([s.watch]);
    expect(doc.orders.map((o) => [o.id, o.evidence.map((e) => e.id)])).toEqual([
      [s.order, [s.shot]],
    ]);
    expect(doc.bookings.map((b) => b.id)).toEqual([s.booking]);
    expect(doc.browserSessions).toHaveLength(1);
    expect(doc.browserSessions[0]).toMatchObject({
      id: s.session,
      request: { cartId: 'cart-1' },
      result: { orderId: 'FX-1' },
    });
    expect(doc.browserSessions[0]!.artifacts.map((a) => a.id)).toEqual([s.shot]);
    expect(doc.evidence.map((e) => e.id)).toEqual([s.shot]);
    expect(Buffer.from(doc.evidence[0]!.content!.data, 'base64').equals(PNG)).toBe(true);

    const rows = await withContext(h.db, c.user, async (trx) => ({
      connection: await trx
        .selectFrom('connections')
        .select(['secret_ciphertext', 'provider_account_id'])
        .executeTakeFirstOrThrow(),
      states: await trx.selectFrom('oauth_states').selectAll().execute(),
    }));
    const tokens = [
      ...h.google.oauth.accessTokens.keys(),
      ...h.google.oauth.refreshTokens.keys(),
      ...h.microsoft.oauth.accessTokens.keys(),
      ...h.microsoft.oauth.refreshTokens.keys(),
    ];
    expect(tokens.length).toBeGreaterThan(0);
    const verifiers = rows.states.map((st) =>
      h.secrets.open(st.code_verifier_ciphertext, `oauth-state:${c.user.userId}:${st.id}`),
    );
    for (const needle of [
      ...tokens,
      ...verifiers,
      rows.connection.secret_ciphertext!.toString('base64'),
      rows.connection.secret_ciphertext!.toString('hex'),
      rows.connection.provider_account_id!,
      ...rows.states.map((st) => st.state_hash.toString('hex')),
      ...rows.states.map((st) => st.code_verifier_ciphertext.toString('base64')),
      'jarvis-http-test-secret',
    ])
      expect(res.body).not.toContain(needle);
    expect(res.body).not.toMatch(
      /secret_?ciphertext|providerAccountId|provider_account_id|access_?token|refresh_?token|code_?verifier|oauthStates|oauth_states|storage_?key/i,
    );
  });

  it('deleting the account revokes the Google grant at the provider and removes evidence files', async () => {
    const c = await newClient(h);
    const s = await seedEverything(c);
    const refresh = [...h.google.oauth.refreshTokens.entries()]
      .filter(([, r]) => r.email === s.mailbox)
      .map(([t]) => t);
    expect(refresh).toHaveLength(1);
    const key = `tenants/${c.user.tenantId}/users/${c.user.userId}/evidence/${s.shot}`;
    await expect(h.storage!.getBuffer(key)).resolves.toEqual(PNG);

    const res = await c.request('POST', '/v1/account/delete', {
      password: TEST_PASSWORD,
      confirmation: 'DELETE',
    });
    expect(res.statusCode).toBe(204);
    await expect(h.storage!.getBuffer(key)).rejects.toThrow();
    const queued = await ownerQuery<{ connection_id: string }>(
      'select connection_id from oauth_revocations where user_id = $1',
      [c.user.userId],
    );
    expect(queued).toEqual([{ connection_id: s.connection.id }]);
    await drainRevocations(h);
    expect(h.google.oauth.revoked).toContain(refresh[0]);
    expect(
      await ownerQuery('select id from oauth_revocations where user_id = $1', [c.user.userId]),
    ).toHaveLength(0);
    // Nothing of the user's Phase C data is left.
    for (const table of [
      'connections',
      'oauth_states',
      'email_watches',
      'orders',
      'bookings',
      'browser_sessions',
      'evidence_artifacts',
    ])
      expect(
        await ownerQuery(`select 1 from ${table} where user_id = $1`, [c.user.userId]),
        table,
      ).toHaveLength(0);
  });
});
