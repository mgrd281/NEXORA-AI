/**
 * shop.prepare_cart — put an offer into a new cart on its shop (scenario 3/7/10,
 * docs/architecture/phase-c.md §3.6). MEDIUM: an external but reversible change
 * (nothing is bought), approved first with the item, the price as seen and the
 * quantity. The offer comes only by reference from shop.compare
 * (`{{sN.bestOffer}}`) and is checked again against this task's own search
 * session; the quantity is a literal number from the user's words.
 *
 * The cart and — on shops whose recipe can order — the checkout summary
 * (lines, totals, delivery, payment as the merchant shows it) are read live,
 * with a screenshot (CART_SNAPSHOT). `checkoutDetails` is what shop.checkout
 * references; shops without checkout support hand over the cart link instead
 * (`handoverUrl`): the user finishes there.
 */
import { CartLine, Money, ProductOffer, type PreparedCart } from '@jarvis/contracts';
import { COMMERCE_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { runBrowserSession, sessionsOfTask } from '../../../browser/client';
import { getRecipe } from '../../../browser/sites';
import type { ShopCartOutput, ShopSearchOutput } from '../../../browser/sites/fixture-shop';
import { AgentError } from '../../errors';
import { detectInjection } from '../injection';
import { msg, render } from '../../i18n';
import { check, evidence, type ToolDefinition } from '../types';
import {
  artifactEvidence,
  enabledRecipe,
  isRef,
  money,
  outcomeError,
  plannedRecipe,
  refOr,
  SiteId,
  word,
} from './common';

/** What shop.checkout receives by reference: the cart exactly as the merchant's checkout showed it. */
export const CheckoutDetails = z.object({
  cartSessionId: z.string().uuid(),
  cartId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  siteId: z.string(),
  merchantName: z.string(),
  merchantHost: z.string(),
  lines: z.array(CartLine).min(1).max(COMMERCE_LIMITS.maxCartLines),
  subtotal: Money,
  shipping: Money,
  tax: Money.nullable(),
  total: Money,
  delivery: z.object({ method: z.string(), estimate: z.string().nullable(), address: z.string() }),
  paymentMethod: z.string(),
  evidenceArtifactId: z.string().nullable(),
});
export type CheckoutDetails = z.infer<typeof CheckoutDetails>;

export const ShopPrepareCartInput = z.object({
  siteId: SiteId,
  offer: refOr(
    ProductOffer,
    'The offer to put in the cart: a reference to shop.compare output bestOffer, e.g. {{s2.bestOffer}}. Never written out.',
  ),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(COMMERCE_LIMITS.maxQuantityPerLine)
    .default(1)
    .describe(
      'How many, exactly as the user said (default 1). A literal number, never a reference.',
    ),
});
export type ShopPrepareCartInput = z.infer<typeof ShopPrepareCartInput>;

const offerOf = (input: ShopPrepareCartInput): ProductOffer | null =>
  typeof input.offer === 'object' && input.offer !== null ? (input.offer as ProductOffer) : null;

export const shopPrepareCartTool: ToolDefinition<ShopPrepareCartInput> = {
  id: 'shop.prepare_cart',
  version: '1.0.0',
  description:
    'Put an offer into a new cart on its SUPPORTED shop and read the cart and checkout summary (nothing is bought). offer must reference shop.compare output bestOffer ({{s2.bestOffer}}); quantity is the user’s literal number. Output checkoutDetails is what shop.checkout references; shops without checkout support return handoverUrl for the user.',
  inputSchema: ShopPrepareCartInput,
  allowedRefTools: ['shop.compare'],
  validatePlanned(input) {
    const { recipe, issues } = plannedRecipe(input.siteId, 'cart');
    const out = issues.map((i) => `shop.prepare_cart: ${i}`);
    if (recipe && !recipe.shop) out.push(`shop.prepare_cart: ${recipe.name} is not a shop`);
    if (!isRef(input.offer))
      out.push(
        'shop.prepare_cart offer must be a reference to shop.compare bestOffer ({{sN.bestOffer}}), never written out',
      );
    return out;
  },
  outputFields: [
    'cart',
    'cartId',
    'totalMicro',
    'currency',
    'handoverUrl',
    'checkoutDetails',
    'checkoutSupported',
    'text',
  ],
  requiredConnection: 'web',
  permissions: ['web:read', 'commerce:cart'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 150_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  outbound: true,
  runsInBrowser: true,
  riskLevel: () => 'MEDIUM',
  estimateCostMicro: () => 0,
  preview: (input) => {
    const o = offerOf(input);
    return { siteId: input.siteId, item: o?.title ?? input.offer, quantity: input.quantity };
  },
  approvalDetails(input, ctx) {
    const o = offerOf(input);
    const site = o?.merchantName ?? getRecipe(input.siteId)?.name ?? input.siteId;
    const summaryMessage = msg('approval.cart', { site });
    return {
      details: {
        kind: 'generic',
        toolId: 'shop.prepare_cart',
        fields: [
          { label: 'Shop', value: `${site}${o ? ` (${o.merchantHost})` : ''}` },
          { label: 'Item', value: o?.title ?? '—' },
          { label: 'Quantity', value: String(input.quantity) },
          { label: 'Price as seen', value: o ? money(o.price) : '—' },
          { label: 'Shipping as seen', value: o?.shipping ? money(o.shipping) : '—' },
          { label: 'Product page', value: o?.productUrl ?? '—' },
          { label: 'Note', value: word(ctx.language, 'nothingBought') },
        ],
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  // A cart handed over to the user is the result; a cart that shop.checkout may still order is
  // not ("nothing was bought" would contradict the order line that follows): its text stands in.
  resultLine: (input, output) =>
    output.checkoutSupported === false
      ? msg('result.cartPrepared', {
          site:
            (output.cart as PreparedCart | undefined)?.merchantName ??
            getRecipe(input.siteId)?.name ??
            input.siteId,
        })
      : null,
  resultTextField: 'text',
  untrustedHost: (output) => (output.cart as PreparedCart | undefined)?.merchantHost ?? null,
  resultFact: (_input, output) => {
    const cart = output.cart as PreparedCart | undefined;
    return cart
      ? `Cart prepared at ${cart.merchantName}: ${cart.lines.map((l) => `${l.quantity} × ${l.title}`).join(', ')}, total ${money(cart.total)}${cart.handoverUrl ? `; finish at ${cart.handoverUrl}` : ''}`
      : 'Cart prepared';
  },
  async execute(input, rt, signal) {
    const offer = offerOf(input);
    if (!offer)
      throw new AgentError(
        'TOOL_FAILED',
        'JARVIS found no matching offer, so nothing was put in a cart.',
        {
          reason: 'INVALID_STEP_INPUT',
          params: { step: 'shop.prepare_cart' },
        },
      );
    const { recipe, origins } = enabledRecipe(rt.config, input.siteId);
    // The offer must be one this task read live from this shop (never invented or edited).
    const sessionId = offer.id.split('.')[0] ?? '';
    const [read] = /^[0-9a-f-]{36}$/i.test(sessionId) ? await sessionsOfTask(rt, [sessionId]) : [];
    const recorded =
      read?.status === 'succeeded' && read.site_id === recipe.id && read.operation === 'search'
        ? (read.result as ShopSearchOutput).offers.find((o) => o.id === offer.id)
        : undefined;
    if (
      !recorded ||
      offer.siteId !== recipe.id ||
      recorded.productUrl !== offer.productUrl ||
      recorded.price.amountMicro !== offer.price.amountMicro
    )
      throw new AgentError('TOOL_FAILED', 'That offer is not one this shop showed in this task.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'shop.prepare_cart' },
      });
    const o = await runBrowserSession(
      rt,
      {
        siteId: recipe.id,
        operation: 'cart',
        input: { productUrl: offer.productUrl, quantity: input.quantity },
      },
      signal,
    );
    if (o.status !== 'succeeded' || !o.result)
      throw outcomeError(o, {
        siteName: recipe.name,
        fallbackHost: new URL(origins[0]!).host,
        readOnly: false,
      });
    const r = o.result as ShopCartOutput;
    const cart = r.cart;
    const checkoutDetails: CheckoutDetails | null =
      cart.checkoutSupported && cart.shipping && cart.total && r.delivery && r.paymentMethod
        ? {
            cartSessionId: o.sessionId,
            cartId: r.cartId,
            siteId: recipe.id,
            merchantName: cart.merchantName,
            merchantHost: cart.merchantHost,
            lines: cart.lines,
            subtotal: cart.subtotal,
            shipping: cart.shipping,
            tax: r.tax,
            total: cart.total,
            delivery: r.delivery,
            paymentMethod: r.paymentMethod,
            evidenceArtifactId: cart.evidenceArtifactId,
          }
        : null;
    const scan = detectInjection(cart.lines.map((l) => l.title).join('\n'));
    const lang = rt.language;
    const text = [
      `${word(lang, 'cart')} — ${cart.merchantName}:`,
      ...cart.lines.map((l) => `• ${l.quantity} × ${l.title}: ${money(l.lineTotal)}`),
      `${word(lang, 'shipping')}: ${cart.shipping ? money(cart.shipping) : word(lang, 'unknown')} · ${word(lang, 'total')}: ${cart.total ? money(cart.total) : word(lang, 'unknown')}`,
      ...(cart.handoverUrl ? [`${word(lang, 'finishOnSite')}: ${cart.handoverUrl}`] : []),
      word(lang, 'nothingBought'),
    ].join('\n');
    return {
      output: {
        cart,
        cartId: r.cartId,
        totalMicro: cart.total?.amountMicro ?? null,
        currency: (cart.total ?? cart.subtotal).currency,
        handoverUrl: cart.handoverUrl,
        checkoutSupported: cart.checkoutSupported,
        checkoutDetails,
        sessionId: o.sessionId,
        text,
        suspectedInjection: scan.suspectedInjection,
        injectionSignals: scan.injectionSignals,
      },
      outputPreview: {
        cart,
        merchant: cart.merchantName,
        lines: cart.lines.map((l) => ({
          title: l.title,
          quantity: l.quantity,
          lineTotal: l.lineTotal,
        })),
        total: cart.total,
        handoverUrl: cart.handoverUrl,
        checkoutSupported: cart.checkoutSupported,
      },
      evidence: [
        ...artifactEvidence(o.artifacts),
        ...(cart.evidenceArtifactId
          ? [
              evidence(
                'browser_capture',
                'Cart as the shop showed it',
                money(cart.total),
                'CART_SNAPSHOT',
                {
                  artifactId: cart.evidenceArtifactId,
                  total: money(cart.total),
                },
              ),
            ]
          : []),
      ],
      costMicro: 0,
    };
  },
  verify(input, output) {
    const cart = output.cart as PreparedCart | undefined;
    const ok = !!cart && cart.lines.some((l) => l.quantity === input.quantity);
    return {
      ok,
      checks: [
        check('liveSource', `Cart read live from ${cart?.merchantHost ?? ''}`, {
          url: cart?.handoverUrl ?? cart?.merchantHost ?? '',
        }),
        ...(cart?.evidenceArtifactId
          ? [
              check('screenshotStored', 'Screenshot of the cart stored', {
                artifactId: cart.evidenceArtifactId,
              }),
            ]
          : []),
      ],
    };
  },
};
