/**
 * shop.checkout — place the order for a prepared cart, exactly once
 * (scenarios 7 and 10; docs/adr/0018, docs/architecture/phase-c.md §3.6).
 *
 * HIGH. The order comes only by reference from shop.prepare_cart
 * (`{{sN.checkoutDetails}}`: the cart exactly as the merchant's checkout
 * showed it), checked again against this task's own cart session.
 * `purchase(input)` declares the amount, so the Policy Engine — not this tool —
 * decides: purchases off (limit 0, the default) → PURCHASES_DISABLED; another
 * currency → PURCHASE_CURRENCY; over the month's limit → PURCHASE_LIMIT;
 * otherwise an approval of kind 'purchase' showing every item, quantity, the
 * totals, merchant, delivery, payment method and the limit — never
 * auto-approved, and bound by the action hash to exactly this order.
 *
 * Exactly once: the orders row (key order:<step id>, also the merchant's
 * Idempotency-Key) is inserted before submitting; the live checkout is
 * re-read first (a different total or line → PRICE_CHANGED, out of stock →
 * OUT_OF_STOCK: nothing ordered). An interruption after submission started is
 * OUTCOME_UNKNOWN (ORDER_UNKNOWN) and the order row 'unknown' (it counts
 * against the limit); a retry the user acknowledged first looks the key up at
 * the merchant and records the order found there instead of submitting again.
 * Only recipes that declare checkout support can order (the fixture shop);
 * other shops hand over the prepared cart (CHECKOUT_UNSUPPORTED).
 */
import { moneyParam, type Money } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../../db/pool';
import type { CartLineJson, OrderRow } from '../../../../db/types';
import { hashObject } from '../../../../lib/crypto';
import { runBrowserSession, sessionsOfTask } from '../../../browser/client';
import { getRecipe } from '../../../browser/sites';
import type {
  ShopCartOutput,
  ShopCheckoutOutput,
  ShopLookupOutput,
} from '../../../browser/sites/fixture-shop';
import {
  finalizeOrder,
  orderKey,
  reserveOrder,
  restartOrder,
  type OrderFacts,
} from '../../../commerce/orders';
import { AgentError } from '../../errors';
import { msg, render } from '../../i18n';
import { check, evidence, type ToolDefinition } from '../types';
import {
  approvedAction,
  artifactEvidence,
  enabledRecipe,
  isRef,
  outcomeError,
  plannedRecipe,
  refOr,
  SiteId,
} from './common';
import { CheckoutDetails } from './shop-prepare-cart';

export const ShopCheckoutInput = z.object({
  siteId: SiteId,
  order: refOr(
    CheckoutDetails,
    'The order to place: a reference to shop.prepare_cart output checkoutDetails, e.g. {{s3.checkoutDetails}}. Never written out.',
  ),
});
export type ShopCheckoutInput = z.infer<typeof ShopCheckoutInput>;

const orderOf = (input: ShopCheckoutInput): CheckoutDetails | null =>
  typeof input.order === 'object' && input.order !== null ? (input.order as CheckoutDetails) : null;

const usd = (amountMicro: number): Money => ({
  amountMicro: Math.max(0, amountMicro),
  currency: 'USD',
});

function placedOutput(row: OrderRow, extra: { sessionId: string | null; reconciled: boolean }) {
  const total: Money = { amountMicro: row.total_micro, currency: row.currency };
  return {
    orderId: row.id,
    merchantOrderId: row.merchant_order_id,
    total,
    totalText: moneyParam(total),
    merchantName: row.merchant_name,
    siteId: row.site_id,
    status: row.status,
    evidenceArtifactId: row.confirmation_artifact_id,
    sessionId: extra.sessionId,
    reconciled: extra.reconciled,
  };
}

function checkoutUnsupported(host: string): AgentError {
  return new AgentError(
    'TOOL_FAILED',
    `JARVIS can't order on ${host}: finish the purchase on the site.`,
    {
      reason: 'CHECKOUT_UNSUPPORTED',
      params: { host },
    },
  );
}

export const shopCheckoutTool: ToolDefinition<ShopCheckoutInput> = {
  id: 'shop.checkout',
  version: '1.0.0',
  description:
    'Place the order for a cart prepared by shop.prepare_cart, exactly once, on a SUPPORTED shop that allows ordering through JARVIS (e.g. "fixture-shop"). order must reference shop.prepare_cart output checkoutDetails ({{s3.checkoutDetails}}). Always needs the user’s approval of the exact items and total; refused when purchases are off or over the monthly purchase limit.',
  inputSchema: ShopCheckoutInput,
  allowedRefTools: ['shop.prepare_cart'],
  validatePlanned(input) {
    const { recipe, issues } = plannedRecipe(input.siteId);
    const out = issues.map((i) => `shop.checkout: ${i}`);
    if (recipe && !recipe.shop?.checkout)
      out.push(
        `shop.checkout: ${recipe.name} does not support ordering through JARVIS — end with shop.prepare_cart and hand over its cart link`,
      );
    if (!isRef(input.order))
      out.push(
        'shop.checkout order must be a reference to shop.prepare_cart checkoutDetails ({{sN.checkoutDetails}}), never written out',
      );
    return out;
  },
  outputFields: ['orderId', 'merchantOrderId', 'total', 'totalText'],
  requiredConnection: 'web',
  permissions: ['web:read', 'commerce:purchase'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 200_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  outbound: true,
  runsInBrowser: true,
  riskLevel: () => 'HIGH',
  purchase: (input) => {
    const o = orderOf(input);
    return o
      ? { amountMicro: o.total.amountMicro, currency: o.total.currency }
      : { amountMicro: null, currency: null };
  },
  estimateCostMicro: () => 0,
  preview: (input) => {
    const o = orderOf(input);
    return o
      ? {
          siteId: input.siteId,
          merchant: o.merchantName,
          items: o.lines.map((l) => `${l.quantity} × ${l.title}`),
          total: moneyParam(o.total),
        }
      : { siteId: input.siteId, order: input.order };
  },
  approvalDetails(input, ctx) {
    const o = orderOf(input);
    const recipe = getRecipe(input.siteId);
    const merchant = o?.merchantName ?? recipe?.name ?? input.siteId;
    const total = o?.total ?? usd(0);
    const limit = ctx.purchases ?? { limitMicro: 0, spentMicro: 0 };
    const summaryMessage = msg('approval.purchase', { total: moneyParam(total), merchant });
    return {
      details: {
        kind: 'purchase',
        siteId: input.siteId,
        merchant: {
          name: merchant,
          host:
            o?.merchantHost ?? ctx.siteHost?.(input.siteId) ?? recipe?.hostLabel ?? input.siteId,
        },
        items: (o?.lines ?? []).map((l) => ({
          title: l.title,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          productUrl: l.productUrl,
        })),
        subtotal: o?.subtotal ?? usd(0),
        shipping: o?.shipping ?? usd(0),
        tax: o?.tax ?? null,
        total,
        delivery: o?.delivery ?? { method: '', estimate: null, address: '' },
        paymentMethod: o?.paymentMethod ?? '',
        limit: {
          monthly: usd(limit.limitMicro),
          spentThisMonth: usd(limit.spentMicro),
          remainingAfter: usd(
            limit.limitMicro -
              limit.spentMicro -
              (total.currency === 'USD' ? total.amountMicro : 0),
          ),
        },
        evidenceArtifactId: o?.evidenceArtifactId ?? null,
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  resultLine: (_input, output) =>
    output.merchantOrderId
      ? msg('result.orderPlaced', {
          merchant: String(output.merchantName ?? ''),
          orderId: String(output.merchantOrderId),
        })
      : null,
  resultFact: (_input, output) =>
    `Ordered from ${String(output.merchantName ?? '')} (order ${String(output.merchantOrderId ?? '')}), total ${String(output.totalText ?? '')}`,
  async execute(input, rt, signal) {
    const order = orderOf(input);
    if (!order)
      throw new AgentError('TOOL_FAILED', 'The order to place is missing.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'shop.checkout' },
      });
    const { recipe, origins } = enabledRecipe(rt.config, input.siteId);
    const host = order.merchantHost || new URL(origins[0]!).host;
    if (!recipe.shop?.checkout || order.siteId !== recipe.id) throw checkoutUnsupported(host);
    // Exactly the cart this task prepared and the user approved (never edited in between).
    const [cartRow] = await sessionsOfTask(rt, [order.cartSessionId]);
    const prepared =
      cartRow?.status === 'succeeded' &&
      cartRow.operation === 'cart' &&
      cartRow.site_id === recipe.id
        ? (cartRow.result as ShopCartOutput)
        : null;
    const same =
      prepared !== null &&
      prepared.cartId === order.cartId &&
      prepared.cart.total?.amountMicro === order.total.amountMicro &&
      prepared.cart.total?.currency === order.total.currency &&
      // Canonical comparison: stored JSON does not keep key order.
      hashObject(prepared.cart.lines) === hashObject(order.lines);
    if (!same)
      throw new AgentError('TOOL_FAILED', 'That order is not the cart this task prepared.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'shop.checkout' },
      });

    const key = orderKey(rt.stepId);
    const { approvalId, actionHash } = await approvedAction(rt, 'shop.checkout', input);
    const facts: OrderFacts = {
      taskId: rt.taskId,
      stepId: rt.stepId,
      siteId: recipe.id,
      merchantName: order.merchantName,
      merchantHost: host,
      items: order.lines as CartLineJson[],
      currency: order.total.currency,
      subtotalMicro: order.subtotal.amountMicro,
      shippingMicro: order.shipping.amountMicro,
      taxMicro: order.tax?.amountMicro ?? null,
      totalMicro: order.total.amountMicro,
      approvalId,
      actionHash,
      cartArtifactId: order.evidenceArtifactId,
    };
    const reserved = await withContext(rt.db, rt.ctx, (trx) =>
      reserveOrder(trx, rt.ctx, key, facts),
    );
    let row = reserved.row;
    const done = (
      r: OrderRow,
      sessionId: string | null,
      reconciled: boolean,
      ev = [] as ReturnType<typeof artifactEvidence>,
    ) => ({
      output: placedOutput(r, { sessionId, reconciled }),
      outputPreview: {
        orderId: r.id,
        merchantOrderId: r.merchant_order_id,
        total: moneyParam({ amountMicro: r.total_micro, currency: r.currency }),
        merchant: r.merchant_name,
        reconciled,
      },
      evidence: [
        ...ev,
        evidence(
          'record',
          'Order confirmed by the merchant',
          `${r.merchant_order_id}`,
          'ORDER_CONFIRMATION',
          {
            orderId: r.id,
            merchantOrderId: r.merchant_order_id ?? '',
            total: moneyParam({ amountMicro: r.total_micro, currency: r.currency }),
          },
        ),
      ],
      costMicro: 0,
    });

    if (reserved.existing && row.status === 'placed') return done(row, null, true);
    if (reserved.existing && (row.status === 'submitting' || row.status === 'unknown')) {
      // An earlier attempt may have ordered: ask the merchant by the same key before anything else.
      const look = await runBrowserSession(
        rt,
        { siteId: recipe.id, operation: 'order_lookup', input: { idempotencyKey: key } },
        signal,
      );
      if (look.status !== 'succeeded' || !look.result)
        throw outcomeError(look, { siteName: recipe.name, fallbackHost: host, readOnly: true });
      const found = look.result as ShopLookupOutput;
      if (found.found) {
        const placed = await withContext(rt.db, rt.ctx, (trx) =>
          finalizeOrder(trx, rt.ctx, key, {
            kind: 'placed',
            merchantOrderId: found.merchantOrderId,
            confirmationArtifactId: found.confirmationArtifactId,
          }),
        );
        return done(placed ?? row, look.sessionId, true, artifactEvidence(look.artifacts));
      }
    }
    // Nothing at the merchant for this key (or a definite failure before): submit — the merchant
    // dedupes the key as well, so even a race cannot order twice.
    if (reserved.existing && row.status !== 'submitting')
      row = await withContext(rt.db, rt.ctx, (trx) => restartOrder(trx, rt.ctx, row, facts));

    const o = await runBrowserSession(
      rt,
      {
        siteId: recipe.id,
        operation: 'checkout',
        input: {
          cartId: order.cartId,
          idempotencyKey: key,
          expected: {
            lines: order.lines.map((l) => ({
              productUrl: l.productUrl,
              quantity: l.quantity,
              lineTotalMicro: l.lineTotal.amountMicro,
            })),
            totalMicro: order.total.amountMicro,
            currency: order.total.currency,
          },
        },
      },
      signal,
    );
    if (o.status !== 'succeeded' || !o.result)
      throw outcomeError(o, {
        siteName: recipe.name,
        fallbackHost: host,
        readOnly: false,
        unknownReason: 'ORDER_UNKNOWN',
      });
    const r = o.result as ShopCheckoutOutput;
    switch (r.outcome) {
      case 'price_changed':
        throw new AgentError(
          'TOOL_FAILED',
          `The total changed from ${moneyParam(r.expectedTotal)} to ${r.actualTotal ? moneyParam(r.actualTotal) : 'an unknown amount'}, so nothing was ordered. Ask again to see the new price.`,
          {
            retryable: false,
            reason: 'PRICE_CHANGED',
            params: {
              expected: moneyParam(r.expectedTotal),
              actual: r.actualTotal ? moneyParam(r.actualTotal) : '—',
            },
          },
        );
      case 'out_of_stock':
        throw new AgentError('TOOL_FAILED', 'An item is out of stock, so nothing was ordered.', {
          retryable: false,
          reason: 'OUT_OF_STOCK',
        });
      case 'declined':
        throw new AgentError(
          'TOOL_FAILED',
          `${host} declined the order (HTTP ${r.status}); nothing was ordered.`,
          {
            retryable: false,
            reason: 'SITE_ERROR',
            params: { host, status: r.status },
          },
        );
      case 'unconfirmed':
        throw new AgentError(
          'OUTCOME_UNKNOWN',
          `The order was submitted to ${recipe.name}, but no confirmation was shown. Check your orders with the shop before trying again.`,
          { retryable: false, reason: 'ORDER_UNKNOWN', params: { step: recipe.name } },
        );
      case 'placed': {
        const final = await withContext(rt.db, rt.ctx, (trx) =>
          trx.selectFrom('orders').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow(),
        );
        if (final.status !== 'placed')
          throw new AgentError(
            'OUTCOME_UNKNOWN',
            'The order’s confirmation could not be recorded.',
            {
              reason: 'ORDER_UNKNOWN',
              params: { step: recipe.name },
            },
          );
        return done(final, o.sessionId, false, artifactEvidence(o.artifacts));
      }
    }
  },
  verify(input, output) {
    const o = orderOf(input);
    const total = output.total as Money | undefined;
    const matches =
      !!o &&
      !!total &&
      total.amountMicro === o.total.amountMicro &&
      total.currency === o.total.currency;
    const id = typeof output.merchantOrderId === 'string' ? output.merchantOrderId : '';
    const checks = [
      check('orderPlaced', `The merchant confirmed order ${id}`, { orderId: id }),
      check(
        'totalMatches',
        `The order total equals the approved total (${total ? moneyParam(total) : '—'})`,
        {
          total: total ? moneyParam(total) : '—',
        },
      ),
    ];
    if (typeof output.evidenceArtifactId === 'string')
      checks.push(
        check('screenshotStored', 'Screenshot of the confirmation stored', {
          artifactId: output.evidenceArtifactId,
        }),
      );
    return { ok: id.length > 0 && matches, checks };
  },
};
