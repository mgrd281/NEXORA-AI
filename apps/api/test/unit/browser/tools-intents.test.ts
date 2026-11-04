/**
 * Browser + commerce tools and offline intents without a browser or database:
 * the recipe registry (enabled only where configured, never fixtures in
 * production), deterministic ranking, planning rules (no invented offers,
 * slots, quantities or orders; no checkout where the recipe cannot order),
 * the facts the tools declare to the Policy Engine (purchase, binding) and
 * the decisions it takes on them, and the en/de/ar offline intents.
 */
import {
  DEFAULT_PREFERENCES,
  type ConnectionProvider,
  type Preferences,
  type ProductOffer,
} from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '../../../src/db/types';
import { enabledOrigins, recipesNamedIn, RECIPES } from '../../../src/modules/browser/sites';
import type { AgentContext } from '../../../src/modules/agent/context';
import { planOffline } from '../../../src/modules/agent/models/offline';
import { validatePlan } from '../../../src/modules/agent/plan';
import { assessStep } from '../../../src/modules/agent/step-policy';
import { browserTools } from '../../../src/modules/agent/tools/browser';
import { matchesQuery, rankOffers } from '../../../src/modules/agent/tools/browser/shop-compare';
import { getTool, TOOLS } from '../../../src/modules/agent/tools/registry';
import {
  parseDate,
  parsePhone,
  parseTime,
  nameFromAnswer,
} from '../../../src/modules/agent/intents/browser/parse';
import { testConfigUnit } from '../agent/support';

const OWN = 'me@example.com';

function agent(spending?: Preferences['spending'], spentMicro = 0): AgentContext {
  const connections = new Map<ConnectionProvider, ConnectionRow>([['web', {} as ConnectionRow]]);
  const preferences: Preferences = { ...DEFAULT_PREFERENCES, ...(spending ? { spending } : {}) };
  return {
    account: {
      userId: 'u',
      tenantId: 't',
      email: OWN,
      displayName: 'Me',
      locale: 'en',
      timeZone: 'Europe/Berlin',
    },
    preferences,
    connections,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    route: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
    connectionStates: [
      {
        connectionId: 'w',
        provider: 'web',
        status: 'active',
        capabilities: [],
        accountIdentifier: null,
      },
    ],
    purchases: { limitMicro: preferences.spending.monthlyPurchaseLimitUsd * 1_000_000, spentMicro },
  };
}

const config = testConfigUnit();
const usd = (n: number) => ({ amountMicro: Math.round(n * 1_000_000), currency: 'USD' });

function offer(over: Partial<ProductOffer>): ProductOffer {
  return {
    id: 'x.0',
    siteId: 'fixture-shop',
    merchantName: 'Fixture Shop',
    merchantHost: 'shop.test',
    title: 'FX-100 Wireless Headphones',
    productUrl: 'http://shop.test/shop/products/FX-100',
    price: usd(79),
    shipping: usd(4.99),
    total: usd(83.99),
    delivery: { minDays: 2, maxDays: 4, text: null },
    inStock: true,
    rating: null,
    signals: [],
    evidenceArtifactId: null,
    capturedAt: new Date().toISOString(),
    ...over,
  };
}

describe('recipe registry', () => {
  it('registers the eight browser + commerce tools, each in the tool registry', () => {
    expect(browserTools.map((t) => t.id).sort()).toEqual([
      'booking.book',
      'booking.find_slots',
      'browser.fill',
      'browser.read',
      'shop.checkout',
      'shop.compare',
      'shop.prepare_cart',
      'shop.search',
    ]);
    for (const t of browserTools) expect(getTool(t.id)).toBe(t);
  });

  it('fixture recipes exist only with BROWSER_FIXTURE_ORIGIN, never in production; BROWSER_SITES narrows', () => {
    const none = { isProduction: false, BROWSER_FIXTURE_ORIGIN: undefined, browserSites: null };
    const dev = {
      isProduction: false,
      BROWSER_FIXTURE_ORIGIN: 'http://127.0.0.1:4601',
      browserSites: null,
    };
    expect(enabledOrigins(none, 'fixture-shop')).toBeNull();
    expect(enabledOrigins(none, 'schema-org')).toBeNull();
    expect(enabledOrigins(dev, 'fixture-shop')).toEqual(['http://127.0.0.1:4601']);
    expect(enabledOrigins(dev, 'schema-org')).toEqual(['http://127.0.0.1:4601']);
    expect(enabledOrigins({ ...dev, isProduction: true }, 'fixture-booking')).toBeNull();
    expect(
      enabledOrigins({ ...dev, browserSites: new Set(['fixture-booking']) }, 'fixture-shop'),
    ).toBeNull();
    expect(enabledOrigins(dev, 'not-a-recipe')).toBeNull();
    expect(RECIPES.every((r) => r.operations.read)).toBe(true);
  });

  it('finds the sites a request names (registered names and aliases, whole words)', () => {
    expect(recipesNamedIn('compare on Fixture Shop and fixture outlet').map((r) => r.id)).toEqual([
      'fixture-shop',
      'fixture-outlet',
    ]);
    expect(recipesNamedIn('book at Fixture Dental').map((r) => r.id)).toEqual(['fixture-booking']);
    expect(recipesNamedIn('buy it at the fixtureshopping mall')).toEqual([]);
  });
});

describe('shop.compare ranking (deterministic)', () => {
  it('lowest known total first; unknown shipping after known totals; out of stock last', () => {
    const a = offer({ id: 'a', total: usd(83.99) });
    const b = offer({
      id: 'b',
      price: usd(74.5),
      total: usd(84.4),
      delivery: { minDays: 5, maxDays: 8, text: null },
    });
    const c = offer({ id: 'c', price: usd(60), shipping: null, total: null });
    const d = offer({ id: 'd', price: usd(10), total: usd(15), inStock: false });
    expect(rankOffers([c, d, b, a], 'total').map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rankOffers([a, b], 'delivery').map((o) => o.id)).toEqual(['a', 'b']);
    const fast = offer({
      id: 'fast',
      total: usd(99),
      delivery: { minDays: 1, maxDays: 1, text: null },
    });
    expect(rankOffers([a, fast], 'delivery').map((o) => o.id)).toEqual(['fast', 'a']);
  });

  it('only the product the query names can be the best offer (model numbers)', () => {
    expect(matchesQuery('FX-100 headphones', 'FX-100 Wireless Headphones')).toBe(true);
    expect(matchesQuery('FX-100 headphones', 'FX-200 Noise-Cancelling Headphones')).toBe(false);
    expect(matchesQuery('سماعات FX-100', 'FX-100 Wireless Headphones')).toBe(true);
    expect(matchesQuery('headphones', 'FX-200 Noise-Cancelling Headphones')).toBe(true);
  });
});

describe('planning rules: nothing a page or the planner could invent', () => {
  const t = (id: string) => getTool(id)!;
  it('offers, slots and orders come only by reference; details and quantities literally', () => {
    expect(
      t('shop.prepare_cart').validatePlanned!({
        siteId: 'fixture-shop',
        offer: { title: 'x' },
        quantity: 1,
      }),
    ).toEqual([expect.stringContaining('must be a reference')]);
    expect(
      t('shop.prepare_cart').validatePlanned!({
        siteId: 'fixture-shop',
        offer: '{{s2.bestOffer}}',
        quantity: 1,
      }),
    ).toEqual([]);
    expect(
      t('shop.checkout').validatePlanned!({
        siteId: 'fixture-shop',
        order: '{{s3.checkoutDetails}}',
      }),
    ).toEqual([]);
    expect(
      t('shop.checkout').validatePlanned!({
        siteId: 'fixture-outlet',
        order: '{{s3.checkoutDetails}}',
      }),
    ).toEqual([expect.stringContaining('does not support ordering')]);
    expect(
      t('booking.book').validatePlanned!({
        siteId: 'fixture-booking',
        slot: '{{s1.firstSlot}}',
        details: { Phone: '{{s1.text}}' },
      }),
    ).toEqual([expect.stringContaining('never references')]);
    expect(
      t('booking.book').validatePlanned!({
        siteId: 'fixture-booking',
        slot: '{{s1.firstSlot}}',
        details: { Shoe: '42' },
      }),
    ).toEqual([expect.stringContaining('has no field "Shoe"')]);
    expect(t('shop.search').validatePlanned!({ query: '{{s1.text}}' })).toHaveLength(1);
    expect(
      t('shop.compare').validatePlanned!({ searchIds: ['0d5c…'], preference: 'total' }),
    ).toHaveLength(1);
    expect(
      t('browser.read').validatePlanned!({ siteId: 'unknown-site', url: 'https://x.test/' }),
    ).toEqual([expect.stringContaining('not a supported site')]);
    // A quantity is a literal number: a reference does not even pass the schema.
    expect(
      t('shop.prepare_cart').inputSchema.safeParse({
        siteId: 'fixture-shop',
        offer: '{{s2.bestOffer}}',
        quantity: '{{s1.n}}',
      }).success,
    ).toBe(false);
  });
});

describe('the Policy Engine decides on the facts the tools declare', () => {
  const checkout = getTool('shop.checkout')!;
  const order = {
    cartSessionId: '0b8d5b3e-8f0b-4d55-9c0f-6a1d1d6c1a11',
    cartId: 'abc',
    siteId: 'fixture-shop',
    merchantName: 'Fixture Shop',
    merchantHost: 'shop.test',
    lines: [
      {
        title: 'FX-100',
        quantity: 1,
        unitPrice: usd(79),
        lineTotal: usd(79),
        productUrl: 'http://shop.test/p',
      },
    ],
    subtotal: usd(79),
    shipping: usd(4.99),
    tax: null,
    total: usd(83.99),
    delivery: { method: 'Standard', estimate: null, address: 'A' },
    paymentMethod: 'Visa',
    evidenceArtifactId: null,
  };
  const resolved = checkout.inputSchema.parse({
    siteId: 'fixture-shop',
    order: JSON.stringify(order),
  });

  it('scenario 7: purchases off by default → deny PURCHASES_DISABLED, already at planning', () => {
    const planned = assessStep(
      checkout,
      { siteId: 'fixture-shop', order: '{{s3.checkoutDetails}}' },
      agent(),
      config,
    );
    expect(planned.policy.decision).toBe('deny');
    expect(planned.policy.reasons).toContain('PURCHASES_DISABLED');
  });

  it('over the limit → deny PURCHASE_LIMIT with the amounts; within → HIGH approval with PURCHASE', () => {
    const over = assessStep(
      checkout,
      resolved,
      agent({ monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: 100 }, 50_000_000),
      config,
    );
    expect(over.policy).toMatchObject({
      decision: 'deny',
      reasons: ['PURCHASE_LIMIT'],
      denyParams: { limit: 'USD 100.00', spent: 'USD 50.00', amount: 'USD 83.99' },
    });
    const within = assessStep(
      checkout,
      resolved,
      agent({ monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: 200 }),
      config,
    );
    expect(within.risk).toBe('HIGH');
    expect(within.policy.decision).toBe('require_approval');
    expect(within.policy.reasons).toEqual(expect.arrayContaining(['RISK_HIGH', 'PURCHASE']));
  });

  it('a binding, paid booking is HIGH with BINDING_COMMITMENT and the purchase rules', () => {
    const book = getTool('booking.book')!;
    const slot = {
      sessionId: '0b8d5b3e-8f0b-4d55-9c0f-6a1d1d6c1a11',
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      siteHost: 'x',
      serviceId: 'cleaning',
      service: 'Dental cleaning',
      slot: {
        id: 'cleaning-20261110-1000',
        start: '2026-11-10T09:00:00.000Z',
        end: null,
        timeZone: 'Europe/Berlin',
        service: 'Dental cleaning',
        price: usd(80),
      },
      binding: true,
      cancellationTerms: 'fees',
      requiredFields: [],
      evidenceArtifactId: null,
    };
    const input = book.inputSchema.parse({
      siteId: 'fixture-booking',
      slot: JSON.stringify(slot),
      details: { 'Full name': 'A' },
    });
    const off = assessStep(book, input, agent(), config);
    expect(off.policy.reasons).toContain('PURCHASES_DISABLED');
    const on = assessStep(
      book,
      input,
      agent({ monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: 200 }),
      config,
    );
    expect(on.risk).toBe('HIGH');
    expect(on.policy.reasons).toEqual(
      expect.arrayContaining(['RISK_HIGH', 'BINDING_COMMITMENT', 'PURCHASE']),
    );
    const free = book.inputSchema.parse({
      siteId: 'fixture-booking',
      slot: JSON.stringify({ ...slot, binding: false, slot: { ...slot.slot, price: null } }),
      details: { 'Full name': 'A' },
    });
    const freeA = assessStep(book, free, agent(), config);
    expect(freeA.risk).toBe('MEDIUM');
    expect(freeA.policy.decision).toBe('require_approval');
  });
});

describe('offline intents (en/de/ar)', () => {
  const ctx = (language: 'en' | 'de' | 'ar' = 'en', extra = {}) => ({
    language,
    ownEmail: OWN,
    timeZone: 'Europe/Berlin',
    browserAvailable: true,
    ...extra,
  });
  const tools = (r: ReturnType<typeof planOffline>) =>
    r.ok ? r.plan.steps.map((s) => s.toolId) : r.reason;
  const valid = (request: string, r: ReturnType<typeof planOffline>) => {
    if (!r.ok) throw new Error('no plan');
    const v = validatePlan(r.plan, { tools: TOOLS, requests: [request], ownEmail: OWN });
    if (!v.ok) throw new Error(v.issues.join('; '));
    return v.plan;
  };

  it('compare (scenario 3) in en/de/ar → shop.search → shop.compare', () => {
    for (const [lang, req] of [
      ['en', 'Compare prices for FX-100 headphones'],
      ['de', 'Vergleiche die Preise für FX-100 Kopfhörer'],
      ['ar', 'قارن أسعار سماعات FX-100'],
    ] as const) {
      const r = planOffline(req, ctx(lang));
      expect(tools(r)).toEqual(['shop.search', 'shop.compare']);
      const plan = valid(req, r);
      expect(plan.titleMessage?.key).toBe('plan.compareProducts');
    }
    const named = planOffline(
      'compare the prices of FX-100 headphones on Fixture Shop and Fixture Outlet',
      ctx(),
    );
    expect(named.ok && named.plan.steps[0]!.input).toEqual({
      query: 'FX-100 headphones',
      siteIds: ['fixture-shop', 'fixture-outlet'],
    });
  });

  it('buy on a named shop → search → compare → cart → checkout (quantity literal); no shop → ask', () => {
    const req = 'Buy 2 FX-100 headphones on Fixture Shop';
    const r = planOffline(req, ctx());
    expect(tools(r)).toEqual(['shop.search', 'shop.compare', 'shop.prepare_cart', 'shop.checkout']);
    const plan = valid(req, r);
    expect(plan.steps[2]!.input).toEqual({
      siteId: 'fixture-shop',
      offer: '{{s2.bestOffer}}',
      quantity: 2,
    });
    expect(plan.titleMessage).toEqual({
      key: 'plan.buy',
      params: { product: 'FX-100 headphones', site: 'Fixture Shop' },
    });
    // A shop that cannot order: the prepared cart is the end (handed over).
    expect(tools(planOffline('Kaufe FX-10 Ohrhörer bei Fixture Outlet', ctx('de')))).toEqual([
      'shop.search',
      'shop.compare',
      'shop.prepare_cart',
    ]);
    expect(tools(planOffline('اشترِ سماعات FX-100 من Fixture Shop', ctx('ar')))).toHaveLength(4);
    const ask = planOffline('Buy a new laptop with my saved credit card', ctx());
    expect(ask.ok && ask.plan.steps[0]!.input).toEqual({ missing: ['site'] });
  });

  it('booking: list live slots, or book a named time with the details the user gave; ask for what is missing', () => {
    expect(tools(planOffline('Book a check-up at Fixture Dental', ctx()))).toEqual([
      'booking.find_slots',
    ]);
    const req =
      'Book a check-up at Fixture Dental on 2026-11-12 at 10:00 for Alex Example, phone +49 30 1234567';
    const plan = valid(req, planOffline(req, ctx()));
    expect(plan.steps.map((s) => s.input)).toEqual([
      {
        siteId: 'fixture-booking',
        service: 'Check-up',
        from: '2026-11-12',
        to: '2026-11-12',
        at: '10:00',
      },
      {
        siteId: 'fixture-booking',
        slot: '{{s1.firstSlot}}',
        details: { 'Full name': 'Alex Example', Email: OWN, Phone: '+49 30 1234567' },
      },
    ]);
    const de = planOffline(
      'Buche eine Kontrolle bei Fixture Dental am 12. November um 10 Uhr für Alex Example, Telefon 030 1234567',
      ctx('de'),
    );
    expect(tools(de)).toEqual(['booking.find_slots', 'booking.book']);
    const ar = planOffline(
      'احجز فحص في Fixture Dental غدا الساعة 10 باسم أليكس مثال هاتف +49 30 1234567',
      ctx('ar'),
    );
    expect(tools(ar)).toEqual(['booking.find_slots', 'booking.book']);
    expect(ar.ok && ar.plan.steps[1]!.input.details).toMatchObject({
      'Full name': 'أليكس مثال',
      Phone: '+49 30 1234567',
    });
    const noDetails = planOffline('Book a check-up at Fixture Dental tomorrow at 10am', ctx());
    expect(noDetails.ok && noDetails.plan.steps[0]!.input).toEqual({
      missing: ['contact_details'],
    });
    const noSite = planOffline('Book an appointment at the dentist', ctx());
    expect(noSite.ok && noSite.plan.steps[0]!.input).toEqual({ missing: ['site'] });
    // With a calendar that grants calendar.write, the confirmation is also saved there.
    const withCal = planOffline(
      req,
      ctx('en', {
        connections: [
          {
            connectionId: 'g',
            provider: 'google',
            status: 'active',
            capabilities: ['calendar.write'],
            accountIdentifier: OWN,
          },
        ],
      }),
    );
    expect(tools(withCal)).toEqual(['booking.find_slots', 'booking.book', 'calendar.create_event']);
    expect(withCal.ok && withCal.plan.steps[2]!.input).toMatchObject({
      sourceBookingId: '{{s2.bookingId}}',
      start: '{{s2.start}}',
    });
  });

  it('answers to the booking questions complete the request', () => {
    const turns = [
      {
        taskId: 't1',
        request: 'Book a check-up at Fixture Dental on 2026-11-12 at 10:00',
        status: 'COMPLETED' as const,
        outcome: 'question' as const,
        title: 'Question',
        resultText: null,
        flagged: false,
        recallable: false,
        missing: ['contact_details' as const],
      },
    ];
    const r = planOffline('Alex Example, +49 30 1234567', ctx('en', { conversation: turns }));
    expect(tools(r)).toEqual(['booking.find_slots', 'booking.book']);
    expect(r.ok && r.plan.steps[1]!.input.details).toEqual({
      'Full name': 'Alex Example',
      Email: OWN,
      Phone: '+49 30 1234567',
    });
  });

  it('phrase parsing', () => {
    const now = new Date('2026-11-04T10:00:00Z'); // a Wednesday
    expect(parseDate('tomorrow', 'Europe/Berlin', now)).toBe('2026-11-05');
    expect(parseDate('on Wednesday', 'Europe/Berlin', now)).toBe('2026-11-11');
    expect(parseDate('am 12. November', 'Europe/Berlin', now)).toBe('2026-11-12');
    expect(parseDate('on 3 March', 'Europe/Berlin', now)).toBe('2027-03-03');
    expect(parseDate('nothing', 'Europe/Berlin', now)).toBeNull();
    expect(parseTime('at 10am')).toBe('10:00');
    expect(parseTime('3:30 pm')).toBe('15:30');
    expect(parseTime('um 10 Uhr')).toBe('10:00');
    expect(parseTime('الساعة ١٠')).toBe('10:00');
    expect(parseTime('on 2026-11-12')).toBeNull();
    expect(parsePhone('call +49 30 1234567 please')).toBe('+49 30 1234567');
    expect(parsePhone('at 10:00 on 2026-11-12')).toBeNull();
    expect(nameFromAnswer('Alex Example, +49 30 1234567')).toBe('Alex Example');
    expect(nameFromAnswer('+49 30 1234567')).toBeNull();
  });
});
