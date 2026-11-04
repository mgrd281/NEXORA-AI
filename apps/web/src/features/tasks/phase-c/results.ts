/**
 * What the Phase C tools produced, read from a task's steps (their display-safe outputs) and
 * browser sessions: email threads, a product comparison, appointment slots, a booking, an
 * order, a prepared cart and where the user can continue themselves (handover). A full contract
 * object (EmailThreadSummary[], ShoppingComparison, BookingSlots, PreparedCart) is used when the
 * output carries one; otherwise the fields the tools' previews carry today. Nothing is made up:
 * a fact the output doesn't state stays null. Pure — unit-tested in test/phase-c.test.ts.
 */
import type {
  BrowserSession,
  BrowserStopReason,
  EmailThreadSummary,
  Money as MoneyValue,
  ProductOffer,
  ReliabilitySignal,
  ShoppingComparison as ShoppingComparisonValue,
  TaskDetail,
  TaskStep,
} from '@jarvis/contracts';
import {
  BookingSlots,
  BrowserStopReason as BrowserStopReasonEnum,
  EmailThreadSummary as EmailThreadSummarySchema,
  Money,
  PreparedCart,
  ShoppingComparison,
} from '@jarvis/contracts';
import { z } from 'zod';
import { parseMoneyParam } from '@/lib/money';
import { safeExternalUrl } from '../model';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = (v: unknown): MoneyValue | null => {
  const parsed = Money.safeParse(v);
  return parsed.success ? parsed.data : parseMoneyParam(v);
};

/** The last step of a tool that succeeded. */
export function succeeded(steps: readonly TaskStep[], toolId: TaskStep['toolId']): TaskStep | null {
  return [...steps].reverse().find((s) => s.toolId === toolId && s.status === 'SUCCEEDED') ?? null;
}

/* ------------------------------------------------------------------ email */

export interface EmailSearchView {
  provider: string | null;
  count: number;
  /** Thread metadata, when the output carries it. */
  threads: EmailThreadSummary[] | null;
  /** The tool's text list (sender, subject, snippet — untrusted text), when it carries no threads. */
  text: string | null;
  /** The search asked for threads waiting for a reply. */
  needsReply: boolean;
  unreadOnly: boolean;
  suspectedInjection: boolean;
}

export function emailSearchView(step: TaskStep | null): EmailSearchView | null {
  if (!step?.output) return null;
  const out = step.output;
  const threads = z.array(EmailThreadSummarySchema).safeParse(out.threads);
  return {
    provider: str(out.provider),
    count: num(out.count) ?? (threads.success ? threads.data.length : 0),
    threads: threads.success ? threads.data : null,
    text: str(out.text),
    needsReply: step.inputPreview.needsReply === true,
    unreadOnly: step.inputPreview.unreadOnly === true,
    suspectedInjection: out.suspectedInjection === true,
  };
}

/* ------------------------------------------------------------------ shopping */

export interface ComparisonRow {
  key: string;
  title: string;
  merchant: string;
  merchantHost: string | null;
  productUrl: string | null;
  price: MoneyValue | null;
  /** undefined: the output doesn't say; null: the page states no shipping cost. */
  shipping: MoneyValue | null | undefined;
  total: MoneyValue | null;
  delivery: ProductOffer['delivery'] | null;
  inStock: boolean | null;
  rating: ProductOffer['rating'];
  signals: ReliabilitySignal[];
  evidenceArtifactId: string | null;
}

export interface ComparisonView {
  query: string | null;
  rows: ComparisonRow[];
  /** The best offer's key (lowest known total in stock), if the tool named one. */
  bestKey: string | null;
  sites: Array<{
    siteId: string;
    status: 'ok' | 'failed' | 'handover';
    reason: BrowserStopReason | null;
  }>;
  mixedCurrencies: boolean;
  /** Full offers (delivery, reliability signals, evidence per offer) are known. */
  detailed: boolean;
}

const rowKey = (title: string, merchant: string) => `${merchant}\u0000${title}`;

function rowsFromComparison(c: ShoppingComparisonValue): ComparisonRow[] {
  const byId = new Map(c.offers.map((o) => [o.id, o]));
  const ordered = [
    ...c.ranking.map((id) => byId.get(id)).filter((o): o is ProductOffer => o !== undefined),
    ...c.offers.filter((o) => !c.ranking.includes(o.id)),
  ];
  return ordered.map((o) => ({
    key: o.id,
    title: o.title,
    merchant: o.merchantName,
    merchantHost: o.merchantHost,
    productUrl: safeExternalUrl(o.productUrl),
    price: o.price,
    shipping: o.shipping,
    total: o.total,
    delivery: o.delivery,
    inStock: o.inStock,
    rating: o.rating,
    signals: o.signals,
    evidenceArtifactId: o.evidenceArtifactId,
  }));
}

const SiteOutcome = z.object({
  siteId: z.string(),
  status: z.enum(['ok', 'failed', 'handover']),
  reason: BrowserStopReasonEnum.nullable(),
});

/**
 * The comparison of a shop.compare step (and the shop.search steps before it). With only the
 * previews, shipping is total − price when both are known in the same currency (both stated by
 * the page), and unknown otherwise.
 */
export function comparisonView(steps: readonly TaskStep[]): ComparisonView | null {
  const compare = succeeded(steps, 'shop.compare');
  const searches = steps.filter((s) => s.toolId === 'shop.search' && s.status === 'SUCCEEDED');
  if (!compare && searches.length === 0) return null;
  const full = ShoppingComparison.safeParse(compare?.output?.comparison);
  if (full.success) {
    const bestId = str(compare?.output?.bestOfferId);
    return {
      query: full.data.query,
      rows: rowsFromComparison(full.data),
      bestKey: bestId,
      sites: full.data.sites,
      mixedCurrencies: full.data.mixedCurrencies,
      detailed: true,
    };
  }

  // Preview shapes: search offers {title, merchant, total, price}; compare ranking {title,
  // merchant, total}, best {title, merchant, total}.
  const offers = new Map<
    string,
    { title: string; merchant: string; price: MoneyValue | null; total: MoneyValue | null }
  >();
  const sites: ComparisonView['sites'] = [];
  let query: string | null = null;
  for (const s of searches) {
    query ??= str(s.output?.query) ?? str(s.inputPreview.query);
    for (const raw of Array.isArray(s.output?.offers) ? s.output.offers : []) {
      const o = raw as Record<string, unknown>;
      const title = str(o.title);
      const merchant = str(o.merchant);
      if (!title || !merchant) continue;
      offers.set(rowKey(title, merchant), {
        title,
        merchant,
        price: money(o.price),
        total: money(o.total),
      });
    }
    for (const raw of Array.isArray(s.output?.sites) ? s.output.sites : []) {
      const site = SiteOutcome.safeParse(raw);
      if (site.success && !sites.some((x) => x.siteId === site.data.siteId)) sites.push(site.data);
    }
  }
  const ranking = Array.isArray(compare?.output?.ranking) ? compare.output.ranking : [];
  const order: string[] = [];
  for (const raw of ranking) {
    const o = raw as Record<string, unknown>;
    const title = str(o.title);
    const merchant = str(o.merchant);
    if (!title || !merchant) continue;
    const key = rowKey(title, merchant);
    if (!offers.has(key)) offers.set(key, { title, merchant, price: null, total: money(o.total) });
    order.push(key);
  }
  for (const key of offers.keys()) if (!order.includes(key)) order.push(key);
  const rows: ComparisonRow[] = order.map((key) => {
    const o = offers.get(key)!;
    // total = price + shipping when the page states both; a price without a total means the
    // page states no shipping cost (null: shown as "not stated", never as free).
    const diff =
      o.price && o.total && o.price.currency === o.total.currency
        ? { amountMicro: o.total.amountMicro - o.price.amountMicro, currency: o.total.currency }
        : null;
    const shipping = diff && diff.amountMicro >= 0 ? diff : o.price && !o.total ? null : undefined;
    return {
      key,
      title: o.title,
      merchant: o.merchant,
      merchantHost: null,
      productUrl: null,
      price: o.price,
      shipping,
      total: o.total,
      delivery: null,
      inStock: null,
      rating: null,
      signals: [],
      evidenceArtifactId: null,
    };
  });
  const best = compare?.output?.best as Record<string, unknown> | null | undefined;
  const bestTitle = str(best?.title);
  const bestMerchant = str(best?.merchant);
  return {
    query,
    rows,
    bestKey: bestTitle && bestMerchant ? rowKey(bestTitle, bestMerchant) : null,
    sites,
    mixedCurrencies: compare?.output?.mixedCurrencies === true,
    detailed: false,
  };
}

export interface CartView {
  merchant: string | null;
  lines: Array<{
    title: string;
    quantity: number;
    lineTotal: MoneyValue | null;
    unitPrice: MoneyValue | null;
  }>;
  subtotal: MoneyValue | null;
  shipping: MoneyValue | null | undefined;
  total: MoneyValue | null;
  checkoutSupported: boolean | null;
  handoverUrl: string | null;
}

export function cartView(step: TaskStep | null): CartView | null {
  if (!step?.output) return null;
  const out = step.output;
  const full = PreparedCart.safeParse(out.cart);
  if (full.success) {
    const c = full.data;
    return {
      merchant: c.merchantName,
      lines: c.lines.map((l) => ({
        title: l.title,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
        unitPrice: l.unitPrice,
      })),
      subtotal: c.subtotal,
      shipping: c.shipping,
      total: c.total,
      checkoutSupported: c.checkoutSupported,
      handoverUrl: safeExternalUrl(c.handoverUrl),
    };
  }
  const lines = (Array.isArray(out.lines) ? out.lines : []).flatMap((raw) => {
    const l = raw as Record<string, unknown>;
    const title = str(l.title);
    const quantity = num(l.quantity);
    return title && quantity
      ? [{ title, quantity, lineTotal: money(l.lineTotal), unitPrice: money(l.unitPrice) }]
      : [];
  });
  if (lines.length === 0) return null;
  return {
    merchant: str(out.merchant),
    lines,
    subtotal: null,
    shipping: undefined,
    total: money(out.total),
    checkoutSupported: typeof out.checkoutSupported === 'boolean' ? out.checkoutSupported : null,
    handoverUrl: safeExternalUrl(str(out.handoverUrl)),
  };
}

/* ------------------------------------------------------------------ booking */

export interface SlotsView {
  siteId: string | null;
  siteName: string | null;
  service: string | null;
  slots: Array<{ start: string; end: string | null; timeZone: string; price: MoneyValue | null }>;
  /** How many free times the site offered (the list may show the first ones only). */
  total: number;
  requiredFields: string[];
  evidenceArtifactId: string | null;
}

export function slotsView(step: TaskStep | null): SlotsView | null {
  if (!step?.output) return null;
  const out = step.output;
  const full = BookingSlots.safeParse(out.result);
  if (full.success) {
    const r = full.data;
    return {
      siteId: r.siteId,
      siteName: r.siteName,
      service: r.service,
      slots: r.slots.map((s) => ({
        start: s.start,
        end: s.end,
        timeZone: s.timeZone,
        price: s.price,
      })),
      total: r.slots.length,
      requiredFields: r.requiredFields,
      evidenceArtifactId: r.evidenceArtifactId,
    };
  }
  const slots = (Array.isArray(out.slots) ? out.slots : []).flatMap((raw) => {
    const s = raw as Record<string, unknown>;
    const start = str(s.start);
    const timeZone = str(s.timeZone);
    return start && timeZone && !Number.isNaN(Date.parse(start))
      ? [{ start, end: str(s.end), timeZone, price: money(s.price) }]
      : [];
  });
  return {
    siteId: str(out.siteId),
    siteName: null,
    service: str(out.service),
    slots,
    total: num(out.slotCount) ?? slots.length,
    requiredFields: Array.isArray(out.requiredFields)
      ? out.requiredFields.filter((f): f is string => typeof f === 'string')
      : [],
    evidenceArtifactId: str(out.evidenceArtifactId),
  };
}

/** booking.book's output: the booking row to read, and what the site confirmed. */
export function bookedView(step: TaskStep | null) {
  const out = step?.output;
  const bookingId = str(out?.bookingId);
  if (!out || !bookingId) return null;
  return {
    bookingId,
    reference: str(out.reference),
    start: str(out.start),
    end: str(out.end),
    timeZone: str(out.timeZone),
    location: str(out.location),
  };
}

/** shop.checkout's output: the order row to read. */
export function orderedView(step: TaskStep | null) {
  const out = step?.output;
  const orderId = str(out?.orderId);
  if (!out || !orderId) return null;
  return {
    orderId,
    merchantOrderId: str(out.merchantOrderId),
    total: money(out.total),
    merchant: str(out.merchant),
  };
}

/* ------------------------------------------------------------------ calendar */

/** calendar.free_busy / calendar.list: the tool's text (times it found), if any. */
export function calendarText(step: TaskStep | null): string | null {
  return str(step?.output?.text);
}

/* ------------------------------------------------------------------ browser sessions */

/** "fixture-shop" → "Fixture Shop" (recipe ids name their site), or a name a step stated. */
export function siteLabel(siteId: string, known: ReadonlyMap<string, string> = new Map()): string {
  return (
    known.get(siteId) ??
    siteId
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

/**
 * Site names the task itself states: its browser sessions (the recipe's name), its approvals
 * (booking, purchase, form submission) and its server-written step titles ({ site } of a step
 * whose input names the site's recipe).
 */
export function knownSiteNames(
  task: Pick<TaskDetail, 'approvals' | 'steps'> & {
    browserSessions?: TaskDetail['browserSessions'];
  },
): Map<string, string> {
  const names = new Map<string, string>();
  // The server's own recipe name first (newer servers send it with each session).
  for (const s of task.browserSessions ?? []) if (s.siteName) names.set(s.siteId, s.siteName);
  for (const step of task.steps) {
    const siteId = str(step.inputPreview.siteId);
    const site = step.titleMessage?.params?.site;
    if (siteId && typeof site === 'string' && site.trim()) names.set(siteId, site);
  }
  for (const a of task.approvals) {
    const d = a.details;
    if (d.kind === 'booking' || d.kind === 'form_submission') names.set(d.siteId, d.siteName);
    if (d.kind === 'purchase') names.set(d.siteId, d.merchant.name);
  }
  return names;
}

export interface Handover {
  url: string;
  host: string | null;
  reason: BrowserStopReason | null;
}

/**
 * Where the user continues themselves after the browser agent stopped at a CAPTCHA, a sign-in
 * or bot protection: the session's handover URL (http(s) only).
 */
export function handoverOf(sessions: readonly BrowserSession[] | undefined): Handover | null {
  const s = [...(sessions ?? [])].reverse().find((x) => x.status === 'handover' && x.handoverUrl);
  const url = safeExternalUrl(s?.handoverUrl);
  if (!s || !url) return null;
  let host: string | null = null;
  try {
    host = new URL(url).host;
  } catch {
    host = null;
  }
  return { url, host, reason: s.stopReason };
}
