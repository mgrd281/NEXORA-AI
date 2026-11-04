/**
 * Shared by the browser + commerce tools (docs/architecture/phase-c.md §3.4–3.6):
 * the browser outcome → TaskError mapping, evidence entries for stored
 * artifacts, "a reference or the object it resolves to" input fields, and the
 * small en/de/ar vocabulary of the tools' text results (page content stays as
 * the site wrote it).
 */
import type { BrowserStopReason, Evidence, Locale, Money, ToolId } from '@jarvis/contracts';
import { moneyParam } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../../db/pool';
import type { EvidenceArtifactRow } from '../../../../db/types';
import { hashObject } from '../../../../lib/crypto';
import type { BrowserOutcome } from '../../../browser/client';
import { siteUnsupported } from '../../../browser/client';
import { enabledOrigins, getRecipe, operationOf } from '../../../browser/sites';
import type { Recipe, SiteConfig } from '../../../browser/types';
import { AgentError } from '../../errors';
import { hasTemplate } from '../../templates';
import { evidence, type ToolRuntime } from '../types';

/** A whole-string step reference, e.g. "{{s2.bestOffer}}". */
export const SINGLE_REF = /^\{\{\s*[A-Za-z][\w-]{0,31}\.[A-Za-z]\w{0,63}\s*\}\}$/;

/**
 * An input field that is a reference to an earlier step's object output
 * (planned: "{{s2.bestOffer}}") and, once resolved (a JSON string), that
 * object validated by `schema`. Literal objects pass the schema but are
 * refused by the tools' validatePlanned: these facts come from a live page
 * through a reference, never from the planner.
 */
export function refOr<T extends z.ZodTypeAny>(schema: T, description: string) {
  return z
    .preprocess(
      (v) => {
        // A resolved reference is the JSON of the referenced object (which may well contain
        // "}}" itself); only a whole-string {{reference}} stays a string.
        if (typeof v === 'string' && !SINGLE_REF.test(v)) {
          try {
            return JSON.parse(v) as unknown;
          } catch {
            return v;
          }
        }
        return v;
      },
      z.union([z.string().regex(SINGLE_REF, 'must be a reference like {{s2.bestOffer}}'), schema]),
    )
    .describe(description);
}

export const isRef = (v: unknown): v is string => typeof v === 'string' && SINGLE_REF.test(v);

export const SiteId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .describe('Id of a supported site (recipe), e.g. "fixture-shop". Never invent one.');

/** The registered recipe, or a planning issue. */
export function plannedRecipe(
  siteId: unknown,
  need?: string,
): { recipe: Recipe | null; issues: string[] } {
  if (typeof siteId !== 'string' || hasTemplate(siteId))
    return { recipe: null, issues: ['siteId must be the literal id of a supported site'] };
  const recipe = getRecipe(siteId);
  if (!recipe) return { recipe: null, issues: [`siteId "${siteId}" is not a supported site`] };
  if (need && !operationOf(recipe, need))
    return { recipe, issues: [`${recipe.name} does not support "${need}"`] };
  return { recipe, issues: [] };
}

/** The enabled recipe for an execution, or SITE_UNSUPPORTED. */
export function enabledRecipe(
  config: SiteConfig,
  siteId: string,
): { recipe: Recipe; origins: string[] } {
  const recipe = getRecipe(siteId);
  const origins = enabledOrigins(config, siteId);
  if (!recipe || !origins) throw siteUnsupported(siteId);
  return { recipe, origins };
}

export const hostOf = (raw: string | null | undefined): string => {
  try {
    return raw ? new URL(raw).host : '';
  } catch {
    return '';
  }
};

const HANDOVER: ReadonlySet<BrowserStopReason> = new Set([
  'CAPTCHA_DETECTED',
  'LOGIN_REQUIRED',
  'BOT_PROTECTION',
]);

/**
 * The TaskError of a session that did not succeed. `binding`: an interrupted
 * session may have submitted — OUTCOME_UNKNOWN with `unknownReason`, never retried.
 */
export function outcomeError(
  o: BrowserOutcome,
  ctx: {
    siteName: string;
    fallbackHost: string;
    readOnly: boolean;
    unknownReason?: 'ORDER_UNKNOWN' | 'BOOKING_UNCONFIRMED' | 'STEP_INTERRUPTED';
  },
): AgentError {
  const host = o.stopParams.host || hostOf(o.handoverUrl) || ctx.fallbackHost || ctx.siteName;
  if (o.status === 'interrupted' && !ctx.readOnly)
    return new AgentError(
      'OUTCOME_UNKNOWN',
      `JARVIS was interrupted on ${ctx.siteName} after submitting, so it cannot tell whether it went through. Check with the site before retrying.`,
      {
        retryable: false,
        reason: ctx.unknownReason ?? 'STEP_INTERRUPTED',
        params: { step: ctx.siteName },
      },
    );
  const reason: BrowserStopReason = o.stopReason ?? 'BROWSER_CRASHED';
  if (HANDOVER.has(reason))
    return new AgentError(
      'TOOL_FAILED',
      `${host} needs you to continue on the site yourself (${reason}); JARVIS never works around that.`,
      {
        retryable: ctx.readOnly,
        reason: reason as 'CAPTCHA_DETECTED' | 'LOGIN_REQUIRED' | 'BOT_PROTECTION',
        params: { host },
      },
    );
  switch (reason) {
    case 'SITE_UNSUPPORTED':
      return new AgentError('TOOL_FAILED', `JARVIS does not support ${host}.`, {
        reason,
        params: { host },
      });
    case 'NAVIGATION_BLOCKED':
      return new AgentError(
        'FETCH_BLOCKED',
        `The site tried to lead JARVIS to ${host}, which is not allowed.`,
        {
          reason,
          params: { host },
        },
      );
    case 'PAGE_CHANGED':
      return new AgentError(
        'TOOL_FAILED',
        `${host} does not look as JARVIS expects, so it stopped.`,
        {
          reason,
          params: { host },
        },
      );
    case 'SITE_ERROR': {
      const status = o.stopParams.status ?? 0;
      const transient = ctx.readOnly && (status === 0 || status >= 500 || status === 429);
      return new AgentError('TOOL_FAILED', `${host} showed an error (HTTP ${status}).`, {
        retryable: transient,
        transient,
        reason,
        params: { host, status },
      });
    }
    case 'BROWSER_BUDGET_EXCEEDED':
      return new AgentError('TOOL_FAILED', 'The site needed more than the browser agent allows.', {
        reason,
        params: { limit: o.stopParams.limit ?? 0 },
      });
    case 'BROWSER_TIMEOUT':
      return new AgentError('TOOL_TIMEOUT', 'The site took too long, so JARVIS stopped.', {
        retryable: ctx.readOnly,
        transient: ctx.readOnly,
        reason,
        params: { seconds: o.stopParams.seconds ?? 0 },
      });
    case 'CANCELLED':
      return new AgentError('TOOL_FAILED', 'The browser session was cancelled.', {
        retryable: true,
        reason: 'STEP_INTERRUPTED',
        params: { step: ctx.siteName },
      });
    default:
      return new AgentError('TOOL_FAILED', 'The browser stopped unexpectedly.', {
        retryable: ctx.readOnly,
        transient: ctx.readOnly,
        reason: 'BROWSER_CRASHED',
      });
  }
}

/** Evidence entries for the files a session stored (screenshots, extracts, ICS). */
export function artifactEvidence(artifacts: readonly EvidenceArtifactRow[], items = 0): Evidence[] {
  return artifacts.map((a) => {
    const url = a.page_url ?? '';
    if (a.kind === 'screenshot')
      return evidence(
        'browser_capture',
        'Screenshot of the live page',
        `${url} (sha256:${a.sha256})`,
        'SCREENSHOT',
        {
          artifactId: a.id,
          url,
          sha256: a.sha256,
        },
      );
    if (a.kind === 'ics')
      return evidence(
        'browser_capture',
        'Calendar file (ICS) from the site',
        `sha256:${a.sha256}`,
        'ICS_FILE',
        {
          artifactId: a.id,
          sha256: a.sha256,
        },
      );
    return evidence('browser_capture', 'Data read from the page', url, 'PAGE_EXTRACT', {
      artifactId: a.id,
      url,
      items,
    });
  });
}

export const money = (m: Money | null | undefined): string => (m ? moneyParam(m) : '—');

/* ------------------------------------------------------------------ */
/* Result-text vocabulary (en/de/ar). Page text stays as the site wrote it. */
/* ------------------------------------------------------------------ */

const WORDS = {
  price: { en: 'Price', de: 'Preis', ar: 'السعر' },
  shipping: { en: 'Shipping', de: 'Versand', ar: 'الشحن' },
  total: { en: 'Total', de: 'Gesamt', ar: 'الإجمالي' },
  delivery: { en: 'Delivery', de: 'Lieferung', ar: 'التوصيل' },
  days: { en: 'days', de: 'Tage', ar: 'أيام' },
  unknown: { en: 'not stated', de: 'nicht angegeben', ar: 'غير مذكور' },
  source: { en: 'Source', de: 'Quelle', ar: 'المصدر' },
  rating: { en: 'Rating', de: 'Bewertung', ar: 'التقييم' },
  outOfStock: { en: 'out of stock', de: 'nicht vorrätig', ar: 'غير متوفر' },
  best: {
    en: 'Lowest known total',
    de: 'Niedrigster bekannter Gesamtpreis',
    ar: 'أقل إجمالي معروف',
  },
  noOffers: { en: 'No offers found.', de: 'Keine Angebote gefunden.', ar: 'لم يُعثر على عروض.' },
  siteFailed: { en: 'could not be read', de: 'konnte nicht gelesen werden', ar: 'تعذرت قراءته' },
  siteHandover: {
    en: 'needs you on the site',
    de: 'braucht dich auf der Website',
    ar: 'يحتاجك على الموقع',
  },
  mixed: {
    en: 'Prices are in different currencies and were not converted.',
    de: 'Die Preise sind in verschiedenen Währungen und wurden nicht umgerechnet.',
    ar: 'الأسعار بعملات مختلفة ولم تُحوَّل.',
  },
  slotsFree: { en: 'Free appointments', de: 'Freie Termine', ar: 'المواعيد المتاحة' },
  noSlots: {
    en: 'No free appointments right now.',
    de: 'Gerade keine freien Termine.',
    ar: 'لا توجد مواعيد متاحة الآن.',
  },
  needs: {
    en: 'The booking form asks for',
    de: 'Das Buchungsformular fragt nach',
    ar: 'يطلب نموذج الحجز',
  },
  timesIn: { en: 'Times in', de: 'Zeiten in', ar: 'الأوقات بتوقيت' },
  cart: { en: 'Cart', de: 'Warenkorb', ar: 'السلة' },
  finishOnSite: {
    en: 'This shop does not support ordering through JARVIS: finish the purchase on the site',
    de: 'Dieser Shop unterstützt keine Bestellung über JARVIS: schließe den Kauf auf der Website ab',
    ar: 'هذا المتجر لا يدعم الطلب عبر JARVIS: أكمل الشراء على الموقع',
  },
  nothingBought: {
    en: 'Nothing was bought.',
    de: 'Es wurde nichts gekauft.',
    ar: 'لم يُشترَ شيء.',
  },
} satisfies Record<string, Record<Locale, string>>;

export const word = (lang: Locale, k: keyof typeof WORDS): string => WORDS[k][lang] ?? WORDS[k].en;

/** "2–4 days" from a delivery fact; "not stated" when the page did not say. */
export function deliveryText(
  lang: Locale,
  d: { minDays: number | null; maxDays: number | null },
): string {
  if (d.minDays === null && d.maxDays === null) return word(lang, 'unknown');
  const range =
    d.minDays === d.maxDays || d.maxDays === null
      ? `${d.minDays ?? d.maxDays}`
      : `${d.minDays ?? 0}–${d.maxDays}`;
  return `${range} ${word(lang, 'days')}`;
}

/** An instant in a zone, for result text (the request's language). */
export function formatTime(lang: Locale, iso: string, zone: string): string {
  const locale = lang === 'de' ? 'de-DE' : lang === 'ar' ? 'ar' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * The approval that authorised exactly this input (the executor binds approvals
 * to hash({ toolId, resolvedInput })), recorded on orders and bookings.
 */
export async function approvedAction(
  rt: Pick<ToolRuntime, 'db' | 'ctx' | 'stepId'>,
  toolId: ToolId,
  input: unknown,
): Promise<{ approvalId: string | null; actionHash: string }> {
  const actionHash = hashObject({ toolId, resolvedInput: input });
  const row = await withContext(rt.db, rt.ctx, (trx) =>
    trx
      .selectFrom('approvals')
      .select('id')
      .where('step_id', '=', rt.stepId)
      .where('status', '=', 'APPROVED')
      .where('action_hash', '=', actionHash)
      .orderBy('decided_at', 'desc')
      .executeTakeFirst(),
  );
  return { approvalId: row?.id ?? null, actionHash };
}
