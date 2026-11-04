/**
 * shop.compare — rank the offers shop.search read, deterministically
 * (scenario 3, docs/architecture/phase-c.md §3.6). LOW, no browser, no model:
 * the offers come from this task's own search sessions (their recorded,
 * validated results — never from text passed along), ranked by known total
 * (price + shipping, same currency), then delivery time; an unknown shipping
 * cost stays unknown and ranks after the known totals; different currencies are
 * not converted (mixedCurrencies, no "best" across them). Out-of-stock offers
 * rank last. The result text is a table with each offer's source page.
 *
 * `bestOffer` (the first ranked offer with a known total) is what
 * shop.prepare_cart references.
 */
import { ProductOffer, type ShoppingComparison } from '@jarvis/contracts';
import { COMMERCE_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { sessionsOfTask } from '../../../browser/client';
import type { ShopSearchOutput } from '../../../browser/sites/fixture-shop';
import { AgentError } from '../../errors';
import { check, genericApprovalSummary, type ToolDefinition } from '../types';
import { isRef, word } from './common';
import { offerLine, siteLine } from './shop-search';

export const ShopCompareInput = z.object({
  searchIds: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(5)
    .describe('References to shop.search output searchId, e.g. ["{{s1.searchId}}"].'),
  preference: z
    .enum(['total', 'delivery'])
    .default('total')
    .describe('Rank by lowest known total (default) or by fastest delivery.'),
});
export type ShopCompareInput = z.infer<typeof ShopCompareInput>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cmpNullLast = (a: number | null, b: number | null) =>
  a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : a - b;

/**
 * Whether an offer is the product the query names: every model-number-like
 * token of the query (one with a digit, e.g. "fx-100") is in its title. A shop
 * may list related products; only matching ones can be the best offer.
 */
export function matchesQuery(query: string, title: string): boolean {
  const strong = (query.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []).filter(
    (t) => /\d/.test(t),
  );
  const t = title.toLowerCase();
  return strong.every((s) => t.includes(s));
}

/** Deterministic ranking (pure; unit-tested). */
export function rankOffers(
  offers: readonly ProductOffer[],
  preference: 'total' | 'delivery',
): ProductOffer[] {
  return [...offers].sort((a, b) => {
    const stock = Number(a.inStock === false) - Number(b.inStock === false);
    if (stock) return stock;
    const known = Number(a.total === null) - Number(b.total === null);
    const byTotal = cmpNullLast(a.total?.amountMicro ?? null, b.total?.amountMicro ?? null);
    const byDelivery = cmpNullLast(a.delivery.maxDays, b.delivery.maxDays);
    const byCurrency = (a.total?.currency ?? a.price.currency).localeCompare(
      b.total?.currency ?? b.price.currency,
    );
    const steps =
      preference === 'delivery'
        ? [byDelivery, known, byCurrency, byTotal]
        : [known, byCurrency, byTotal, byDelivery];
    for (const s of steps) if (s) return s;
    return (b.rating?.value ?? -1) - (a.rating?.value ?? -1) || a.id.localeCompare(b.id);
  });
}

export const shopCompareTool: ToolDefinition<ShopCompareInput> = {
  id: 'shop.compare',
  version: '1.0.0',
  description:
    'Compare the offers a shop.search step read (searchIds: references to its searchId): ranked by lowest known total (price + shipping) or by delivery time, with every offer’s source. Deterministic; nothing is bought. Output bestOffer is what shop.prepare_cart references.',
  inputSchema: ShopCompareInput,
  allowedRefTools: ['shop.search'],
  validatePlanned(input) {
    return (input.searchIds ?? []).every((s) => isRef(s))
      ? []
      : ['shop.compare searchIds must be references to shop.search searchId ({{sN.searchId}})'];
  },
  outputFields: ['comparison', 'bestOfferId', 'bestOffer', 'text', 'offerCount'],
  requiredConnection: 'web',
  permissions: ['web:read'],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 15_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  resultTextField: 'text',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ searches: input.searchIds.length, preference: input.preference }),
  approvalDetails: (_input, ctx) => ({
    details: { kind: 'generic', toolId: 'shop.compare', fields: [] },
    ...genericApprovalSummary(ctx, 'shop.compare'),
  }),
  untrustedHost: (output) => {
    const best = output.bestOffer as ProductOffer | null | undefined;
    return best?.merchantHost ?? null;
  },
  resultFact: (_input, output) => {
    const best = output.bestOffer as ProductOffer | null | undefined;
    return best
      ? `Best known total: ${best.title} at ${best.merchantName}`
      : 'Compared the offers; none has a known total';
  },
  async execute(input, rt) {
    const ids = [
      ...new Set(
        input.searchIds
          .flatMap((s) => s.split(','))
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0 || ids.some((id) => !UUID.test(id)))
      throw new AgentError('TOOL_FAILED', 'The searches to compare are missing.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'shop.compare' },
      });
    const rows = await sessionsOfTask(rt, ids);
    if (rows.length !== ids.length || rows.some((r) => r.operation !== 'search'))
      throw new AgentError('TOOL_FAILED', 'Those searches are not this task’s.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'shop.compare' },
      });
    const offers: ProductOffer[] = [];
    const sites: ShoppingComparison['sites'] = [];
    let query = '';
    for (const row of rows.sort((a, b) => a.site_id.localeCompare(b.site_id))) {
      if (row.status === 'succeeded') {
        const res = row.result as ShopSearchOutput;
        query ||= res.query;
        for (const o of res.offers) {
          const p = ProductOffer.safeParse(o);
          if (p.success) offers.push(p.data);
        }
        sites.push({ siteId: row.site_id, status: 'ok', reason: null });
      } else {
        sites.push({
          siteId: row.site_id,
          status: row.status === 'handover' ? 'handover' : 'failed',
          reason: row.stop_reason ?? 'BROWSER_CRASHED',
        });
      }
    }
    const ranked = rankOffers(offers, input.preference).slice(0, COMMERCE_LIMITS.maxOffers);
    const currencies = new Set(ranked.map((o) => (o.total ?? o.price).currency));
    const mixedCurrencies = currencies.size > 1;
    const best = mixedCurrencies
      ? null
      : (ranked.find(
          (o) => o.total !== null && o.inStock !== false && matchesQuery(query, o.title),
        ) ?? null);
    const comparison: ShoppingComparison = {
      query,
      offers: ranked,
      ranking: ranked.map((o) => o.id),
      sites,
      mixedCurrencies,
      generatedAt: new Date().toISOString(),
    };
    const lang = rt.language;
    const text = [
      `“${query}”:`,
      ...(ranked.length
        ? ranked.map((o, i) => `${i + 1}. ${offerLine(lang, o)}`)
        : [word(lang, 'noOffers')]),
      ...(best ? [`${word(lang, 'best')}: ${best.title} — ${best.merchantName}`] : []),
      ...(mixedCurrencies ? [word(lang, 'mixed')] : []),
      ...sites
        .map((s) => siteLine(lang, { ...s, handoverUrl: null, sessionId: null }))
        .filter((l): l is string => l !== null),
    ].join('\n');
    return {
      output: {
        comparison,
        bestOfferId: best?.id ?? null,
        bestOffer: best,
        text,
        offerCount: ranked.length,
      },
      // The full contract object (clients render the comparison with shipping, delivery,
      // signals and per-offer evidence from it), plus the compact fields older clients read.
      outputPreview: {
        comparison,
        bestOfferId: best?.id ?? null,
        offerCount: ranked.length,
        ranking: ranked.map((o) => ({ title: o.title, merchant: o.merchantName, total: o.total })),
        best: best ? { title: best.title, merchant: best.merchantName, total: best.total } : null,
        mixedCurrencies,
      },
      evidence: [],
      costMicro: 0,
    };
  },
  verify(_input, output) {
    const count = Number(output.offerCount ?? 0);
    return {
      ok: typeof output.text === 'string',
      checks: [
        check('offersCompared', `${count} offer(s) compared, each with its source page`, { count }),
      ],
    };
  },
};
