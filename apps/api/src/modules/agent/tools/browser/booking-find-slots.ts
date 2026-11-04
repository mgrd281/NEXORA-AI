/**
 * booking.find_slots — the free appointments a supported booking site shows
 * right now (docs/architecture/phase-c.md §3.4, scenario 1). LOW, read-only,
 * through the isolated browser agent, with a screenshot of the live
 * availability as evidence. Availability is never estimated: no slot → the
 * result says so; with an explicit window (from / to / at) and nothing free →
 * NO_FREE_SLOTS, so a dependent booking step does not run.
 *
 * `firstSlot` (the earliest matching slot, with the site's price, terms and
 * required fields) is what booking.book references: the approval then shows
 * exactly the slot the site offered.
 */
import { BookingSlot, BookingSlots, Money, type Locale } from '@jarvis/contracts';
import { z } from 'zod';
import { runBrowserSession } from '../../../browser/client';
import { getRecipe } from '../../../browser/sites';
import type { BookingSlotsOutput } from '../../../browser/sites/fixture-booking';
import type { Recipe } from '../../../browser/types';
import { AgentError } from '../../errors';
import { detectInjection } from '../injection';
import { check, genericApprovalSummary, type ToolDefinition } from '../types';
import {
  artifactEvidence,
  enabledRecipe,
  formatTime,
  hostOf,
  money,
  outcomeError,
  plannedRecipe,
  SiteId,
  word,
} from './common';

/** What booking.book receives by reference: one slot exactly as the site offered it. */
export const BookingOffer = z.object({
  /** The find_slots browser session the slot was read in (checked again before booking). */
  sessionId: z.string().uuid(),
  siteId: z.string(),
  siteName: z.string(),
  siteHost: z.string(),
  serviceId: z.string(),
  service: z.string(),
  slot: BookingSlot,
  binding: z.boolean(),
  cancellationTerms: z.string().nullable(),
  requiredFields: z.array(z.string()),
  evidenceArtifactId: z.string().nullable(),
});
export type BookingOffer = z.infer<typeof BookingOffer>;

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const BookingFindSlotsInput = z.object({
  siteId: SiteId,
  service: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('The service as the user named it (e.g. "check-up"); must be one the site offers.'),
  from: LocalDate.optional().describe(
    'First local date (the site’s time zone), when the user named one.',
  ),
  to: LocalDate.optional().describe('Last local date, when the user named a window.'),
  at: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .describe('Only slots starting at this local time (HH:MM), when the user named a time.'),
});
export type BookingFindSlotsInput = z.infer<typeof BookingFindSlotsInput>;

/** The recipe's service id for a name the user wrote (id, name or alias), or null. */
export function serviceIdOf(recipe: Recipe | undefined, name: string): string | null {
  const n = name.trim().toLowerCase();
  for (const s of recipe?.booking?.services ?? [])
    if (s.id === n || s.name.toLowerCase() === n || s.aliases.includes(n)) return s.id;
  return null;
}

function slotsText(lang: Locale, out: BookingSlotsOutput, siteName: string): string {
  const head = `${word(lang, 'slotsFree')} — ${siteName}: ${out.service} (${word(lang, 'timesIn')} ${out.timeZone})`;
  if (out.slots.length === 0) return `${head}\n${word(lang, 'noSlots')}`;
  const lines = out.slots.slice(0, 10).map((s) => `• ${formatTime(lang, s.start, s.timeZone)}`);
  const extra = [
    out.price ? `${word(lang, 'price')}: ${money(out.price)}` : null,
    out.cancellationTerms,
    out.requiredFields.length ? `${word(lang, 'needs')}: ${out.requiredFields.join(', ')}` : null,
  ].filter(Boolean);
  return [head, ...lines, ...extra].join('\n');
}

export const bookingFindSlotsTool: ToolDefinition<BookingFindSlotsInput> = {
  id: 'booking.find_slots',
  version: '1.0.0',
  description:
    'Read the free appointment slots a SUPPORTED booking site (e.g. siteId "fixture-booking" = Fixture Dental) shows right now for a service, optionally in a date window (from/to, YYYY-MM-DD) or at a local start time (at, HH:MM). Live from the site, with a screenshot. Output firstSlot is what booking.book references.',
  inputSchema: BookingFindSlotsInput,
  validatePlanned(input) {
    const { recipe, issues } = plannedRecipe(input.siteId, 'slots');
    const out = issues.map((i) => `booking.find_slots: ${i}`);
    if (recipe && typeof input.service === 'string' && !serviceIdOf(recipe, input.service))
      out.push(
        `booking.find_slots: ${recipe.name} offers ${(recipe.booking?.services ?? []).map((s) => `"${s.name}"`).join(', ')}, not "${input.service}"`,
      );
    if (input.from && input.to && input.to < input.from)
      out.push('booking.find_slots: "to" must not be before "from"');
    return out;
  },
  outputFields: [
    'result',
    'text',
    'slotCount',
    'firstSlot',
    'firstSlotId',
    'firstSlotStart',
    'sessionId',
  ],
  requiredConnection: 'web',
  permissions: ['web:read'],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 150_000,
  retry: { maxAttempts: 2, retryableCodes: ['TOOL_TIMEOUT', 'TOOL_FAILED'] },
  modelUse: 'none',
  outbound: true,
  runsInBrowser: true,
  resultTextField: 'text',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({
    siteId: input.siteId,
    service: input.service,
    from: input.from,
    to: input.to,
    at: input.at,
  }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'booking.find_slots',
      fields: [
        { label: 'Site', value: getRecipe(input.siteId)?.name ?? input.siteId },
        { label: 'Service', value: input.service },
      ],
    },
    ...genericApprovalSummary(ctx, 'booking.find_slots'),
  }),
  resultFact: (_input, output) => `Free slots read live: ${String(output.slotCount ?? 0)}`,
  untrustedHost: (output) =>
    (output.firstSlot as BookingOffer | null | undefined)?.siteHost ?? null,
  async execute(input, rt, signal) {
    const { recipe, origins } = enabledRecipe(rt.config, input.siteId);
    const serviceId = serviceIdOf(recipe, input.service);
    if (!serviceId)
      throw new AgentError('TOOL_FAILED', `${recipe.name} does not offer “${input.service}”.`, {
        reason: 'INVALID_STEP_INPUT',
        params: { step: input.service },
      });
    const o = await runBrowserSession(
      rt,
      {
        siteId: recipe.id,
        operation: 'slots',
        input: {
          service: serviceId,
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          ...(input.at ? { at: input.at } : {}),
        },
      },
      signal,
    );
    const host = hostOf(origins[0]);
    if (o.status !== 'succeeded' || !o.result)
      throw outcomeError(o, { siteName: recipe.name, fallbackHost: host, readOnly: true });
    const r = o.result as BookingSlotsOutput;
    const windowAsked = !!(input.from || input.to || input.at);
    if (r.slots.length === 0 && windowAsked)
      throw new AgentError(
        'TOOL_FAILED',
        `${recipe.name} has no free ${r.service} appointment in that window.`,
        {
          retryable: true,
          reason: 'NO_FREE_SLOTS',
        },
      );
    const result: BookingSlots = {
      siteId: recipe.id,
      siteName: recipe.name,
      service: r.service,
      slots: r.slots,
      requiredFields: r.requiredFields,
      evidenceArtifactId: r.evidenceArtifactId,
      capturedAt: r.capturedAt,
    };
    const first = r.slots[0];
    const firstSlot: BookingOffer | null = first
      ? {
          sessionId: o.sessionId,
          siteId: recipe.id,
          siteName: recipe.name,
          siteHost: hostOf(r.slotsUrl) || host,
          serviceId,
          service: r.service,
          slot: first,
          binding: r.binding,
          cancellationTerms: r.cancellationTerms,
          requiredFields: r.requiredFields,
          evidenceArtifactId: r.evidenceArtifactId,
        }
      : null;
    const text = slotsText(rt.language, r, recipe.name);
    // The site's own wording (service, terms) is untrusted text: flagged content taints the booking.
    const scan = detectInjection(
      [r.service, r.cancellationTerms ?? '', ...r.requiredFields].join('\n'),
    );
    return {
      output: {
        result,
        text,
        suspectedInjection: scan.suspectedInjection,
        injectionSignals: scan.injectionSignals,
        slotCount: r.slots.length,
        firstSlot,
        firstSlotId: first?.id ?? null,
        firstSlotStart: first?.start ?? null,
        price: r.price satisfies Money | null,
        binding: r.binding,
        sessionId: o.sessionId,
        evidenceArtifactId: r.evidenceArtifactId,
      },
      outputPreview: {
        result,
        siteId: recipe.id,
        service: r.service,
        slotCount: r.slots.length,
        slots: r.slots.slice(0, 5).map((s) => ({ start: s.start, timeZone: s.timeZone })),
        requiredFields: r.requiredFields,
        evidenceArtifactId: r.evidenceArtifactId,
      },
      evidence: artifactEvidence(o.artifacts, r.slots.length),
      costMicro: 0,
    };
  },
  verify(_input, output) {
    const count = Number(output.slotCount ?? 0);
    const artifact = typeof output.evidenceArtifactId === 'string' ? output.evidenceArtifactId : '';
    return {
      ok: artifact.length > 0,
      checks: [
        check('slotsFound', `${count} free slot(s) read live from the site`, { count }),
        check('screenshotStored', 'Screenshot of the live availability stored', {
          artifactId: artifact,
        }),
      ],
    };
  },
};
