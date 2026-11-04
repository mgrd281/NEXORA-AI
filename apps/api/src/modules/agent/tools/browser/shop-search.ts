/**
 * shop.search — search the supported shops for a product (scenario 3,
 * docs/architecture/phase-c.md §3.6). LOW, read-only, one isolated browser
 * session per shop (in parallel, within the per-user limit). Each offer is
 * read from the merchant's own product page (schema.org Product / Offer:
 * price, shipping, delivery, stock, rating) with a screenshot; reliability
 * signals are page facts. Every shop's outcome (ok / failed / handover) is
 * reported — never hidden — and a shop that stopped at a CAPTCHA is handed
 * over, not worked around.
 *
 * The offers stay in the sessions' recorded results: `searchId` (the session
 * ids) is what shop.compare reads, so page text never has to travel through
 * {{references}}. Offer titles are untrusted text (injection-scanned).
 */
import {
  COMMERCE_LIMITS,
  type BrowserStopReason,
  type Locale,
  type ProductOffer,
} from '@jarvis/contracts';
import { z } from 'zod';
import { runBrowserSession, type BrowserOutcome } from '../../../browser/client';
import { enabledShops, getRecipe } from '../../../browser/sites';
import type { ShopSearchOutput } from '../../../browser/sites/fixture-shop';
import type { Recipe } from '../../../browser/types';
import { AgentError } from '../../errors';
import { hasTemplate } from '../../templates';
import { detectInjection } from '../injection';
import { check, genericApprovalSummary, type ToolDefinition } from '../types';
import { artifactEvidence, deliveryText, money, outcomeError, word } from './common';

export const ShopSearchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('What to look for, in the user’s words (e.g. "FX-100 headphones").'),
  siteIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/))
    .max(5)
    .optional()
    .describe('Only these supported shops (the user named them); default: every supported shop.'),
});
export type ShopSearchInput = z.infer<typeof ShopSearchInput>;

export interface SiteOutcome {
  siteId: string;
  status: 'ok' | 'failed' | 'handover';
  reason: BrowserStopReason | null;
  handoverUrl: string | null;
  sessionId: string | null;
}

export function offerLine(lang: Locale, o: ProductOffer): string {
  const parts = [
    `${word(lang, 'price')} ${money(o.price)}`,
    `${word(lang, 'shipping')} ${o.shipping ? money(o.shipping) : word(lang, 'unknown')}`,
    `${word(lang, 'total')} ${o.total ? money(o.total) : word(lang, 'unknown')}`,
    `${word(lang, 'delivery')} ${deliveryText(lang, o.delivery)}`,
  ];
  if (o.rating) parts.push(`${word(lang, 'rating')} ${o.rating.value} (${o.rating.count})`);
  if (o.inStock === false) parts.push(word(lang, 'outOfStock'));
  return `${o.title} — ${o.merchantName}: ${parts.join(' · ')} · ${word(lang, 'source')}: ${o.productUrl}`;
}

export function siteLine(lang: Locale, s: SiteOutcome): string | null {
  if (s.status === 'ok') return null;
  const name = getRecipe(s.siteId)?.name ?? s.siteId;
  return `${name}: ${word(lang, s.status === 'handover' ? 'siteHandover' : 'siteFailed')} (${s.reason ?? 'BROWSER_CRASHED'})${s.handoverUrl ? ` — ${s.handoverUrl}` : ''}`;
}

export const shopSearchTool: ToolDefinition<ShopSearchInput> = {
  id: 'shop.search',
  version: '1.0.0',
  description:
    'Search the SUPPORTED shops (e.g. "fixture-shop", "fixture-outlet") for a product and read each offer live from the merchant’s page: price, shipping, delivery time, stock, rating and merchant facts, with screenshots. Read-only. Output searchId is what shop.compare takes.',
  inputSchema: ShopSearchInput,
  validatePlanned(input) {
    const out: string[] = [];
    if (typeof input.query === 'string' && hasTemplate(input.query))
      out.push('shop.search query must be the user’s words, never a reference');
    for (const id of input.siteIds ?? []) {
      const r = getRecipe(id);
      if (!r?.shop) out.push(`shop.search: "${id}" is not a supported shop`);
    }
    return out;
  },
  outputFields: ['searchId', 'offerCount', 'text', 'offers', 'sites'],
  requiredConnection: 'web',
  permissions: ['web:read'],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 200_000,
  retry: { maxAttempts: 2, retryableCodes: ['TOOL_TIMEOUT', 'TOOL_FAILED'] },
  modelUse: 'none',
  outbound: true,
  runsInBrowser: true,
  resultTextField: 'text',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ query: input.query, siteIds: input.siteIds ?? 'all supported shops' }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'shop.search',
      fields: [{ label: 'Search', value: input.query }],
    },
    ...genericApprovalSummary(ctx, 'shop.search'),
  }),
  untrustedHost: (output) => {
    const offers = Array.isArray(output.offers) ? (output.offers as ProductOffer[]) : [];
    return offers[0]?.merchantHost ?? null;
  },
  resultFact: (input, output) =>
    `Searched shops for "${input.query}": ${String(output.offerCount ?? 0)} offer(s) read live`,
  async execute(input, rt, signal) {
    const enabled = enabledShops(rt.config);
    const wanted: { id: string; recipe: Recipe | null }[] = input.siteIds?.length
      ? input.siteIds.map((id) => ({ id, recipe: enabled.find((r) => r.id === id) ?? null }))
      : enabled.map((r) => ({ id: r.id, recipe: r }));
    if (wanted.length === 0 || wanted.every((w) => !w.recipe))
      throw new AgentError('TOOL_FAILED', 'No supported shop is available on this server.', {
        reason: 'SITE_UNSUPPORTED',
        params: { host: input.siteIds?.join(', ') || 'shops' },
      });
    const runs = await Promise.allSettled(
      wanted.map((w) =>
        w.recipe
          ? runBrowserSession(
              rt,
              { siteId: w.id, operation: 'search', input: { query: input.query } },
              signal,
            )
          : Promise.reject(
              new AgentError('TOOL_FAILED', 'unsupported', { reason: 'SITE_UNSUPPORTED' }),
            ),
      ),
    );
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    const sites: SiteOutcome[] = [];
    const offers: ProductOffer[] = [];
    const outcomes: BrowserOutcome[] = [];
    let firstError: AgentError | null = null;
    runs.forEach((r, i) => {
      const siteId = wanted[i]!.id;
      if (r.status === 'rejected') {
        const e = r.reason instanceof AgentError ? r.reason : null;
        if (e?.reason === 'BROWSER_UNAVAILABLE') throw e;
        firstError ??= e;
        sites.push({
          siteId,
          status: 'failed',
          reason: (e?.reason as BrowserStopReason) ?? 'SITE_UNSUPPORTED',
          handoverUrl: null,
          sessionId: null,
        });
        return;
      }
      const o = r.value;
      outcomes.push(o);
      if (o.status === 'succeeded' && o.result) {
        const res = o.result as ShopSearchOutput;
        offers.push(...res.offers);
        sites.push({
          siteId,
          status: 'ok',
          reason: null,
          handoverUrl: null,
          sessionId: o.sessionId,
        });
      } else {
        firstError ??= outcomeError(o, {
          siteName: getRecipe(siteId)?.name ?? siteId,
          fallbackHost: '',
          readOnly: true,
        });
        sites.push({
          siteId,
          status: o.status === 'handover' ? 'handover' : 'failed',
          reason: o.stopReason ?? 'BROWSER_CRASHED',
          handoverUrl: o.handoverUrl,
          sessionId: o.sessionId,
        });
      }
    });
    if (!sites.some((s) => s.status === 'ok')) throw firstError!;
    const limited = offers.slice(0, COMMERCE_LIMITS.maxOffers);
    const scan = detectInjection(limited.map((o) => o.title).join('\n'));
    const lang = rt.language;
    const text = [
      `“${input.query}”:`,
      ...(limited.length
        ? limited.map((o) => `• ${offerLine(lang, o)}`)
        : [word(lang, 'noOffers')]),
      ...sites.map((s) => siteLine(lang, s)).filter((l): l is string => l !== null),
    ].join('\n');
    const searchId = sites
      .map((s) => s.sessionId)
      .filter((id): id is string => !!id)
      .join(',');
    return {
      output: {
        searchId,
        offerCount: limited.length,
        offers: limited,
        sites,
        text,
        suspectedInjection: scan.suspectedInjection,
        injectionSignals: scan.injectionSignals,
      },
      outputPreview: {
        query: input.query,
        offerCount: limited.length,
        offers: limited.map((o) => ({
          title: o.title,
          merchant: o.merchantName,
          total: o.total,
          price: o.price,
        })),
        sites: sites.map((s) => ({ siteId: s.siteId, status: s.status, reason: s.reason })),
        suspectedInjection: scan.suspectedInjection,
      },
      evidence: outcomes.flatMap((o) =>
        artifactEvidence(o.artifacts, ((o.result as ShopSearchOutput | null)?.offers ?? []).length),
      ),
      costMicro: 0,
    };
  },
  verify(_input, output) {
    const count = Number(output.offerCount ?? 0);
    const sites = Array.isArray(output.sites) ? (output.sites as SiteOutcome[]) : [];
    const checks = [
      check(
        'offersCompared',
        `${count} offer(s) read live from ${sites.filter((s) => s.status === 'ok').length} shop(s)`,
        { count },
      ),
    ];
    if (output.suspectedInjection === true)
      checks.push(
        check(
          'injectionFlagged',
          'Shop pages flagged as containing instructions aimed at AI assistants (ignored)',
        ),
      );
    return { ok: typeof output.searchId === 'string' && output.searchId.length > 0, checks };
  },
};
