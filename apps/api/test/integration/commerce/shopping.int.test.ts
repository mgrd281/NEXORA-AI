/**
 * Shopping end to end through the agent (offline planner, policy, approvals,
 * executor) with real Chromium against the fixture shops: scenario 3 (compare
 * across two merchants with sources and evidence), preparing a cart (and the
 * hand-over of a shop without checkout support), scenario 7 (purchases off by
 * default → PURCHASES_DISABLED; over the monthly limit → PURCHASE_LIMIT), a
 * purchase within the limit (HIGH approval with the exact order, placed exactly
 * once), scenario 10 (a replayed job, a checkout interrupted after submitting →
 * OUTCOME_UNKNOWN → acknowledged retry reconciles with the merchant: still one
 * order; a browser worker that died mid-checkout), PRICE_CHANGED and
 * OUT_OF_STOCK before anything is submitted.
 */
import type { ApprovalDetails, Preferences, ShoppingComparison } from '@jarvis/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type DbContext } from '../../../src/db/pool';
import { enqueue } from '../../../src/modules/jobs/queue';
import { auditActions, connectWeb, detail, drain, newUser } from '../agent/harness';
import { createBrowserHarness, sessionsOf, type BrowserHarness } from '../browser/harness';

let h: BrowserHarness;

beforeAll(async () => {
  h = await createBrowserHarness();
}, 60_000);
afterAll(() => h.close());
afterEach(async () => {
  for (const shop of ['shop', 'outlet']) await h.fixture.admin(`/${shop}/admin/reset`);
  h.browser.budgets = undefined;
});

const limit = (usd: number): Partial<Preferences> => ({
  spending: { monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: usd },
});

async function shopper(prefs?: Partial<Preferences>) {
  const user = await newUser(h.db, prefs);
  await connectWeb(h.db, user);
  return user;
}

async function submit(user: DbContext, request: string) {
  const s = await h.services.tasks.create(user, { request, source: 'text' }, {});
  await drain(h.worker);
  return detail(h.db, user, s.id);
}

async function pendingApproval(user: DbContext, taskId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('approvals')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('status', '=', 'PENDING')
      .executeTakeFirstOrThrow(),
  );
}

async function approve(user: DbContext, taskId: string) {
  const a = await pendingApproval(user, taskId);
  await h.services.approvals.decide(
    user,
    a.id,
    { decision: 'approve', actionHash: a.action_hash },
    'web',
  );
  await drain(h.worker);
  return { approval: a, task: await detail(h.db, user, taskId) };
}

const fixtureOrders = async () =>
  (await h.fixture.admin('/shop/admin/orders', 'GET')) as {
    orders: { id: string; key: string | null; total: number }[];
    checkoutAttempts: number;
  };

const ordersOf = (user: DbContext) =>
  withContext(h.db, user, (trx) =>
    trx.selectFrom('orders').selectAll().orderBy('created_at').execute(),
  );

describe('scenario 3: compare products across two merchants', () => {
  it('reads both shops live and ranks by price + shipping, with delivery times and sources', async () => {
    const user = await shopper();
    const d = await submit(user, 'Compare prices for FX-100 headphones');
    expect(d.status).toBe('COMPLETED');
    expect(d.titleMessage).toEqual({
      key: 'plan.compareProducts',
      params: { query: 'FX-100 headphones' },
    });
    expect(d.steps.map((s) => [s.toolId, s.status, s.requiresApproval])).toEqual([
      ['shop.search', 'SUCCEEDED', false],
      ['shop.compare', 'SUCCEEDED', false],
    ]);
    const compare = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_steps')
        .select('output')
        .where('task_id', '=', d.id)
        .where('tool_id', '=', 'shop.compare')
        .executeTakeFirstOrThrow(),
    );
    const comparison = (compare.output as { comparison: ShoppingComparison }).comparison;
    const byMerchant = Object.fromEntries(comparison.offers.map((o) => [o.merchantName, o]));
    expect(byMerchant['Fixture Shop']).toMatchObject({
      price: { amountMicro: 79_000_000, currency: 'USD' },
      shipping: { amountMicro: 4_990_000, currency: 'USD' },
      total: { amountMicro: 83_990_000, currency: 'USD' },
      delivery: { minDays: 2, maxDays: 4 },
      inStock: true,
    });
    expect(byMerchant['Fixture Outlet']).toMatchObject({
      price: { amountMicro: 74_500_000, currency: 'USD' },
      total: { amountMicro: 84_400_000, currency: 'USD' },
      delivery: { minDays: 5, maxDays: 8 },
    });
    // Cheaper sticker price at the outlet, but the lower known total (with shipping) wins.
    expect(comparison.offers.map((o) => o.merchantName)).toEqual([
      'Fixture Shop',
      'Fixture Outlet',
    ]);
    expect(comparison.sites).toEqual([
      { siteId: 'fixture-outlet', status: 'ok', reason: null },
      { siteId: 'fixture-shop', status: 'ok', reason: null },
    ]);
    expect(comparison.mixedCurrencies).toBe(false);
    // Reliability facts read from each merchant's page (the outlet publishes no legal notice).
    const legal = (m: string) =>
      byMerchant[m]!.signals.find((s) => s.code === 'legal_notice')!.present;
    expect([legal('Fixture Shop'), legal('Fixture Outlet')]).toEqual([true, false]);
    // Every offer has its source page and a screenshot of it.
    for (const o of comparison.offers) {
      expect(o.productUrl).toMatch(
        new RegExp(`^${h.fixture.origin}/(shop|outlet)/products/FX-100$`),
      );
      expect(o.evidenceArtifactId).toBeTruthy();
    }
    expect(d.resultSummary).toContain('FX-100 Wireless Headphones — Fixture Shop');
    expect(d.resultSummary).toContain('Total USD 83.99');
    expect(d.resultSummary).toContain(`Source: ${h.fixture.origin}/shop/products/FX-100`);
    const search = d.steps[0]!;
    expect(search.evidence.filter((e) => e.code === 'SCREENSHOT').length).toBeGreaterThanOrEqual(2);
    expect(search.evidence.filter((e) => e.code === 'PAGE_EXTRACT').length).toBe(2);
    const sessions = await sessionsOf(h, user, d.id);
    expect(sessions.map((s) => [s.site_id, s.operation, s.status]).sort()).toEqual([
      ['fixture-outlet', 'search', 'succeeded'],
      ['fixture-shop', 'search', 'succeeded'],
    ]);
  });
});

describe('carts', () => {
  it('a shop without checkout support: the prepared cart is handed over (nothing bought)', async () => {
    const user = await shopper();
    const waiting = await submit(user, 'Buy 2 FX-10 earbuds on Fixture Outlet');
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.steps.map((s) => s.toolId)).toEqual([
      'shop.search',
      'shop.compare',
      'shop.prepare_cart',
    ]);
    const { approval, task } = await approve(user, waiting.id);
    expect(approval.risk_level).toBe('MEDIUM');
    const fields = (approval.details as Extract<ApprovalDetails, { kind: 'generic' }>).fields;
    expect(fields).toEqual(
      expect.arrayContaining([
        { label: 'Item', value: 'FX-10 Wireless Earbuds' },
        { label: 'Quantity', value: '2' },
        { label: 'Price as seen', value: 'USD 35.00' },
      ]),
    );
    expect(task.status).toBe('COMPLETED');
    const cart = task.steps[2]!.output as {
      handoverUrl: string;
      checkoutSupported: boolean;
      total: unknown;
    };
    expect(cart.checkoutSupported).toBe(false);
    expect(cart.handoverUrl).toMatch(new RegExp(`^${h.fixture.origin}/outlet/cart/[0-9a-f]+$`));
    expect(task.resultSummaryMessage).toEqual({
      key: 'result.cartPrepared',
      params: { site: 'Fixture Outlet' },
    });
    expect((await ordersOf(user)).length).toBe(0);
  });
});

describe('scenario 7: unauthorized purchases are refused by the Policy Engine', () => {
  it('with the default limit (0) the purchase is refused at planning: PURCHASES_DISABLED, nothing runs', async () => {
    const user = await shopper();
    const d = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ code: 'POLICY_DENIED', reason: 'PURCHASES_DISABLED' });
    const checkout = d.steps.find((s) => s.toolId === 'shop.checkout')!;
    expect(checkout.status).toBe('BLOCKED');
    expect(checkout.policy.reasons).toContain('PURCHASES_DISABLED');
    expect(await sessionsOf(h, user, d.id)).toEqual([]); // not even a search ran
    expect((await fixtureOrders()).orders).toEqual([]);
  });

  it('over what is left of the monthly limit: PURCHASE_LIMIT with the amounts, no order anywhere', async () => {
    const user = await shopper(limit(50));
    const waiting = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    expect(waiting.status).toBe('AWAITING_APPROVAL'); // the amount is only known from the live cart
    const { task } = await approve(user, waiting.id); // the cart (MEDIUM)
    expect(task.status).toBe('FAILED');
    expect(task.error).toMatchObject({
      code: 'POLICY_DENIED',
      reason: 'PURCHASE_LIMIT',
      params: { limit: 'USD 50.00', spent: 'USD 0.00', amount: 'USD 83.99' },
    });
    expect(task.steps.find((s) => s.toolId === 'shop.checkout')!.status).toBe('BLOCKED');
    expect(await ordersOf(user)).toEqual([]);
    expect((await fixtureOrders()).orders).toEqual([]);
  });
});

describe('a purchase within the limit', () => {
  it('asks with the exact order (HIGH, PURCHASE), then places it exactly once', async () => {
    const user = await shopper(limit(200));
    const waiting = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    const cartStep = await approve(user, waiting.id);
    expect(cartStep.task.status).toBe('AWAITING_APPROVAL');
    const purchase = await pendingApproval(user, waiting.id);
    expect(purchase.risk_level).toBe('HIGH');
    expect(purchase.reasons).toEqual(expect.arrayContaining(['RISK_HIGH', 'PURCHASE']));
    expect(purchase.reasons).not.toContain('AUTO_APPROVED_SELF');
    const details = purchase.details as Extract<ApprovalDetails, { kind: 'purchase' }>;
    expect(details).toMatchObject({
      kind: 'purchase',
      siteId: 'fixture-shop',
      merchant: { name: 'Fixture Shop', host: `127.0.0.1:${h.fixture.port}` },
      items: [
        {
          title: 'FX-100 Wireless Headphones',
          quantity: 1,
          unitPrice: { amountMicro: 79_000_000, currency: 'USD' },
          lineTotal: { amountMicro: 79_000_000, currency: 'USD' },
          productUrl: `${h.fixture.origin}/shop/products/FX-100`,
        },
      ],
      subtotal: { amountMicro: 79_000_000, currency: 'USD' },
      shipping: { amountMicro: 4_990_000, currency: 'USD' },
      total: { amountMicro: 83_990_000, currency: 'USD' },
      delivery: {
        method: 'Standard shipping',
        estimate: '2–4 business days',
        address: 'Alex Example, 12 Sample Road, 10115 Fixture City',
      },
      paymentMethod: 'Visa •••• 4242',
      limit: {
        monthly: { amountMicro: 200_000_000, currency: 'USD' },
        spentThisMonth: { amountMicro: 0, currency: 'USD' },
        remainingAfter: { amountMicro: 116_010_000, currency: 'USD' },
      },
    });
    expect(details.evidenceArtifactId).toBeTruthy();
    expect(purchase.summary_message).toEqual({
      key: 'approval.purchase',
      params: { total: 'USD 83.99', merchant: 'Fixture Shop' },
    });

    const { task } = await approve(user, waiting.id);
    expect(task.status).toBe('COMPLETED');
    expect(task.resultSummaryMessage).toEqual({
      key: 'result.orderPlaced',
      params: { merchant: 'Fixture Shop', orderId: 'FS-1001' },
    });
    const checkout = task.steps.find((s) => s.toolId === 'shop.checkout')!;
    expect(checkout.evidence.find((e) => e.code === 'ORDER_CONFIRMATION')?.params).toMatchObject({
      merchantOrderId: 'FS-1001',
      total: 'USD 83.99',
    });
    const [order] = await ordersOf(user);
    expect(order).toMatchObject({
      status: 'placed',
      merchant_order_id: 'FS-1001',
      total_micro: 83_990_000,
      currency: 'USD',
      idempotency_key: `order:${checkout.id}`,
      approval_id: purchase.id,
      action_hash: purchase.action_hash,
    });
    expect(order!.confirmation_artifact_id).toBeTruthy();
    const shop = await fixtureOrders();
    expect(shop.orders).toEqual([
      expect.objectContaining({ id: 'FS-1001', key: `order:${checkout.id}`, total: 8399 }),
    ]);
    expect(await auditActions(user.userId)).toContain('order.placed');
    // It now counts against the month (committed_purchases, RLS-scoped).
    const committed = await withContext(h.db, user, (trx) =>
      trx.selectFrom('committed_purchases').select(['total_micro', 'status']).execute(),
    );
    expect(committed).toEqual([{ total_micro: 83_990_000, status: 'placed' }]);

    // Scenario 10 — a replayed execute job and a replayed browser job change nothing.
    await withContext(h.db, user, (trx) =>
      enqueue(trx, {
        kind: 'task.execute',
        tenantId: user.tenantId,
        userId: user.userId,
        taskId: task.id,
        dedupeKey: `exec:${task.id}`,
      }),
    );
    const checkoutSession = (await sessionsOf(h, user, task.id)).find(
      (s) => s.operation === 'checkout',
    )!;
    await withContext(h.db, user, (trx) =>
      enqueue(trx, {
        kind: 'browser.session',
        tenantId: user.tenantId,
        userId: user.userId,
        taskId: task.id,
        payload: { sessionId: checkoutSession.id },
        dedupeKey: `browser:${checkoutSession.id}`,
      }),
    );
    await drain(h.worker);
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await fixtureOrders()).orders).toHaveLength(1);
    expect((await fixtureOrders()).checkoutAttempts).toBe(1);
    expect(await ordersOf(user)).toHaveLength(1);
    expect((await detail(h.db, user, task.id)).status).toBe('COMPLETED');
  });

  it('a changed price stops before submitting (PRICE_CHANGED), nothing is ordered', async () => {
    const user = await shopper(limit(200));
    const waiting = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    await approve(user, waiting.id); // cart at USD 83.99
    await h.fixture.admin('/shop/admin/price?sku=FX-100&price=89.00');
    const { task } = await approve(user, waiting.id);
    expect(task.status).toBe('FAILED');
    expect(task.error).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'PRICE_CHANGED',
      retryable: false,
      params: { expected: 'USD 83.99', actual: 'USD 93.99' },
    });
    expect((await ordersOf(user)).map((o) => [o.status, o.failure_reason])).toEqual([
      ['failed', 'PRICE_CHANGED'],
    ]);
    expect((await fixtureOrders()).orders).toEqual([]);
    expect((await fixtureOrders()).checkoutAttempts).toBe(0);
  });

  it('an item out of stock stops before submitting (OUT_OF_STOCK)', async () => {
    const user = await shopper(limit(200));
    const waiting = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    await approve(user, waiting.id);
    await h.fixture.admin('/shop/admin/stock?sku=FX-100&inStock=false');
    const { task } = await approve(user, waiting.id);
    expect(task.error).toMatchObject({ reason: 'OUT_OF_STOCK' });
    expect((await ordersOf(user)).map((o) => o.status)).toEqual(['failed']);
    expect((await fixtureOrders()).checkoutAttempts).toBe(0);
  });
});

describe('scenario 10: no duplicate order after an interrupted checkout', () => {
  it('interrupted after submitting → OUTCOME_UNKNOWN; the acknowledged retry finds the order at the merchant', async () => {
    const user = await shopper(limit(500));
    const waiting = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    await approve(user, waiting.id);
    // The merchant takes the order but answers too late for the session's budget.
    await h.fixture.admin('/shop/admin/mode?checkout=slow&slowMs=30000');
    h.browser.budgets = { sessionTimeoutMs: 6_000 };
    const { task } = await approve(user, waiting.id);
    expect(task.status).toBe('FAILED');
    expect(task.error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      reason: 'ORDER_UNKNOWN',
      retryable: false,
    });
    const checkout = task.steps.find((s) => s.toolId === 'shop.checkout')!;
    expect((await ordersOf(user)).map((o) => [o.status, o.failure_reason])).toEqual([
      ['unknown', 'ORDER_UNKNOWN'],
    ]);
    const sessions = await sessionsOf(h, user, task.id);
    expect(sessions.find((s) => s.operation === 'checkout')!.status).toBe('interrupted');
    expect((await fixtureOrders()).orders).toHaveLength(1); // it did go through at the merchant
    // An unknown order counts against the month until resolved.
    const committed = await withContext(h.db, user, (trx) =>
      trx.selectFrom('committed_purchases').select('status').execute(),
    );
    expect(committed).toEqual([{ status: 'unknown' }]);

    await h.fixture.admin('/shop/admin/mode?checkout=ok');
    h.browser.budgets = undefined;
    await expect(
      h.services.tasks.retry(user, task.id, { acknowledgeUnknownOutcome: false }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await h.services.tasks.retry(user, task.id, { acknowledgeUnknownOutcome: true });
    await drain(h.worker);
    const done = await detail(h.db, user, task.id);
    expect(done.status).toBe('COMPLETED');
    expect(
      (done.steps.find((s) => s.id === checkout.id)!.output as { reconciled: boolean }).reconciled,
    ).toBe(true);
    const shop = await fixtureOrders();
    expect(shop.orders).toHaveLength(1); // exactly one order at the merchant
    expect(shop.checkoutAttempts).toBe(1); // and it was submitted once
    const orders = await ordersOf(user);
    expect(orders.map((o) => [o.status, o.merchant_order_id])).toEqual([
      ['placed', shop.orders[0]!.id],
    ]);
    const lookups = (await sessionsOf(h, user, task.id)).filter(
      (s) => s.operation === 'order_lookup',
    );
    expect(lookups.map((s) => s.status)).toEqual(['succeeded']);
  });

  it('a browser worker that died mid-checkout leaves the order unknown, never submitted twice', async () => {
    const user = await shopper(limit(500));
    const waiting = await submit(user, 'Buy the FX-100 headphones on Fixture Shop');
    await approve(user, waiting.id);
    // The browser worker "dies" as soon as it starts the checkout: it is paused right after
    // marking the session running, and its lease expires.
    h.pauseBrowser(true);
    const a = await pendingApproval(user, waiting.id);
    await h.services.approvals.decide(
      user,
      a.id,
      { decision: 'approve', actionHash: a.action_hash },
      'web',
    );
    const agent = drain(h.worker);
    let session;
    for (let i = 0; i < 100 && !session; i++) {
      await new Promise((r) => setTimeout(r, 100));
      session = (await sessionsOf(h, user, waiting.id)).find((s) => s.operation === 'checkout');
    }
    expect(session!.status).toBe('queued');
    // State a crashed worker leaves: the session running, its job leased by a dead worker.
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('browser_sessions')
        .set({ status: 'running', started_at: new Date(), worker_id: 'browser:dead' })
        .where('id', '=', session!.id)
        .execute(),
    );
    await h.db
      .updateTable('jobs')
      .set({
        status: 'running',
        locked_by: 'browser:dead',
        locked_until: new Date(Date.now() - 1_000),
        attempts: 1,
      })
      .where('dedupe_key', '=', `browser:${session!.id}`)
      .execute();
    h.pauseBrowser(false);
    const { reclaimBrowserOnce } = await import('../../../src/browser-worker');
    await reclaimBrowserOnce(h.browser);
    await agent;
    const d = await detail(h.db, user, waiting.id);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ code: 'OUTCOME_UNKNOWN', reason: 'ORDER_UNKNOWN' });
    expect((await sessionsOf(h, user, waiting.id)).find((s) => s.id === session!.id)!.status).toBe(
      'interrupted',
    );
    expect((await ordersOf(user)).map((o) => o.status)).toEqual(['unknown']);
    expect((await fixtureOrders()).checkoutAttempts).toBe(0); // the reclaimed binding session was never re-run
  });
});
