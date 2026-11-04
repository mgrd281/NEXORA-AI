/**
 * Building blocks shared by the recipes: the generic schema.org reader
 * (operation `read`), page facts about a merchant (reliability signals) and
 * money helpers. Everything is read from the live page; nothing is guessed.
 */
import {
  BROWSER_LIMITS,
  CurrencyCode,
  Money,
  ReliabilitySignal,
  type ReliabilitySignal as Signal,
} from '@jarvis/contracts';
import { z } from 'zod';
import {
  cleanText,
  jsonLdNodes,
  ofType,
  order,
  parseAmountMicro,
  parseIcs,
  productOffer,
  reservation,
} from '../structured';
import type { DomElement, DomWindow } from '../dom';
import type { RecipeContext, RecipeOperation, SiteConfig } from '../types';

/** The fixture origin (scheme://host:port) when fixtures are enabled; never in production. */
export function fixtureOrigin(config: SiteConfig): string | null {
  if (config.isProduction || !config.BROWSER_FIXTURE_ORIGIN) return null;
  try {
    return new URL(config.BROWSER_FIXTURE_ORIGIN).origin;
  } catch {
    return null;
  }
}

export const money = (amountMicro: number, currency: string): Money => ({ amountMicro, currency });

/** A Money from page attributes (data-amount="79.00" data-currency="USD"), or null. */
export function moneyOf(
  amount: string | null | undefined,
  currency: string | null | undefined,
): Money | null {
  const micro = parseAmountMicro(amount ?? undefined);
  const cur = CurrencyCode.safeParse(currency ?? '');
  return micro === null || !cur.success ? null : money(micro, cur.data);
}

/* ------------------------------------------------------------------ */
/* Reliability signals (page facts about the merchant)                 */
/* ------------------------------------------------------------------ */

/** Facts from the merchant's own page; `rating` and `delivery` come from its structured data. */
export async function reliabilitySignals(
  ctx: RecipeContext,
  facts: { rating: { value: number; count: number } | null; deliveryStated: boolean },
): Promise<Signal[]> {
  const page = await ctx.page.evaluate(() => {
    const doc = (globalThis as unknown as DomWindow).document;
    const links = Array.from(doc.querySelectorAll('a[href]')).map(
      (a) => `${(a.href ?? '').toLowerCase()} ${(a.textContent ?? '').toLowerCase()}`,
    );
    return {
      returns: links.some((l) => /return|refund|widerruf|rückgabe|استرجاع|إرجاع/.test(l)),
      legal: links.some((l) => /legal|imprint|impressum|terms|agb|الشروط/.test(l)),
      contact:
        doc.querySelector('address') !== null ||
        links.some((l) => l.startsWith('tel:') || l.startsWith('mailto:')),
    };
  });
  const https = ctx.page.url().startsWith('https://');
  return [
    { code: 'https', present: https, value: null },
    { code: 'return_policy', present: page.returns, value: null },
    { code: 'legal_notice', present: page.legal, value: null },
    { code: 'contact_details', present: page.contact, value: null },
    {
      code: 'customer_rating',
      present: facts.rating !== null,
      value: facts.rating ? `${facts.rating.value} (${facts.rating.count})` : null,
    },
    { code: 'delivery_terms', present: facts.deliveryStated, value: null },
  ];
}

export const SignalsSchema = z.array(ReliabilitySignal);

/* ------------------------------------------------------------------ */
/* The generic reader: schema.org JSON-LD, readable text, ICS          */
/* ------------------------------------------------------------------ */

export const ReadInput = z.object({ url: z.string().min(1).max(2048) });
export type ReadInput = z.infer<typeof ReadInput>;

const LdProduct = z.object({
  name: z.string().nullable(),
  sku: z.string().nullable(),
  url: z.string().nullable(),
  price: Money.nullable(),
  shipping: Money.nullable(),
  inStock: z.boolean().nullable(),
  deliveryMinDays: z.number().int().nullable(),
  deliveryMaxDays: z.number().int().nullable(),
  rating: z.object({ value: z.number(), count: z.number().int() }).nullable(),
});

export const ReadOutput = z.object({
  url: z.string(),
  title: z.string(),
  /** Readable text of the page (untrusted; bounded). */
  text: z.string(),
  data: z.object({
    products: z.array(LdProduct),
    reservations: z.array(
      z.object({
        reference: z.string().nullable(),
        confirmed: z.boolean(),
        name: z.string().nullable(),
        start: z.string().nullable(),
        end: z.string().nullable(),
        location: z.string().nullable(),
      }),
    ),
    orders: z.array(
      z.object({
        orderNumber: z.string().nullable(),
        total: Money.nullable(),
        merchant: z.string().nullable(),
      }),
    ),
    ics: z
      .object({
        uid: z.string().nullable(),
        summary: z.string().nullable(),
        start: z.string().nullable(),
        end: z.string().nullable(),
        location: z.string().nullable(),
        artifactId: z.string(),
      })
      .nullable(),
  }),
  screenshotArtifactId: z.string(),
  extractArtifactId: z.string(),
});
export type ReadOutput = z.infer<typeof ReadOutput>;

export const MAX_READ_TEXT = 20_000;

/** Reads one page of a supported site: what it states in structured data, its text, its ICS link. */
export async function readPage(ctx: RecipeContext, url: string): Promise<ReadOutput> {
  const nav = await ctx.goto(url);
  const nodes = jsonLdNodes(await ctx.jsonLd());
  const title = cleanText(await ctx.page.title(), 300) ?? new URL(nav.url).host;
  const text = (
    await ctx.page.evaluate(
      () => (globalThis as unknown as DomWindow).document.body?.innerText ?? '',
    )
  ).slice(0, MAX_READ_TEXT);
  const products = ofType(nodes, 'Product').map((n) => {
    const o = productOffer(n);
    return {
      name: o.name,
      sku: o.sku,
      url: o.url,
      price: o.priceMicro !== null && o.currency ? money(o.priceMicro, o.currency) : null,
      shipping:
        o.shippingMicro !== null && o.shippingCurrency
          ? money(o.shippingMicro, o.shippingCurrency)
          : null,
      inStock: o.inStock,
      deliveryMinDays: o.deliveryMinDays,
      deliveryMaxDays: o.deliveryMaxDays,
      rating: o.rating,
    };
  });
  const reservations = nodes
    .filter((n) => /Reservation$/.test(String(n['@type'] ?? '')))
    .map((n) => {
      const r = reservation(n);
      return {
        reference: r.reference,
        confirmed: r.confirmed,
        name: r.name,
        start: r.start,
        end: r.end,
        location: r.location,
      };
    });
  const orders = ofType(nodes, 'Order').map((n) => {
    const o = order(n);
    return {
      orderNumber: o.orderNumber,
      total: o.priceMicro !== null && o.currency ? money(o.priceMicro, o.currency) : null,
      merchant: o.merchant,
    };
  });
  // An ICS confirmation linked from the page, on the same supported site only.
  let ics: ReadOutput['data']['ics'] = null;
  const icsHref = await ctx.page
    .$eval('a[href$=".ics"], a[href*=".ics?"]', (a) => (a as unknown as DomElement).href ?? '')
    .catch(() => null);
  if (icsHref && ctx.allowed(icsHref)) {
    const file = await ctx.fetchText(icsHref, BROWSER_LIMITS.maxIcsBytes);
    const ev = file.status === 200 ? parseIcs(file.text) : null;
    if (ev) {
      const ref = await ctx.saveIcs(file.text, icsHref);
      ics = {
        uid: ev.uid,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        location: ev.location,
        artifactId: ref.artifactId,
      };
    }
  }
  const shot = await ctx.screenshot();
  const data = { products, reservations, orders, ics };
  const extract = await ctx.saveExtract(
    { url: nav.url, title, data },
    products.length + reservations.length + orders.length + (ics ? 1 : 0),
  );
  return {
    url: nav.url,
    title,
    text,
    data,
    screenshotArtifactId: shot.artifactId,
    extractArtifactId: extract.artifactId,
  };
}

export const readOperation: RecipeOperation<ReadInput, ReadOutput> = {
  description:
    'Read one page of the site: its title, readable text and schema.org data (products, offers, reservations, orders, a linked ICS file), with a screenshot.',
  input: ReadInput,
  output: ReadOutput,
  sideEffect: 'none',
  risk: 'LOW',
  idempotency: 'safe_to_retry',
  run: (ctx, input) => readPage(ctx, input.url),
  verify: (_input, out) => out.screenshotArtifactId.length > 0 && out.extractArtifactId.length > 0,
};

/** Data attributes of an element (a recipe's fixed selectors read page facts from them). */
export async function attrs(
  ctx: RecipeContext,
  selector: string,
): Promise<Record<string, string>[]> {
  return ctx.page.$$eval(selector, (els) =>
    (els as unknown as DomElement[]).slice(0, 50).map((el) => {
      const out: Record<string, string> = {};
      for (const a of Array.from(el.attributes))
        if (a.name.startsWith('data-')) out[a.name.slice(5)] = a.value;
      out.__text = (el.textContent ?? '').trim().slice(0, 300);
      const href = el.href ?? el.querySelector('a')?.href;
      if (href) out.__href = href;
      return out;
    }),
  );
}
