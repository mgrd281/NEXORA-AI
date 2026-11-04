/**
 * Offline intents for shopping on supported shops (docs/architecture/phase-c.md §3.6;
 * scenarios 3 and 7), en/de/ar:
 *
 *   "compare prices for <product> [on <shop> and <shop>]" / "vergleiche die Preise für …" /
 *   "قارن أسعار …"                       → shop.search → shop.compare
 *   "buy [2] <product> on <shop>" / "kaufe … bei …" / "اشترِ … من …"
 *        → shop.search { siteIds: [shop] } → shop.compare → shop.prepare_cart { offer:
 *          {{s2.bestOffer}}, quantity } → shop.checkout { order: {{s3.checkoutDetails}} }
 *        (shops whose recipe cannot order stop at the prepared cart, which is handed over)
 *   "buy <product>" without a supported shop → assistant.clarify ['site']; no product → ['product']
 *
 * The product, the shop and the quantity come only from the user's words; prices
 * and offers only from the live pages at run time. The Policy Engine then decides
 * about the checkout (purchases off by default → PURCHASES_DISABLED, scenario 7).
 * "… and buy the cheaper one" without naming a shop compares only: which shop
 * would be the cheaper one is not known before the pages are read, and the
 * planner never chooses a merchant from content.
 */
import { COMMERCE_LIMITS } from '@jarvis/contracts';
import { recipesNamedIn } from '../../../browser/sites';
import type { Recipe } from '../../../browser/types';
import { msg } from '../../i18n';
import type { Plan } from '../../plan';
import {
  clarify,
  objective,
  stepTitled,
  titled,
  type OfflineIntent,
  type OfflinePlanContext,
  type OfflinePlanResult,
} from '../types';
import { productQuery, splitQuantity } from './parse';

const COMPARE: RegExp[] = [
  /^\s*(?:please\s+)?compare\s+(?:the\s+)?(?:prices?|offers?|deals?)\s+(?:of|for|on)\s+(.+?)\s*$/i,
  /^\s*(?:please\s+)?compare\s+(.+?)\s+(?:prices?|offers?|deals?)\s*$/i,
  /^\s*(?:please\s+)?(?:find|show)\s+(?:me\s+)?(?:the\s+)?(?:best|cheapest|lowest)\s+(?:price|offer|deal)s?\s+(?:for|on)\s+(.+?)\s*$/i,
  /^\s*where\s+is\s+(.+?)\s+cheapest\s*$/i,
  /^\s*(?:bitte\s+)?vergleiche?\s+(?:die\s+)?(?:preise|angebote)\s+(?:für|von)\s+(.+?)\s*$/i,
  /^\s*(?:bitte\s+)?preisvergleich\s+(?:für\s+)?(.+?)\s*$/i,
  /^\s*(?:bitte\s+)?(?:finde|zeig\w*)\s+(?:mir\s+)?(?:den|das)\s+(?:günstigste\w*|beste\w*)\s+(?:angebot|preis)\s+(?:für)\s+(.+?)\s*$/i,
  /^\s*(?:من\s+فضلك\s+)?قارن\s+(?:بين\s+)?(?:أسعار|اسعار|عروض)\s+(.+?)\s*$/,
  /^\s*(?:من\s+فضلك\s+)?(?:ابحث\s+عن|جد)\s+(?:أرخص|ارخص|أفضل)\s+(?:سعر|عرض)\s+(?:لـ|ل|ل\s)?\s*(.+?)\s*$/,
];

const BUY: RegExp[] = [
  /^\s*(?:please\s+)?(?:buy|order|purchase)\s+(?:me\s+)?(.+?)\s+(?:on|at|from)\s+(.+?)\s*$/i,
  /^\s*(?:bitte\s+)?(?:kaufe?|bestelle?)\s+(?:mir\s+)?(.+?)\s+(?:bei|auf|im|von)\s+(.+?)\s*$/i,
  /^\s*(?:من\s+فضلك\s+)?(?:اشتر|اشترِ|اشتري|اطلب)\s+(?:لي\s+)?(.+?)\s+(?:من|في|على)\s+(.+?)\s*$/,
];
const BUY_BARE: RegExp[] = [
  /^\s*(?:please\s+)?(?:buy|order|purchase)\s+(?:me\s+)?(.+?)\s*$/i,
  /^\s*(?:bitte\s+)?(?:kaufe?|bestelle?)\s+(?:mir\s+)?(.+?)\s*$/i,
  /^\s*(?:من\s+فضلك\s+)?(?:اشتر|اشترِ|اشتري|اطلب)\s+(?:لي\s+)?(.+?)\s*$/,
];

/** "… and buy the cheaper one" and similar tails of a comparison. */
const AND_BUY =
  /\s+(?:and|then|und|dann|و)\s*(?:then\s+|dann\s+)?(?:buy|order|kauf\w*|bestell\w*|اشتر\w*|اطلب\w*)\b[\s\S]*$/iu;
/** Trailing "on Fixture Shop and Fixture Outlet" (the shops are read separately). */
const ON_SHOPS = /\s+(?:on|at|in|from|bei|auf|im|von|في|من|على)\s+[\s\S]*$/iu;
/** A purchase is something on a page JARVIS reads; a link is the summarize intent's. */
const LINK = /\bhttps?:\/\/|\bwww\./i;

const clean = (s: string) => s.replace(/[.?!؟。]+$/u, '').trim();

function searchSteps(
  ctx: OfflinePlanContext,
  query: string,
  shops: readonly Recipe[],
): Plan['steps'] {
  const lang = ctx.language;
  return [
    {
      key: 's1',
      toolId: 'shop.search',
      ...stepTitled(lang, msg('step.searchShops', { query })),
      input: { query, ...(shops.length ? { siteIds: shops.map((r) => r.id) } : {}) },
    },
    {
      key: 's2',
      toolId: 'shop.compare',
      ...stepTitled(lang, msg('step.compareOffers')),
      input: { searchIds: ['{{s1.searchId}}'] },
    },
  ];
}

function comparePlan(
  ctx: OfflinePlanContext,
  query: string,
  shops: readonly Recipe[],
): OfflinePlanResult {
  const lang = ctx.language;
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.compareProducts', { query })),
      ...objective(lang, msg('objective.compareProducts', { query })),
      steps: searchSteps(ctx, query, shops),
    },
  };
}

function buyPlan(
  ctx: OfflinePlanContext,
  query: string,
  quantity: number,
  shop: Recipe,
): OfflinePlanResult {
  const lang = ctx.language;
  const site = shop.name;
  const steps = searchSteps(ctx, query, [shop]);
  steps.push({
    key: 's3',
    toolId: 'shop.prepare_cart',
    ...stepTitled(lang, msg('step.prepareCart', { site })),
    input: { siteId: shop.id, offer: '{{s2.bestOffer}}', quantity },
  });
  // Shops whose recipe cannot order end with the prepared cart (handed over to the user).
  if (shop.shop?.checkout)
    steps.push({
      key: 's4',
      toolId: 'shop.checkout',
      ...stepTitled(lang, msg('step.checkout', { site })),
      input: { siteId: shop.id, order: '{{s3.checkoutDetails}}' },
    });
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.buy', { product: query, site })),
      ...objective(lang, msg('objective.buy', { product: query, site })),
      steps,
    },
  };
}

export const compareProductsIntent: OfflineIntent = {
  id: 'shop.compare',
  plan(request, ctx) {
    const text = clean(request);
    if (LINK.test(text)) return null;
    for (const re of COMPARE) {
      const m = re.exec(text);
      if (!m) continue;
      const shops = recipesNamedIn(m[1]!).filter((r) => r.shop);
      let phrase = m[1]!.replace(AND_BUY, '');
      if (shops.length) phrase = phrase.replace(ON_SHOPS, '');
      const query = productQuery(phrase);
      if (!query) return clarify(ctx.language, ['product']);
      return comparePlan(ctx, query, shops);
    }
    return null;
  },
};

export const buyProductIntent: OfflineIntent = {
  id: 'shop.buy',
  plan(request, ctx) {
    const text = clean(request);
    if (LINK.test(text)) return null;
    for (const re of BUY) {
      const m = re.exec(text);
      if (!m) continue;
      const shop = recipesNamedIn(m[2]!).find((r) => r.shop);
      if (!shop) continue; // "order it from Bob" etc.: not a shop JARVIS supports — see below
      const { quantity, rest } = splitQuantity(m[1]!);
      const query = productQuery(rest);
      if (!query) return clarify(ctx.language, ['product']);
      const q = quantity ?? 1;
      if (q < 1 || q > COMMERCE_LIMITS.maxQuantityPerLine)
        return clarify(ctx.language, ['product']);
      return buyPlan(ctx, query, q, shop);
    }
    for (const re of BUY_BARE) {
      const m = re.exec(text);
      if (!m) continue;
      // "buy …" naming no supported shop: ask where (never pick a merchant for the user).
      const { rest } = splitQuantity(m[1]!);
      if (!productQuery(rest.replace(ON_SHOPS, ''))) return clarify(ctx.language, ['product']);
      return clarify(ctx.language, ['site']);
    }
    return null;
  },
};

/** The answer to "which shop?" / "which product?" asked by the buy intent above. */
export const shoppingAnswerIntent: OfflineIntent = {
  id: 'shop.answer',
  plan(request, ctx) {
    const last = (ctx.conversation ?? []).at(-1);
    if (last?.outcome !== 'question') return null;
    const missing = last.missing ?? [];
    const asked = clean(last.request);
    if (!BUY_BARE.some((re) => re.test(asked))) return null;
    const answer = clean(request);
    const earlier = { ...ctx, conversation: (ctx.conversation ?? []).slice(0, -1) };
    if (missing.includes('site') && recipesNamedIn(answer).some((r) => r.shop))
      return buyProductIntent.plan(`${asked} on ${answer}`, earlier);
    if (missing.includes('product') && answer) {
      const shop = recipesNamedIn(asked).find((r) => r.shop);
      const verb = /^\s*(\S+)/.exec(asked)?.[1] ?? 'buy';
      return shop ? buyProductIntent.plan(`${verb} ${answer} on ${shop.name}`, earlier) : null;
    }
    return null;
  },
};
