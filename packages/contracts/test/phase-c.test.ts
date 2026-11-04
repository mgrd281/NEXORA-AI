/**
 * Phase C contracts (docs/architecture/phase-c.md §6): additive and backward
 * compatible — every payload of an older server or client still decodes — plus
 * the shapes the four stage-2 owners build against.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BrowserStopReason,
  COMMERCE_LIMITS,
  ConnectionCapability,
  ConnectionProvider,
  EVIDENCE_MEDIA_TYPE,
  EvidenceArtifactKind,
  MissingInfo,
  NotificationKind,
  OAUTH_SCOPES,
  OAuthProvider,
  PolicyReason,
  TaskErrorReason,
  ToolId,
} from '../src/index';
import {
  AccountEventType,
  ApprovalDetails,
  AssistantStatus,
  Booking,
  BookingConfirmation,
  BookingSlots,
  BrowserSession,
  CalendarEventList,
  CalendarEventListQuery,
  Connection,
  ConnectionProviderInfo,
  DEFAULT_PREFERENCES,
  EmailThreadSummary,
  EmailWatch,
  Evidence,
  EvidenceCode,
  FreeBusyResult,
  HomeSnapshot,
  Money,
  OAuthCallbackRequest,
  OAuthCallbackResult,
  OAuthStartRequest,
  Order,
  Preferences,
  PreparedCart,
  ServerMessageKey,
  ShoppingComparison,
  Skill,
  StreamEvent,
  TaskDetail,
  UpcomingEvents,
  UpdateMeRequest,
  VerificationCheckKey,
} from '../src/schemas';
import { routes, type RouteDef } from '../src/routes';

const ID = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';
const AT = '2026-11-04T09:00:00.000Z';
const LATER = '2026-11-04T10:00:00.000Z';
const usd = (dollars: number) => ({
  amountMicro: Math.round(dollars * 1_000_000),
  currency: 'USD',
});

function roundTrip<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  return parsed;
}

const ARTIFACT = {
  id: ID2,
  kind: 'screenshot',
  mediaType: 'image/png',
  sizeBytes: 81_920,
  sha256: 'c'.repeat(64),
  pageUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
  taskId: ID,
  browserSessionId: ID,
  downloadPath: `/v1/evidence/${ID2}/content`,
  createdAt: AT,
} as const;

describe('Phase C: backwards compatibility', () => {
  it('stored preferences without the purchase limit default to 0 (purchases off)', () => {
    const stored = { ...DEFAULT_PREFERENCES, spending: { monthlyAiBudgetUsd: 20 } };
    expect(Preferences.parse(stored).spending.monthlyPurchaseLimitUsd).toBe(0);
    expect(DEFAULT_PREFERENCES.spending.monthlyPurchaseLimitUsd).toBe(0);
  });

  it('a PATCH of one spending field never resets the other one to its default', () => {
    const patch = UpdateMeRequest.parse({ preferences: { spending: { monthlyAiBudgetUsd: 5 } } });
    expect(patch.preferences?.spending).toEqual({ monthlyAiBudgetUsd: 5 });
    const limit = UpdateMeRequest.parse({
      preferences: { spending: { monthlyPurchaseLimitUsd: 250 } },
    });
    expect(limit.preferences?.spending).toEqual({ monthlyPurchaseLimitUsd: 250 });
    expect(
      UpdateMeRequest.safeParse({
        preferences: {
          spending: { monthlyPurchaseLimitUsd: COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax + 1 },
        },
      }).success,
    ).toBe(false);
  });

  it('connections, home, status and skills of older servers still decode', () => {
    const smtp = {
      id: ID,
      provider: 'smtp',
      label: 'Email',
      accountIdentifier: 'me@example.com',
      status: 'active',
      permissions: ['email.send'],
      lastVerifiedAt: AT,
      lastError: null,
      expiresAt: null,
      createdAt: AT,
    };
    expect(Connection.parse(smtp).capabilities).toBeUndefined();
    const home = {
      assistant: {
        planner: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
        worker: { healthy: true, lastHeartbeatAt: AT },
        capabilities: { webFetch: true, email: true, memory: true, generalQuestions: false },
        version: '0.1.0',
      },
      pendingApprovals: [],
      activeTasks: [],
      recentTasks: [],
      unreadNotifications: 0,
      suggestions: [],
    };
    expect(HomeSnapshot.parse(home).upcoming).toBeUndefined();
    expect(AssistantStatus.parse(home.assistant).capabilities.calendar).toBeUndefined();
    const skill = {
      id: 'email-management',
      version: '0.2.0',
      status: 'implemented',
      enabled: true,
      canToggle: true,
      available: true,
      unavailableReason: null,
      tools: ['email.send'],
      plannedTools: [],
      permissions: ['email:send'],
      maxRisk: 'HIGH',
      requiredConnections: ['smtp'],
      modelUse: 'none',
      maxCostPerRunMicroUsd: null,
      docsPath: 'docs/skills/email-management.md',
    };
    expect(Skill.parse(skill).connectionOptions).toBeUndefined();
  });

  it('an email approval of an older server is a send through SMTP', () => {
    const d = ApprovalDetails.parse({
      kind: 'email',
      from: 'me@example.com',
      to: ['anna@example.org'],
      subject: 'Hi',
      body: 'Hello',
    });
    expect(d.kind === 'email' && d.mode).toBeUndefined();
  });

  it('enums keep every earlier value (additive only)', () => {
    for (const p of ['web', 'smtp']) expect(ConnectionProvider.options).toContain(p);
    for (const t of ['web.fetch', 'email.send', 'assistant.clarify'])
      expect(ToolId.options).toContain(t);
    for (const r of ['CONNECTION_MISSING', 'FUTURE_RUNS'])
      expect(PolicyReason.options).toContain(r);
    for (const k of ['connection_error', 'webhook_disabled'])
      expect(NotificationKind.options).toContain(k);
  });
});

describe('Phase C: enums', () => {
  it('adds the OAuth providers and their capabilities', () => {
    expect(OAuthProvider.options).toEqual(['google', 'microsoft']);
    for (const p of OAuthProvider.options) expect(ConnectionProvider.options).toContain(p);
  });

  it('adds every Phase C tool', () => {
    expect(ToolId.options).toEqual(
      expect.arrayContaining([
        'email.search',
        'email.read_thread',
        'email.draft_reply',
        'email.track_replies',
        'calendar.list',
        'calendar.free_busy',
        'calendar.create_event',
        'calendar.update_event',
        'calendar.cancel_event',
        'booking.find_slots',
        'booking.book',
        'browser.read',
        'browser.fill',
        'shop.search',
        'shop.compare',
        'shop.prepare_cart',
        'shop.checkout',
      ]),
    );
    // + Phase D's phone.call (test/phase-d.test.ts).
    expect(ToolId.options).toHaveLength(10 + 17 + 1);
  });

  it('every browser stop reason (but a cancellation) is a task error reason clients explain', () => {
    for (const r of BrowserStopReason.options.filter((r) => r !== 'CANCELLED'))
      expect(TaskErrorReason.options).toContain(r);
  });

  it('policy deny reasons of Phase C are task error reasons of the same name', () => {
    for (const r of [
      'CONNECTION_EXPIRED',
      'CONNECTION_SCOPE_MISSING',
      'PURCHASES_DISABLED',
      'PURCHASE_LIMIT',
      'PURCHASE_CURRENCY',
    ]) {
      expect(PolicyReason.options).toContain(r);
      expect(TaskErrorReason.options).toContain(r);
    }
    for (const r of ['PURCHASE', 'BINDING_COMMITMENT']) expect(PolicyReason.options).toContain(r);
  });

  it('adds the notification kinds, stream events, questions, evidence and checks', () => {
    expect(NotificationKind.options).toEqual(
      expect.arrayContaining(['connection_expired', 'email_reply_received']),
    );
    expect(AccountEventType.options).toEqual(
      expect.arrayContaining([
        'email_watch.changed',
        'browser_session.changed',
        'order.changed',
        'booking.changed',
      ]),
    );
    for (const type of AccountEventType.options)
      expect(StreamEvent.safeParse({ id: '1', type, taskId: null, at: AT, data: {} }).success).toBe(
        true,
      );
    expect(MissingInfo.options).toEqual(
      expect.arrayContaining(['date_time', 'contact_details', 'product', 'site']),
    );
    expect(EvidenceCode.options).toEqual(
      expect.arrayContaining(['SCREENSHOT', 'ORDER_CONFIRMATION', 'MAIL_SENT', 'HANDOVER']),
    );
    expect(VerificationCheckKey.options).toEqual(
      expect.arrayContaining(['totalMatches', 'liveSource', 'noConflict']),
    );
    expect(ServerMessageKey.options).toEqual(
      expect.arrayContaining([
        'approval.purchase',
        'approval.eventInvite',
        'result.orderPlaced',
        'question.dateTime',
      ]),
    );
  });

  it('evidence of the browser agent has a kind and a fixed media type', () => {
    for (const kind of EvidenceArtifactKind.options) expect(EVIDENCE_MEDIA_TYPE[kind]).toBeTruthy();
    expect(
      Evidence.safeParse({
        kind: 'browser_capture',
        label: 'Screenshot',
        value: ID2,
        at: AT,
        code: 'SCREENSHOT',
        params: { artifactId: ID2, url: ARTIFACT.pageUrl, sha256: ARTIFACT.sha256 },
      }).success,
    ).toBe(true);
  });
});

describe('Phase C: OAuth scopes are least privilege', () => {
  it('maps every capability of every provider to explicit scopes', () => {
    for (const p of OAuthProvider.options) {
      expect(OAUTH_SCOPES[p].identity.length).toBeGreaterThan(0);
      for (const c of ConnectionCapability.options)
        expect(OAUTH_SCOPES[p][c].length, `${p} ${c}`).toBeGreaterThan(0);
    }
  });

  it('never requests full-account scopes', () => {
    const all = OAuthProvider.options.flatMap((p) => Object.values(OAUTH_SCOPES[p]).flat());
    for (const broad of [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://graph.microsoft.com/Mail.ReadWrite.Shared',
      'https://graph.microsoft.com/.default',
      'Directory.Read.All',
    ])
      expect(all).not.toContain(broad);
    // Reading never needs a write scope.
    expect(OAUTH_SCOPES.google['mail.read']).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
    expect(OAUTH_SCOPES.microsoft['calendar.read']).toEqual([
      'https://graph.microsoft.com/Calendars.Read',
    ]);
    // Microsoft refresh tokens need offline_access.
    expect(OAUTH_SCOPES.microsoft.identity).toContain('offline_access');
  });
});

describe('Phase C: OAuth requests', () => {
  const start = {
    provider: 'google',
    capabilities: ['mail.read', 'calendar.read'],
    redirectUri: 'https://jarvis.example.com/connections/callback',
  };

  it('a start request needs unique capabilities and a returnTo path of this app', () => {
    expect(OAuthStartRequest.parse(start).connectionId).toBeUndefined();
    expect(OAuthStartRequest.parse({ ...start, returnTo: '/tasks/abc?x=1' }).returnTo).toBe(
      '/tasks/abc?x=1',
    );
    for (const returnTo of ['//evil.example', 'https://evil.example/', '/\\evil', 'tasks', '/a b'])
      expect(OAuthStartRequest.safeParse({ ...start, returnTo }).success, returnTo).toBe(false);
    expect(
      OAuthStartRequest.safeParse({ ...start, capabilities: ['mail.read', 'mail.read'] }).success,
    ).toBe(false);
    expect(OAuthStartRequest.safeParse({ ...start, capabilities: [] }).success).toBe(false);
    expect(OAuthStartRequest.safeParse({ ...start, provider: 'smtp' }).success).toBe(false);
  });

  it('a callback carries exactly one of code and error', () => {
    const state = 's'.repeat(43);
    expect(OAuthCallbackRequest.safeParse({ state, code: 'abc' }).success).toBe(true);
    expect(OAuthCallbackRequest.safeParse({ state, error: 'access_denied' }).success).toBe(true);
    expect(OAuthCallbackRequest.safeParse({ state }).success).toBe(false);
    expect(OAuthCallbackRequest.safeParse({ state, code: 'a', error: 'x' }).success).toBe(false);
    expect(OAuthCallbackRequest.safeParse({ state: 'short', code: 'a' }).success).toBe(false);
  });

  it('a callback result and a provider entry round-trip', () => {
    roundTrip(OAuthCallbackResult, {
      connection: {
        id: ID,
        provider: 'microsoft',
        label: 'Microsoft',
        accountIdentifier: 'me@contoso.example',
        status: 'active',
        permissions: [],
        lastVerifiedAt: AT,
        lastError: null,
        expiresAt: null,
        createdAt: AT,
        capabilities: ['calendar.read', 'calendar.write'],
        scopes: ['Calendars.Read', 'Calendars.ReadWrite', 'User.Read', 'offline_access'],
        statusReason: null,
      },
      returnTo: '/connections',
      resumableTaskIds: [ID2],
    });
    roundTrip(ConnectionProviderInfo, {
      provider: 'google',
      kind: 'oauth',
      configured: false,
      capabilities: [{ capability: 'mail.read', scopes: OAUTH_SCOPES.google['mail.read'] }],
      identityScopes: OAUTH_SCOPES.google.identity,
      revocation: 'provider',
    });
  });
});

describe('Phase C: calendars and email', () => {
  it('upcoming events and the event list round-trip', () => {
    const source = {
      connectionId: ID,
      provider: 'google',
      accountIdentifier: 'me@example.com',
      status: 'ok',
    };
    roundTrip(UpcomingEvents, {
      events: [
        {
          id: 'evt_1',
          provider: 'google',
          connectionId: ID,
          title: 'Dentist',
          start: AT,
          end: LATER,
          timeZone: 'Europe/Berlin',
          allDay: false,
          location: null,
          status: 'confirmed',
          webLink: null,
          attendeeCount: 0,
        },
      ],
      sources: [source, { ...source, connectionId: ID2, provider: 'microsoft', status: 'expired' }],
      rangeStart: AT,
      rangeEnd: LATER,
      fetchedAt: AT,
    });
    roundTrip(CalendarEventList, { items: [], sources: [source], truncated: false });
    expect(CalendarEventListQuery.safeParse({ from: AT, to: LATER }).success).toBe(true);
    expect(CalendarEventListQuery.safeParse({ from: 'tomorrow', to: LATER }).success).toBe(false);
  });

  it('free/busy reports inaccessible calendars instead of assuming them free', () => {
    const r = roundTrip(FreeBusyResult, {
      timeMin: AT,
      timeMax: LATER,
      timeZone: 'Europe/Berlin',
      durationMinutes: 30,
      calendars: [
        { email: 'me@example.com', accessible: true, busy: [{ start: AT, end: LATER }] },
        { email: 'bob@example.org', accessible: false, busy: [] },
      ],
      slots: [],
    });
    expect(r.calendars[1]!.accessible).toBe(false);
  });

  it('threads and watches round-trip', () => {
    roundTrip(EmailThreadSummary, {
      id: 't1',
      provider: 'google',
      connectionId: ID,
      subject: 'Lunch?',
      participants: [{ name: 'Anna', address: 'anna@example.org' }],
      lastMessageFrom: { name: 'Anna', address: 'anna@example.org' },
      lastMessageAt: AT,
      snippet: 'Are you free on Friday?',
      messageCount: 2,
      unread: true,
      needsReply: true,
      webLink: null,
    });
    roundTrip(EmailWatch, {
      id: ID,
      provider: 'microsoft',
      connectionId: ID2,
      threadId: 'AAQk',
      subject: 'Quote',
      status: 'watching',
      taskId: ID,
      lastCheckedAt: null,
      nextCheckAt: LATER,
      replyAt: null,
      replyFrom: null,
      expiresAt: LATER,
      createdAt: AT,
      updatedAt: AT,
    });
  });
});

describe('Phase C: approvals show everything the user must see', () => {
  it('calendar events: exact times, zone and every attendee', () => {
    const d = roundTrip(ApprovalDetails, {
      kind: 'calendar_event',
      action: 'create',
      provider: 'google',
      account: 'me@example.com',
      eventId: null,
      title: 'Project sync',
      start: AT,
      end: LATER,
      timeZone: 'Europe/Berlin',
      allDay: false,
      location: null,
      description: null,
      attendees: ['bob@example.org'],
      notifyAttendees: true,
      previous: null,
      conflictCheck: true,
    });
    expect(d.kind).toBe('calendar_event');
  });

  it('purchases: items, quantities, total, merchant, delivery and the monthly limit', () => {
    roundTrip(ApprovalDetails, {
      kind: 'purchase',
      siteId: 'fixture-shop',
      merchant: { name: 'Fixture Audio', host: '127.0.0.1:4599' },
      items: [
        {
          title: 'FX-100 headphones',
          quantity: 1,
          unitPrice: usd(79),
          lineTotal: usd(79),
          productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
        },
      ],
      subtotal: usd(79),
      shipping: usd(4.99),
      tax: null,
      total: usd(83.99),
      delivery: { method: 'Standard', estimate: '2–4 business days', address: '1 Test Street' },
      paymentMethod: 'Test card •••• 4242',
      limit: { monthly: usd(200), spentThisMonth: usd(0), remainingAfter: usd(116.01) },
      evidenceArtifactId: ID2,
    });
  });

  it('bookings and form submissions: every personal detail sent, binding or not', () => {
    roundTrip(ApprovalDetails, {
      kind: 'booking',
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      siteHost: '127.0.0.1:4599',
      service: 'Check-up',
      start: AT,
      end: LATER,
      timeZone: 'Europe/Berlin',
      fields: [
        { label: 'Name', value: 'Ada Lovelace', personal: true },
        { label: 'Phone', value: '+49 30 1234567', personal: true },
      ],
      price: null,
      binding: true,
      cancellationTerms: 'Cancel up to 24 hours before free of charge.',
      evidenceArtifactId: ID2,
    });
    roundTrip(ApprovalDetails, {
      kind: 'form_submission',
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      siteHost: '127.0.0.1:4599',
      form: 'contact',
      fields: [{ label: 'Message', value: 'Please call me back.', personal: false }],
      binding: false,
      evidenceArtifactId: null,
    });
  });

  it('a draft reply says it is a draft, and through which account', () => {
    const d = roundTrip(ApprovalDetails, {
      kind: 'email',
      from: 'me@example.com',
      to: ['anna@example.org'],
      subject: 'Re: Lunch?',
      body: 'Friday works.',
      mode: 'draft',
      via: 'google',
      cc: [],
      inReplyTo: { threadId: 't1', subject: 'Lunch?' },
    });
    expect(d.kind === 'email' && d.mode).toBe('draft');
  });
});

describe('Phase C: commerce, booking and browser records', () => {
  it('money is integer micro-units with an ISO 4217 code', () => {
    expect(Money.safeParse(usd(1.5)).success).toBe(true);
    expect(Money.safeParse({ amountMicro: 1.5, currency: 'USD' }).success).toBe(false);
    expect(Money.safeParse({ amountMicro: 1, currency: 'usd' }).success).toBe(false);
    expect(Money.safeParse({ amountMicro: -1, currency: 'USD' }).success).toBe(false);
  });

  it('a comparison keeps unknown shipping unknown, never zero', () => {
    const c = roundTrip(ShoppingComparison, {
      query: 'headphones',
      offers: [
        {
          id: 'o1',
          siteId: 'fixture-shop',
          merchantName: 'Fixture Audio',
          merchantHost: '127.0.0.1:4599',
          title: 'FX-100',
          productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
          price: usd(79),
          shipping: null,
          total: null,
          delivery: { minDays: 2, maxDays: 4, text: '2–4 business days' },
          inStock: true,
          rating: { value: 4.5, count: 120 },
          signals: [{ code: 'return_policy', present: true, value: null }],
          evidenceArtifactId: ID2,
          capturedAt: AT,
        },
      ],
      ranking: ['o1'],
      sites: [{ siteId: 'fixture-shop', status: 'ok', reason: null }],
      mixedCurrencies: false,
      generatedAt: AT,
    });
    expect(c.offers[0]!.shipping).toBeNull();
  });

  it('carts, orders, bookings and sessions round-trip', () => {
    const line = {
      title: 'FX-100',
      quantity: 2,
      unitPrice: usd(79),
      lineTotal: usd(158),
      productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
    };
    roundTrip(PreparedCart, {
      siteId: 'fixture-shop',
      merchantName: 'Fixture Audio',
      merchantHost: '127.0.0.1:4599',
      lines: [line],
      subtotal: usd(158),
      shipping: usd(0),
      total: usd(158),
      checkoutSupported: true,
      handoverUrl: null,
      evidenceArtifactId: ID2,
      preparedAt: AT,
    });
    expect(PreparedCart.safeParse({ lines: [{ ...line, quantity: 11 }] }).success).toBe(false);
    roundTrip(Order, {
      id: ID,
      taskId: ID2,
      siteId: 'fixture-shop',
      merchantName: 'Fixture Audio',
      merchantHost: '127.0.0.1:4599',
      status: 'unknown',
      items: [line],
      subtotal: usd(158),
      shipping: usd(0),
      tax: null,
      total: usd(158),
      merchantOrderId: null,
      placedAt: null,
      failureReason: 'ORDER_UNKNOWN',
      evidence: [ARTIFACT],
      createdAt: AT,
      updatedAt: AT,
    });
    roundTrip(BookingSlots, {
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      service: 'Check-up',
      slots: [
        {
          id: 'slot-1',
          start: AT,
          end: LATER,
          timeZone: 'Europe/Berlin',
          service: 'Check-up',
          price: null,
        },
      ],
      requiredFields: ['Name', 'Email', 'Phone'],
      evidenceArtifactId: ID2,
      capturedAt: AT,
    });
    roundTrip(BookingConfirmation, {
      bookingId: ID,
      reference: 'FXD-2026-0042',
      service: 'Check-up',
      start: AT,
      end: LATER,
      timeZone: 'Europe/Berlin',
      location: 'Fixture Street 1',
      siteId: 'fixture-booking',
      siteHost: '127.0.0.1:4599',
      icsArtifactId: ID2,
      screenshotArtifactId: null,
      confirmedAt: AT,
    });
    roundTrip(Booking, {
      id: ID,
      taskId: null,
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      siteHost: '127.0.0.1:4599',
      service: 'Check-up',
      status: 'confirmed',
      start: AT,
      end: LATER,
      timeZone: 'Europe/Berlin',
      reference: 'FXD-2026-0042',
      price: null,
      binding: true,
      calendarEventId: 'evt_9',
      failureReason: null,
      evidence: [ARTIFACT],
      createdAt: AT,
      updatedAt: AT,
    });
    const session = roundTrip(BrowserSession, {
      id: ID,
      taskId: ID2,
      stepId: ID,
      siteId: 'fixture-shop',
      operation: 'search',
      status: 'handover',
      stopReason: 'CAPTCHA_DETECTED',
      handoverUrl: 'http://127.0.0.1:4599/captcha',
      navigations: 2,
      requests: 14,
      blockedRequests: 1,
      startedAt: AT,
      endedAt: LATER,
      createdAt: AT,
      artifacts: [ARTIFACT],
    });
    expect(session.stopReason).toBe('CAPTCHA_DETECTED');
    // Stage 3: the recipe's display name is additive — older servers omit it, newer send it.
    expect(session.siteName).toBeUndefined();
    expect(BrowserSession.parse({ ...session, siteName: 'Fixture Shop' }).siteName).toBe(
      'Fixture Shop',
    );
    expect(BrowserSession.parse({ ...session, siteName: null }).siteName).toBeNull();
  });

  it('a task detail carries its browser sessions (optional for older servers)', () => {
    const shape = TaskDetail.shape.browserSessions;
    expect(shape.safeParse(undefined).success).toBe(true);
  });
});

describe('Phase C route table', () => {
  const all = Object.entries(routes) as [string, RouteDef][];
  const PHASE_C = [
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
  ] as const;

  it('includes every Phase C endpoint, all for signed-in users', () => {
    expect(Object.keys(routes)).toEqual(expect.arrayContaining([...PHASE_C]));
    // + the 7 Phase D routes (test/phase-d.test.ts).
    expect(all).toHaveLength(35 + 26 + PHASE_C.length + 7);
    for (const name of PHASE_C) expect((routes[name] as RouteDef).auth, name).toBe('user');
  });

  it('the OAuth callback is a POST from the signed-in client, never an unauthenticated GET', () => {
    expect(routes.completeOAuthConnection.method).toBe('POST');
    expect(routes.startOAuthConnection.method).toBe('POST');
    // Neither replays a stored response: a state is single use.
    expect('idempotent' in routes.completeOAuthConnection).toBe(false);
  });

  it('orders and bookings are read-only over HTTP (only the agent creates them, with approval)', () => {
    for (const [name, r] of all) {
      if (r.path.startsWith('/v1/orders') || r.path.startsWith('/v1/bookings'))
        expect(r.method, name).toBe('GET');
    }
  });

  it('evidence downloads declare their media types', () => {
    expect(routes.downloadEvidence.download.mediaTypes).toEqual([
      'image/png',
      'application/json',
      'text/calendar',
      // Phase D: call recordings (only with the callee's consent).
      'audio/mpeg',
    ]);
  });
});

describe('Phase C: money parameters', () => {
  it('format the same in every locale, with at least two decimals', async () => {
    const { moneyParam, toMicro } = await import('../src/money');
    expect(moneyParam({ amountMicro: toMicro(129.99), currency: 'USD' })).toBe('USD 129.99');
    expect(moneyParam({ amountMicro: toMicro(5), currency: 'EUR' })).toBe('EUR 5.00');
    expect(moneyParam({ amountMicro: 1_234_567, currency: 'KWD' })).toBe('KWD 1.234567');
    expect(moneyParam({ amountMicro: 0, currency: 'USD' })).toBe('USD 0.00');
  });
});
