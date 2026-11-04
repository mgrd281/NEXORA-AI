import type {
  CalendarEventSummary,
  Connection,
  ConnectionProviderInfo,
  TaskStep,
} from '@jarvis/contracts';
import { moneyParam, OAUTH_SCOPES } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { approvalLabelKind, reasonKey } from '@/components/approvals/labels';
import { evidenceHref } from '@/components/evidence/EvidenceImage';
import {
  callbackRequest,
  connectionOf,
  missingCapabilities,
  oauthCardState,
  reconnectCapabilities,
  requiredBy,
  safeAuthorizationUrl,
  safeReturnTo,
  scopesFor,
  withPrerequisites,
} from '@/features/connections/oauth';
import {
  conflicts,
  dayKey,
  otherZone,
  problemSources,
  upcomingDays,
} from '@/features/home/upcoming';
import { committedThisMonth, monthStart } from '@/features/settings/spending';
import {
  cartView,
  comparisonView,
  emailSearchView,
  handoverOf,
  knownSiteNames,
  siteLabel,
  slotsView,
} from '@/features/tasks/phase-c/results';
import { hasNextStep } from '@/features/tasks/phase-c/NextStep';
import { parseEvidence } from '@/features/tasks/model';
import { catalogs } from '@/i18n/messages';
import { renderServerMessage } from '@/i18n/server-message';
import { createTranslator, stripIsolates } from '@/i18n/translate';
import { addMoney, formatMoney, parseMoneyParam, subtractMoney } from '@/lib/money';
import { queriesToInvalidate } from '@/lib/events/invalidation';
import { qk } from '@/lib/api/query-keys';

const usd = (cents: number) => ({ amountMicro: cents * 10_000, currency: 'USD' });
/** Intl separates amount and symbol with a no-break space. */
const plain = (text: string) => stripIsolates(text).replace(/[\u00a0\u202f]/g, ' ');

function info(provider: 'google' | 'microsoft', configured = true): ConnectionProviderInfo {
  const s = OAUTH_SCOPES[provider];
  return {
    provider,
    kind: 'oauth',
    configured,
    capabilities: (
      ['mail.read', 'mail.compose', 'mail.send', 'calendar.read', 'calendar.write'] as const
    ).map((capability) => ({ capability, scopes: [...s[capability]] })),
    identityScopes: [...s.identity],
    revocation: provider === 'google' ? 'provider' : 'local_only',
  };
}

function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'google',
    label: 'Google',
    accountIdentifier: 'a@example.com',
    status: 'active',
    permissions: [],
    lastVerifiedAt: null,
    lastError: null,
    expiresAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    capabilities: ['mail.read'],
    scopes: [],
    statusReason: null,
    ...over,
  };
}

function step(over: Partial<TaskStep> & Pick<TaskStep, 'toolId'>): TaskStep {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    position: 0,
    title: 'x',
    titleMessage: null,
    riskLevel: 'LOW',
    status: 'SUCCEEDED',
    requiresApproval: false,
    policy: { decision: 'allow', reasons: [] },
    inputPreview: {},
    output: null,
    evidence: [],
    attempts: 1,
    startedAt: null,
    completedAt: null,
    error: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ money */

describe('money', () => {
  it('formats amounts in the viewer’s notation without rounding real decimals', () => {
    expect(formatMoney(usd(14900), 'en-US')).toBe('$149.00');
    expect(plain(formatMoney(usd(14900), 'de-DE'))).toBe('149,00 $');
    expect(formatMoney({ amountMicro: 5_000, currency: 'USD' }, 'en-US')).toBe('$0.005');
    expect(plain(formatMoney({ amountMicro: 18_400_000_000, currency: 'EUR' }, 'de-DE'))).toBe(
      '18.400,00 €',
    );
  });

  it('reads contracts money params and never converts currencies', () => {
    expect(parseMoneyParam(moneyParam(usd(12999)))).toEqual(usd(12999));
    expect(parseMoneyParam('USD 0.005')).toEqual({ amountMicro: 5_000, currency: 'USD' });
    expect(parseMoneyParam('129.99 USD')).toBeNull();
    expect(parseMoneyParam('USD -1.00')).toBeNull();
    expect(addMoney(usd(100), usd(250))).toEqual(usd(350));
    expect(addMoney(usd(100), { amountMicro: 1, currency: 'EUR' })).toBeNull();
    expect(subtractMoney(usd(100), usd(250))).toBeNull();
  });

  it('localizes money params in server sentences and task errors', () => {
    const t = createTranslator('de', catalogs.de);
    const text = renderServerMessage(
      { t, messages: catalogs.de, f: { intlLocale: 'de-DE' } },
      { key: 'approval.purchase', params: { total: 'USD 149.00', merchant: 'Fixture Shop' } },
    );
    expect(plain(text ?? '')).toContain('149,00 $');
    // Without the locale (stored text) the parameter stays as the server wrote it.
    const stored = renderServerMessage(
      { t, messages: catalogs.de },
      { key: 'approval.purchase', params: { total: 'USD 149.00', merchant: 'Fixture Shop' } },
    );
    expect(stripIsolates(stored ?? '')).toContain('USD 149.00');
  });
});

/* ------------------------------------------------------------------ OAuth */

describe('OAuth connection cards', () => {
  it('says honestly when a provider is not configured on this server', () => {
    expect(oauthCardState(info('google', false), null)).toBe('unconfigured');
    expect(oauthCardState(info('google'), null)).toBe('disconnected');
    expect(oauthCardState(info('google'), connection())).toBe('active');
    expect(oauthCardState(info('google'), connection({ status: 'expired' }))).toBe('expired');
    expect(oauthCardState(info('google'), connection({ statusReason: 'SCOPE_MISSING' }))).toBe(
      'scopeMissing',
    );
    expect(oauthCardState(info('google'), connection({ status: 'error' }))).toBe('error');
  });

  it('asks for exactly the identity scopes plus the chosen capabilities, without repeats', () => {
    expect(scopesFor(info('google'), ['calendar.read', 'calendar.write'])).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    expect(scopesFor(info('microsoft'), [])).toEqual(OAUTH_SCOPES.microsoft.identity);
  });

  it('adds prerequisites (changing the calendar needs reading it) and says why', () => {
    const offered = info('google').capabilities.map((c) => c.capability);
    expect(withPrerequisites(['calendar.write'], offered)).toEqual([
      'calendar.read',
      'calendar.write',
    ]);
    expect(requiredBy('calendar.read', ['calendar.write'])).toBe('calendar.write');
    expect(requiredBy('mail.read', ['calendar.write'])).toBeNull();
  });

  it('reconnects with the same capabilities and adds only what is missing', () => {
    const c = connection({ capabilities: ['mail.read', 'calendar.read'] });
    expect(reconnectCapabilities(info('microsoft'), c)).toEqual(['mail.read', 'calendar.read']);
    expect(reconnectCapabilities(info('microsoft'), connection({ capabilities: [] }))).toEqual([
      'mail.read',
      'calendar.read',
    ]);
    expect(missingCapabilities(info('google'), c)).toEqual([
      'mail.compose',
      'mail.send',
      'calendar.write',
    ]);
  });

  it('uses the newest non-revoked connection of the provider', () => {
    const old = connection({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
    const revoked = connection({
      id: 'b',
      status: 'revoked',
      createdAt: '2026-12-01T00:00:00.000Z',
    });
    const fresh = connection({ id: 'c', createdAt: '2026-06-01T00:00:00.000Z' });
    expect(connectionOf('google', [old, revoked, fresh])?.id).toBe('c');
    expect(connectionOf('microsoft', [old])).toBeNull();
  });

  it('follows only http(s) consent URLs (http only on localhost)', () => {
    expect(safeAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    );
    expect(safeAuthorizationUrl('http://127.0.0.1:4701/o/oauth2/v2/auth')).not.toBeNull();
    expect(safeAuthorizationUrl('http://evil.example/auth')).toBeNull();
    expect(safeAuthorizationUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizationUrl('https://user:pw@accounts.google.com/')).toBeNull();
  });

  it('forwards the provider’s redirect verbatim (code xor error) and validates returnTo', () => {
    const state = 's'.repeat(32);
    expect(callbackRequest(new URLSearchParams(`code=abc&state=${state}&iss=https://x`))).toEqual({
      state,
      code: 'abc',
      iss: 'https://x',
    });
    expect(
      callbackRequest(
        new URLSearchParams(`error=access_denied&error_description=nope&state=${state}`),
      ),
    ).toEqual({ state, error: 'access_denied', errorDescription: 'nope' });
    expect(callbackRequest(new URLSearchParams(`state=${state}`))).toBeNull();
    expect(callbackRequest(new URLSearchParams('code=abc'))).toBeNull();
    expect(safeReturnTo('/tasks/1')).toBe('/tasks/1');
    expect(safeReturnTo('//evil.example')).toBe('/connections');
    expect(safeReturnTo('https://evil.example')).toBe('/connections');
    expect(safeReturnTo(null)).toBe('/connections');
  });
});

/* ------------------------------------------------------------------ Home "Upcoming" */

function event(over: Partial<CalendarEventSummary>): CalendarEventSummary {
  return {
    id: 'e',
    provider: 'google',
    connectionId: '11111111-1111-4111-8111-111111111111',
    title: 'Event',
    start: '2026-11-05T09:00:00.000Z',
    end: '2026-11-05T10:00:00.000Z',
    timeZone: 'Europe/Berlin',
    allDay: false,
    location: null,
    status: 'confirmed',
    webLink: null,
    attendeeCount: 0,
    ...over,
  };
}

describe('Home upcoming', () => {
  const now = Date.parse('2026-11-04T08:00:00.000Z');

  it('groups by day in the viewer’s zone (not UTC) with today / tomorrow', () => {
    const late = event({
      id: 'late',
      start: '2026-11-04T23:30:00.000Z',
      end: '2026-11-05T00:00:00.000Z',
    });
    const days = upcomingDays([late], 'Europe/Berlin', now);
    expect(days[0]!.key).toBe('2026-11-05');
    expect(days[0]!.relative).toBe(1);
    expect(upcomingDays([late], 'America/New_York', now)[0]!.relative).toBe(0);
  });

  it('keeps an all-day event on its own date, first in the day', () => {
    const allDay = event({
      id: 'all',
      allDay: true,
      timeZone: null,
      start: '2026-11-04T23:00:00.000Z',
      end: '2026-11-05T23:00:00.000Z',
    });
    const morning = event({
      id: 'm',
      start: '2026-11-05T08:00:00.000Z',
      end: '2026-11-05T09:00:00.000Z',
    });
    const [day] = upcomingDays([morning, allDay], 'Europe/Berlin', now);
    expect(day!.key).toBe('2026-11-05');
    expect(day!.events.map((e) => e.id)).toEqual(['all', 'm']);
  });

  it('flags overlaps, but not back-to-back, cancelled or all-day events', () => {
    const a = event({
      id: 'a',
      start: '2026-11-05T09:00:00.000Z',
      end: '2026-11-05T10:30:00.000Z',
    });
    const b = event({
      id: 'b',
      start: '2026-11-05T10:00:00.000Z',
      end: '2026-11-05T11:00:00.000Z',
    });
    const c = event({
      id: 'c',
      start: '2026-11-05T11:00:00.000Z',
      end: '2026-11-05T12:00:00.000Z',
    });
    const x = event({ id: 'x', status: 'cancelled', start: a.start, end: a.end });
    const map = conflicts([a, b, c, x]);
    expect(map.get(`${a.connectionId}:a`)?.map((e) => e.id)).toEqual(['b']);
    expect(map.get(`${a.connectionId}:c`)).toBeUndefined();
    expect(map.get(`${a.connectionId}:x`)).toBeUndefined();
  });

  it('shows a second time only for another zone with another wall-clock time', () => {
    expect(otherZone(event({ timeZone: 'America/New_York' }), 'Europe/Berlin')).toBe(
      'America/New_York',
    );
    expect(otherZone(event({ timeZone: 'Europe/Paris' }), 'Europe/Berlin')).toBeNull();
    expect(
      otherZone(event({ timeZone: 'America/New_York', allDay: true }), 'Europe/Berlin'),
    ).toBeNull();
    expect(dayKey('2026-11-04T23:30:00.000Z', 'UTC')).toBe('2026-11-04');
  });

  it('lists the calendars that could not answer', () => {
    expect(
      problemSources({
        sources: [
          { connectionId: 'a', provider: 'google', accountIdentifier: null, status: 'ok' },
          { connectionId: 'b', provider: 'microsoft', accountIdentifier: null, status: 'expired' },
        ],
      }).map((s) => s.connectionId),
    ).toEqual(['b']);
  });
});

/* ------------------------------------------------------------------ task results */

describe('Phase C task results', () => {
  it('reads the comparison from the previews: shipping from total − price, unstated stays null', () => {
    const view = comparisonView([
      step({
        toolId: 'shop.search',
        inputPreview: { query: 'FX-200' },
        output: {
          query: 'FX-200',
          offers: [
            { title: 'FX-200', merchant: 'Fixture Outlet', total: null, price: usd(13900) },
            { title: 'FX-200', merchant: 'Fixture Shop', total: usd(14900), price: usd(14900) },
          ],
          sites: [{ siteId: 'fixture-shop', status: 'ok', reason: null }],
        },
      }),
      step({
        toolId: 'shop.compare',
        output: {
          ranking: [
            { title: 'FX-200', merchant: 'Fixture Shop', total: usd(14900) },
            { title: 'FX-200', merchant: 'Fixture Outlet', total: null },
          ],
          best: { title: 'FX-200', merchant: 'Fixture Shop', total: usd(14900) },
          mixedCurrencies: false,
        },
      }),
    ]);
    expect(view?.detailed).toBe(false);
    expect(view?.rows.map((r) => r.merchant)).toEqual(['Fixture Shop', 'Fixture Outlet']);
    expect(view?.rows[0]!.shipping).toEqual(usd(0));
    expect(view?.rows[1]!.shipping).toBeNull();
    expect(view?.rows[1]!.total).toBeNull();
    expect(view?.bestKey).toBe(view?.rows[0]!.key);
    expect(view?.sites).toEqual([{ siteId: 'fixture-shop', status: 'ok', reason: null }]);
  });

  it('prefers the full ShoppingComparison when the output carries one', () => {
    const offer = {
      id: 'o1',
      siteId: 'fixture-shop',
      merchantName: 'Fixture Shop',
      merchantHost: '127.0.0.1:4599',
      title: 'FX-200',
      productUrl: 'javascript:alert(1)',
      price: usd(14900),
      shipping: null,
      total: null,
      delivery: { minDays: 1, maxDays: 2, text: null },
      inStock: true,
      rating: { value: 4.7, count: 1203 },
      signals: [{ code: 'https', present: true, value: null }],
      evidenceArtifactId: null,
      capturedAt: '2026-11-04T07:00:00.000Z',
    };
    const view = comparisonView([
      step({
        toolId: 'shop.compare',
        output: {
          comparison: {
            query: 'FX-200',
            offers: [offer],
            ranking: ['o1'],
            sites: [],
            mixedCurrencies: false,
            generatedAt: '2026-11-04T07:00:00.000Z',
          },
          bestOfferId: null,
        },
      }),
    ]);
    expect(view?.detailed).toBe(true);
    expect(view?.rows[0]!.delivery).toEqual({ minDays: 1, maxDays: 2, text: null });
    // A product URL from a page is followed only when it is http(s).
    expect(view?.rows[0]!.productUrl).toBeNull();
  });

  it('reads email threads, slots and a cart from their outputs', () => {
    const email = emailSearchView(
      step({
        toolId: 'email.search',
        inputPreview: { needsReply: true },
        output: { provider: 'google', count: 2, text: '2 conversation(s):' },
      }),
    );
    expect(email).toMatchObject({ needsReply: true, count: 2, threads: null, provider: 'google' });
    const slots = slotsView(
      step({
        toolId: 'booking.find_slots',
        output: {
          siteId: 'fixture-booking',
          service: 'Check-up',
          slotCount: 40,
          slots: [{ start: '2026-11-05T09:00:00.000Z', timeZone: 'Europe/Berlin' }, { start: 'x' }],
          requiredFields: ['Full name', 'Phone'],
          evidenceArtifactId: null,
        },
      }),
    );
    expect(slots?.slots).toHaveLength(1);
    expect(slots?.total).toBe(40);
    const cart = cartView(
      step({
        toolId: 'shop.prepare_cart',
        output: {
          merchant: 'Fixture Outlet',
          lines: [{ title: 'FX-10', quantity: 2, lineTotal: usd(7000) }],
          total: null,
          handoverUrl: 'http://127.0.0.1:4599/outlet/cart/c-1',
          checkoutSupported: false,
        },
      }),
    );
    expect(cart?.checkoutSupported).toBe(false);
    expect(cart?.handoverUrl).toBe('http://127.0.0.1:4599/outlet/cart/c-1');
  });

  it('names sites from the task itself, else from the recipe id', () => {
    const names = knownSiteNames({
      approvals: [],
      steps: [
        step({
          toolId: 'booking.find_slots',
          inputPreview: { siteId: 'fixture-booking' },
          titleMessage: { key: 'step.findSlots', params: { site: 'Fixture Dental' } },
        }),
      ],
    });
    expect(siteLabel('fixture-booking', names)).toBe('Fixture Dental');
    expect(siteLabel('fixture-shop', names)).toBe('Fixture Shop');
  });

  it('hands over only to an http(s) URL', () => {
    const base = {
      id: 's',
      taskId: 't',
      stepId: 'x',
      siteId: 'fixture-outlet',
      operation: 'read',
      stopReason: 'CAPTCHA_DETECTED' as const,
      navigations: 1,
      requests: 1,
      blockedRequests: 0,
      startedAt: null,
      endedAt: null,
      createdAt: '2026-11-04T07:00:00.000Z',
      artifacts: [],
    };
    expect(
      handoverOf([{ ...base, status: 'handover', handoverUrl: 'http://127.0.0.1:4599/captcha' }]),
    ).toEqual({
      url: 'http://127.0.0.1:4599/captcha',
      host: '127.0.0.1:4599',
      reason: 'CAPTCHA_DETECTED',
    });
    expect(handoverOf([{ ...base, status: 'handover', handoverUrl: 'javascript:x' }])).toBeNull();
    expect(handoverOf([{ ...base, status: 'failed', handoverUrl: null }])).toBeNull();
  });

  it('gives each Phase C failure its one next step', () => {
    expect(hasNextStep({ reason: 'CONNECTION_EXPIRED', params: { provider: 'microsoft' } })).toBe(
      'reconnect',
    );
    expect(hasNextStep({ reason: 'CONNECTION_EXPIRED', params: {} })).toBeNull();
    expect(
      hasNextStep({
        reason: 'CONNECTION_SCOPE_MISSING',
        params: { provider: 'google', capability: 'mail.send' },
      }),
    ).toBe('allow');
    expect(hasNextStep({ reason: 'CAPTCHA_DETECTED', params: { host: 'x' } })).toBe('handover');
    expect(hasNextStep({ reason: 'PURCHASES_DISABLED' })).toBe('limit');
    expect(hasNextStep({ reason: 'PURCHASE_LIMIT' })).toBe('limit');
    expect(hasNextStep({ reason: 'SITE_UNSUPPORTED' })).toBe('unsupported');
    expect(hasNextStep({ reason: 'PRIVATE_ADDRESS' })).toBeNull();
  });

  it('parses Phase C evidence codes into their own view', () => {
    const view = parseEvidence({
      kind: 'browser_capture',
      code: 'SCREENSHOT',
      label: 'Screenshot',
      value: 'x',
      at: '2026-11-04T07:00:00.000Z',
      params: { artifactId: 'cf000001-0000-4000-8000-000000000001', url: 'http://x', sha256: 'a' },
    });
    expect(view.kind).toBe('phaseC');
    expect(evidenceHref({ id: 'cf000001-0000-4000-8000-000000000001' })).toBe(
      '/api/v1/evidence/cf000001-0000-4000-8000-000000000001/content',
    );
    // Only the API's own evidence path is used, never another one.
    expect(
      evidenceHref({ id: 'cf000001-0000-4000-8000-000000000001', downloadPath: 'https://evil/x' }),
    ).toBe('/api/v1/evidence/cf000001-0000-4000-8000-000000000001/content');
  });
});

/* ------------------------------------------------------------------ approvals, spending, events */

describe('approvals, spending and events', () => {
  it('labels drafts as drafts and invitations as invitations', () => {
    expect(
      approvalLabelKind({ kind: 'email', mode: 'draft', from: '', to: [], subject: '', body: '' }),
    ).toBe('emailDraft');
    expect(approvalLabelKind({ kind: 'email', from: '', to: [], subject: '', body: '' })).toBe(
      'email',
    );
    expect(reasonKey('calendar_event', 'RECIPIENT_EXTERNAL')).toBe(
      'approvals.reasonsByKind.calendar_event.RECIPIENT_EXTERNAL',
    );
    expect(reasonKey('email', 'RECIPIENT_EXTERNAL')).toBe('approvals.reasons.RECIPIENT_EXTERNAL');
  });

  it('counts this month’s committed USD orders like the server', () => {
    const now = Date.parse('2026-11-04T08:00:00.000Z');
    // Berlin (UTC+1 in November): the month began at 2026-10-31T23:00Z.
    expect(new Date(monthStart(now, 'Europe/Berlin')).toISOString()).toBe(
      '2026-10-31T23:00:00.000Z',
    );
    const orders = [
      { status: 'placed' as const, total: usd(4498), createdAt: '2026-11-02T10:00:00.000Z' },
      { status: 'unknown' as const, total: usd(1000), createdAt: '2026-10-31T23:30:00.000Z' },
      { status: 'failed' as const, total: usd(9999), createdAt: '2026-11-02T10:00:00.000Z' },
      { status: 'placed' as const, total: usd(5000), createdAt: '2026-10-31T22:59:00.000Z' },
      {
        status: 'placed' as const,
        total: { amountMicro: 1, currency: 'EUR' },
        createdAt: '2026-11-02T10:00:00.000Z',
      },
    ];
    expect(committedThisMonth(orders, 'Europe/Berlin', now)).toEqual(usd(5498));
    // Paid bookings count too (migration 0006); free, failed and last month's do not.
    const bookings = [
      { status: 'confirmed' as const, price: usd(8000), createdAt: '2026-11-03T09:00:00.000Z' },
      { status: 'unknown' as const, price: usd(100), createdAt: '2026-11-03T09:00:00.000Z' },
      { status: 'failed' as const, price: usd(8000), createdAt: '2026-11-03T09:00:00.000Z' },
      { status: 'confirmed' as const, price: null, createdAt: '2026-11-03T09:00:00.000Z' },
      { status: 'confirmed' as const, price: usd(8000), createdAt: '2026-10-30T09:00:00.000Z' },
    ];
    expect(committedThisMonth(orders, 'Europe/Berlin', now, bookings)).toEqual(usd(5498 + 8100));
  });

  it('a browser session event refreshes only its task (never Home, lists or threads)', () => {
    expect(queriesToInvalidate({ type: 'browser_session.changed', taskId: 't' })).toEqual([
      qk.tasks.detail('t'),
    ]);
  });

  it('refreshes orders, bookings and watches when they change', () => {
    expect(queriesToInvalidate({ type: 'order.changed', taskId: 't' })).toContainEqual(
      qk.orders.all,
    );
    expect(queriesToInvalidate({ type: 'booking.changed', taskId: 't' })).toContainEqual(
      qk.bookings.all,
    );
    expect(queriesToInvalidate({ type: 'email_watch.changed', taskId: null })).toEqual([
      qk.emailWatches,
    ]);
    expect(queriesToInvalidate({ type: 'connection.changed', taskId: null })).toContainEqual(
      qk.calendar.all,
    );
  });
});
