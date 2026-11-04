/**
 * Recipes for the two fictional shops of the local fixture site
 * (scripts/fixture-site.mjs): "Fixture Shop" (/shop, checkout supported — its
 * checkout honours an Idempotency-Key, docs/adr/0018) and "Fixture Outlet"
 * (/outlet, no checkout support: the user finishes the purchase on the site
 * with the prepared cart). Development/test only: both exist only with
 * BROWSER_FIXTURE_ORIGIN, which production refuses. Real shops get their own
 * reviewed recipes; nothing here generalises to arbitrary sites.
 *
 * Operations:
 *   read          the generic schema.org reader (common.ts)
 *   search        results page + up to 4 product pages: schema.org Product/Offer (price,
 *                 shipping, delivery, stock, rating) and reliability facts, with screenshots
 *   cart          add a product (quantity) to a new cart; read the live cart and, when
 *                 checkout is supported, the checkout summary (delivery, payment) — reversible
 *   checkout      re-read the live checkout, refuse a changed total / line / stock before
 *                 submitting, submit with the order's idempotency key, read the Order JSON-LD
 *                 confirmation — binding (commit: order)
 *   order_lookup  the merchant's order for an idempotency key (reconciliation after an
 *                 interrupted checkout)
 */
import {
  COMMERCE_LIMITS,
  CartLine,
  Money,
  PreparedCart,
  ProductOffer,
  type ProductOffer as Offer,
} from '@jarvis/contracts';
import { z } from 'zod';
import { cleanText, jsonLdNodes, ofType, order, productOffer } from '../structured';
import {
  stopSession,
  type Recipe,
  type RecipeContext,
  type RecipeOperation,
  type SiteConfig,
} from '../types';
import { attrs, fixtureOrigin, money, moneyOf, readOperation, reliabilitySignals } from './common';

/** Product pages one search reads per shop (each with a screenshot: within the evidence budget). */
export const MAX_PRODUCTS_PER_SEARCH = 4;

const SearchInput = z.object({ query: z.string().trim().min(1).max(200) });
const SearchOutput = z.object({
  query: z.string(),
  searchUrl: z.string(),
  resultCount: z.number().int().nonnegative(),
  offers: z.array(ProductOffer).max(MAX_PRODUCTS_PER_SEARCH),
  screenshotArtifactId: z.string(),
  extractArtifactId: z.string(),
});
export type ShopSearchOutput = z.infer<typeof SearchOutput>;

const CartInput = z.object({
  productUrl: z.string().min(1).max(2048),
  quantity: z.number().int().min(1).max(COMMERCE_LIMITS.maxQuantityPerLine),
});
const Delivery = z.object({
  method: z.string(),
  estimate: z.string().nullable(),
  address: z.string(),
});
const CartOutput = z.object({
  cartId: z.string(),
  cart: PreparedCart,
  /** As the checkout page shows them (null without checkout support). */
  delivery: Delivery.nullable(),
  paymentMethod: z.string().nullable(),
  tax: Money.nullable(),
  cartUrl: z.string(),
});
export type ShopCartOutput = z.infer<typeof CartOutput>;

const ExpectedLine = z.object({
  productUrl: z.string(),
  quantity: z.number().int().positive(),
  lineTotalMicro: z.number().int().nonnegative(),
});
const CheckoutInput = z.object({
  cartId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  idempotencyKey: z.string().min(16).max(200),
  expected: z.object({
    lines: z.array(ExpectedLine).min(1).max(COMMERCE_LIMITS.maxCartLines),
    totalMicro: z.number().int().nonnegative(),
    currency: z.string(),
  }),
});
const CheckoutOutput = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('placed'),
    merchantOrderId: z.string(),
    total: Money,
    orderUrl: z.string(),
    confirmationArtifactId: z.string(),
  }),
  z.object({
    outcome: z.literal('price_changed'),
    expectedTotal: Money,
    actualTotal: Money.nullable(),
    screenshotArtifactId: z.string(),
  }),
  z.object({ outcome: z.literal('out_of_stock'), screenshotArtifactId: z.string() }),
  z.object({
    outcome: z.literal('declined'),
    status: z.number().int(),
    screenshotArtifactId: z.string(),
  }),
  z.object({ outcome: z.literal('unconfirmed'), screenshotArtifactId: z.string().nullable() }),
]);
export type ShopCheckoutOutput = z.infer<typeof CheckoutOutput>;

const LookupInput = z.object({ idempotencyKey: z.string().min(16).max(200) });
const LookupOutput = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    merchantOrderId: z.string(),
    total: Money,
    orderUrl: z.string(),
    confirmationArtifactId: z.string(),
  }),
  z.object({ found: z.literal(false), screenshotArtifactId: z.string() }),
]);
export type ShopLookupOutput = z.infer<typeof LookupOutput>;

interface ShopDef {
  id: string;
  name: string;
  base: '/shop' | '/outlet';
  checkout: boolean;
  aliases: readonly string[];
}

interface LiveLine {
  title: string;
  quantity: number;
  unit: Money;
  line: Money;
  productUrl: string;
  inStock: boolean;
}

async function liveLines(ctx: RecipeContext, origin: string): Promise<LiveLine[]> {
  await ctx.require('[data-testid=line]');
  const rows = await attrs(ctx, '[data-testid=line]');
  const lines: LiveLine[] = [];
  for (const r of rows) {
    const unit = moneyOf(r.unit, r.currency);
    const line = moneyOf(r.line, r.currency);
    const quantity = Number(r.quantity);
    if (!unit || !line || !Number.isInteger(quantity) || quantity < 1 || !r.url)
      stopSession('PAGE_CHANGED', { host: new URL(origin).host });
    lines.push({
      title: cleanText(r.title) ?? '',
      quantity,
      unit,
      line,
      productUrl: new URL(r.url, origin).toString(),
      inStock: r['in-stock'] !== 'false',
    });
  }
  return lines;
}

async function liveTotals(
  ctx: RecipeContext,
): Promise<{ subtotal: Money | null; shipping: Money | null; total: Money | null }> {
  const read = async (id: string) => {
    const [a] = await attrs(ctx, `[data-testid=${id}]`);
    return a && a.unknown !== 'true' ? moneyOf(a.amount, a.currency) : null;
  };
  return {
    subtotal: await read('subtotal'),
    shipping: await read('shipping'),
    total: await read('total'),
  };
}

function shopRecipe(def: ShopDef): Recipe {
  const base = (config: SiteConfig) => {
    const o = fixtureOrigin(config);
    return o ? `${o}${def.base}` : null;
  };
  /** Where this shop's pages live: the fixture origin plus its base path. */
  const originOf = (ctx: RecipeContext) => {
    if (!ctx.origin) stopSession('SITE_UNSUPPORTED');
    return ctx.origin!;
  };

  const search: RecipeOperation<z.infer<typeof SearchInput>, ShopSearchOutput> = {
    description: `Search ${def.name} and read up to ${MAX_PRODUCTS_PER_SEARCH} product pages (price, shipping, delivery, stock, rating, merchant facts).`,
    input: SearchInput,
    output: SearchOutput,
    sideEffect: 'none',
    risk: 'LOW',
    idempotency: 'safe_to_retry',
    async run(ctx, input) {
      const origin = originOf(ctx);
      const searchUrl = `${origin}${def.base}/search?q=${encodeURIComponent(input.query)}`;
      await ctx.goto(searchUrl);
      await ctx.require('[data-testid=results]');
      const results = (await attrs(ctx, '[data-testid=result]')).filter(
        (r) => r.__href && ctx.allowed(r.__href),
      );
      const listShot = await ctx.screenshot();
      const offers: Offer[] = [];
      for (const r of results.slice(0, MAX_PRODUCTS_PER_SEARCH)) {
        const productUrl = r.__href!;
        // Only this shop's product pages (a result link elsewhere is not followed).
        if (!new URL(productUrl).pathname.startsWith(`${def.base}/products/`)) continue;
        await ctx.goto(productUrl);
        const [product] = ofType(jsonLdNodes(await ctx.jsonLd()), 'Product');
        if (!product) stopSession('PAGE_CHANGED', { host: new URL(productUrl).host });
        const o = productOffer(product!);
        if (o.priceMicro === null || !o.currency || !o.name) continue; // no stated price: not an offer
        const price = money(o.priceMicro, o.currency);
        const shipping =
          o.shippingMicro !== null && o.shippingCurrency
            ? money(o.shippingMicro, o.shippingCurrency)
            : null;
        const total =
          shipping && shipping.currency === price.currency
            ? money(price.amountMicro + shipping.amountMicro, price.currency)
            : null;
        const shot = await ctx.screenshot();
        offers.push({
          id: `${ctx.sessionId}.${offers.length}`,
          siteId: def.id,
          merchantName: def.name,
          merchantHost: new URL(productUrl).host,
          title: o.name,
          productUrl,
          price,
          shipping,
          total,
          // The page states the range as JSON-LD numbers, not as words: no `text` (which is the
          // page's own wording), so clients say "2–4 days" in the viewer's language.
          delivery: {
            minDays: o.deliveryMinDays,
            maxDays: o.deliveryMaxDays,
            text: null,
          },
          inStock: o.inStock,
          rating: o.rating,
          signals: await reliabilitySignals(ctx, {
            rating: o.rating,
            deliveryStated: shipping !== null && o.deliveryMaxDays !== null,
          }),
          evidenceArtifactId: shot.artifactId,
          capturedAt: new Date().toISOString(),
        });
      }
      const extract = await ctx.saveExtract(
        { query: input.query, searchUrl, offers },
        offers.length,
      );
      return {
        query: input.query,
        searchUrl,
        resultCount: results.length,
        offers,
        screenshotArtifactId: offers[0]?.evidenceArtifactId ?? listShot.artifactId,
        extractArtifactId: extract.artifactId,
      };
    },
    verify: (_i, out) =>
      out.offers.every((o) => o.siteId === def.id) && out.extractArtifactId.length > 0,
  };

  const cart: RecipeOperation<z.infer<typeof CartInput>, ShopCartOutput> = {
    description: `Put a product into a new cart on ${def.name} and read the cart${def.checkout ? ' and the checkout summary' : ''} (nothing is bought).`,
    input: CartInput,
    output: CartOutput,
    sideEffect: 'reversible',
    risk: 'MEDIUM',
    idempotency: 'once_per_step',
    async run(ctx, input) {
      const origin = originOf(ctx);
      const target = new URL(input.productUrl);
      if (target.origin !== origin || !target.pathname.startsWith(`${def.base}/products/`))
        stopSession('SITE_UNSUPPORTED', { host: target.host });
      await ctx.goto(target.toString());
      await ctx.require('[data-testid=add-to-cart-form]');
      await ctx.page.fill('[data-testid=quantity]', String(input.quantity));
      const nav = await ctx.navigateBy(() => ctx.page.click('[data-testid=add-to-cart]'));
      const cartPath = new URL(nav.url).pathname;
      const m = new RegExp(`^${def.base}/cart/([A-Za-z0-9_-]{1,64})$`).exec(cartPath);
      if (!m) stopSession('PAGE_CHANGED', { host: target.host });
      const cartId = m![1]!;
      const cartUrl = nav.url;
      let lines = await liveLines(ctx, origin);
      let totals = await liveTotals(ctx);
      let delivery: z.infer<typeof Delivery> | null = null;
      let paymentMethod: string | null = null;
      if (def.checkout) {
        await ctx.goto(`${origin}${def.base}/checkout/${cartId}`);
        await ctx.require('[data-testid=checkout-form]');
        lines = await liveLines(ctx, origin);
        totals = await liveTotals(ctx);
        const [d] = await attrs(ctx, '[data-testid=delivery]');
        const address = cleanText(
          await ctx.page.textContent('[data-testid=address]').catch(() => null),
        );
        paymentMethod = cleanText(
          await ctx.page.textContent('[data-testid=payment]').catch(() => null),
        );
        if (!d?.method || !address || !paymentMethod)
          stopSession('PAGE_CHANGED', { host: target.host });
        delivery = {
          method: cleanText(d!.method)!,
          estimate: cleanText(d!.estimate ?? null),
          address: address!,
        };
      }
      if (!totals.subtotal) stopSession('PAGE_CHANGED', { host: target.host });
      const shot = await ctx.screenshot();
      const prepared = {
        siteId: def.id,
        merchantName: def.name,
        merchantHost: target.host,
        lines: lines.map((l) => ({
          title: l.title,
          quantity: l.quantity,
          unitPrice: l.unit,
          lineTotal: l.line,
          productUrl: l.productUrl,
        })),
        subtotal: totals.subtotal!,
        shipping: totals.shipping,
        total: totals.total,
        checkoutSupported: def.checkout,
        handoverUrl: def.checkout ? null : cartUrl,
        evidenceArtifactId: shot.artifactId,
        preparedAt: new Date().toISOString(),
      };
      return { cartId, cart: prepared, delivery, paymentMethod, tax: null, cartUrl };
    },
    verify: (input, out) =>
      out.cart.siteId === def.id &&
      out.cart.lines.some(
        (l) =>
          l.quantity === input.quantity && l.productUrl === new URL(input.productUrl).toString(),
      ),
  };

  const checkout: RecipeOperation<z.infer<typeof CheckoutInput>, ShopCheckoutOutput> = {
    description: `Place the order for a prepared cart on ${def.name}, exactly once (the merchant honours the idempotency key).`,
    input: CheckoutInput,
    output: CheckoutOutput,
    sideEffect: 'binding',
    risk: 'HIGH',
    idempotency: 'once_per_step',
    commit: 'order',
    async run(ctx, input) {
      const origin = originOf(ctx);
      await ctx.goto(`${origin}${def.base}/checkout/${input.cartId}`);
      await ctx.require('[data-testid=checkout-form]');
      // The live checkout must be exactly what the user approved.
      const lines = await liveLines(ctx, origin);
      const totals = await liveTotals(ctx);
      const expectedTotal = money(input.expected.totalMicro, input.expected.currency);
      const sameLines =
        lines.length === input.expected.lines.length &&
        input.expected.lines.every((e) =>
          lines.some(
            (l) =>
              l.productUrl === e.productUrl &&
              l.quantity === e.quantity &&
              l.line.amountMicro === e.lineTotalMicro &&
              l.line.currency === input.expected.currency,
          ),
        );
      const sameTotal =
        totals.total !== null &&
        totals.total.amountMicro === expectedTotal.amountMicro &&
        totals.total.currency === expectedTotal.currency;
      if (lines.some((l) => !l.inStock)) {
        const shot = await ctx.screenshot();
        return { outcome: 'out_of_stock', screenshotArtifactId: shot.artifactId };
      }
      if (!sameLines || !sameTotal) {
        const shot = await ctx.screenshot();
        return {
          outcome: 'price_changed',
          expectedTotal,
          actualTotal: totals.total,
          screenshotArtifactId: shot.artifactId,
        };
      }
      await ctx.setExtraHeaders({ 'Idempotency-Key': input.idempotencyKey });
      ctx.markSubmitting();
      const nav = await ctx.navigateBy(() => ctx.page.click('[data-testid=place-order]'), {
        acceptStatus: [402, 409],
      });
      if (nav.status === 402) {
        const shot = await ctx.screenshot();
        return { outcome: 'declined', status: 402, screenshotArtifactId: shot.artifactId };
      }
      if (nav.status === 409) {
        const shot = await ctx.screenshot();
        return { outcome: 'out_of_stock', screenshotArtifactId: shot.artifactId };
      }
      const [node] = ofType(jsonLdNodes(await ctx.jsonLd()), 'Order');
      const o = node ? order(node) : null;
      if (!o?.orderNumber || o.priceMicro === null || !o.currency) {
        const shot = await ctx.screenshot().catch(() => null);
        return { outcome: 'unconfirmed', screenshotArtifactId: shot?.artifactId ?? null };
      }
      const shot = await ctx.screenshot();
      return {
        outcome: 'placed',
        merchantOrderId: o.orderNumber,
        total: money(o.priceMicro, o.currency),
        orderUrl: nav.url,
        confirmationArtifactId: shot.artifactId,
      };
    },
    // A placed order must cost exactly what was approved.
    verify: (input, out) =>
      out.outcome !== 'placed' ||
      (out.total.amountMicro === input.expected.totalMicro &&
        out.total.currency === input.expected.currency),
  };

  const lookup: RecipeOperation<z.infer<typeof LookupInput>, ShopLookupOutput> = {
    description: `Look up the order ${def.name} placed for an idempotency key (reconciliation).`,
    input: LookupInput,
    output: LookupOutput,
    sideEffect: 'none',
    risk: 'LOW',
    idempotency: 'safe_to_retry',
    async run(ctx, input) {
      const origin = originOf(ctx);
      const nav = await ctx.goto(
        `${origin}${def.base}/orders?key=${encodeURIComponent(input.idempotencyKey)}`,
      );
      const [node] = ofType(jsonLdNodes(await ctx.jsonLd()), 'Order');
      const o = node ? order(node) : null;
      const shot = await ctx.screenshot();
      if (o?.orderNumber && o.priceMicro !== null && o.currency)
        return {
          found: true,
          merchantOrderId: o.orderNumber,
          total: money(o.priceMicro, o.currency),
          orderUrl: nav.url,
          confirmationArtifactId: shot.artifactId,
        };
      if ((await ctx.page.locator('[data-testid=no-order]').count()) === 0)
        stopSession('PAGE_CHANGED', { host: new URL(origin).host });
      return { found: false, screenshotArtifactId: shot.artifactId };
    },
    verify: () => true,
  };

  const operations: Record<string, RecipeOperation<never, unknown>> = {
    read: readOperation as RecipeOperation<never, unknown>,
    search: search as RecipeOperation<never, unknown>,
    cart: cart as RecipeOperation<never, unknown>,
    order_lookup: lookup as RecipeOperation<never, unknown>,
  };
  if (def.checkout) operations.checkout = checkout as RecipeOperation<never, unknown>;
  return {
    id: def.id,
    version: '1.0.0',
    name: def.name,
    aliases: def.aliases,
    fixture: true,
    hostLabel: 'local fixture site',
    origins: (config) => {
      const b = base(config);
      return b ? [new URL(b).origin] : [];
    },
    operations,
    shop: { checkout: def.checkout },
  };
}

export const fixtureShopRecipe = shopRecipe({
  id: 'fixture-shop',
  name: 'Fixture Shop',
  base: '/shop',
  checkout: true,
  aliases: ['fixture shop', 'fixture-shop', 'fixtureshop'],
});

export const fixtureOutletRecipe = shopRecipe({
  id: 'fixture-outlet',
  name: 'Fixture Outlet',
  base: '/outlet',
  checkout: false,
  aliases: ['fixture outlet', 'fixture-outlet', 'fixtureoutlet'],
});

/** The cart line contract of an order (orders.items). */
export type OrderLine = CartLine;
