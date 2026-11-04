/**
 * booking.book — book one slot on a supported booking site, exactly once
 * (docs/architecture/phase-c.md §3.4, scenario 1; docs/adr/0018).
 *
 * The slot comes only by reference from booking.find_slots (`{{sN.firstSlot}}`:
 * live from the site, with its screenshot) and is checked again against that
 * session's recorded result before anything happens; the details are the
 * user's words (or the account's name and email), never references. MEDIUM —
 * HIGH and BINDING_COMMITMENT when the site says it is binding, and a price
 * makes it a purchase (the monthly purchase limit applies). The approval
 * ('booking') shows the slot, every field sent, the price and the terms.
 *
 * Exactly once: the bookings row (key booking:<step id>, also the site's
 * Idempotency-Key) is inserted before submitting. The browser worker records
 * the outcome from the site's live answer: confirmed (reference read from the
 * confirmation's schema.org Reservation, ICS kept as evidence), SLOT_TAKEN
 * (taken meanwhile — nothing booked; the other free times the site showed are
 * offered again), or unknown (submitted without confirmation →
 * OUTCOME_UNKNOWN BOOKING_UNCONFIRMED). An acknowledged retry first looks the
 * key up on the site and never books twice.
 */
import type { Booking, BookingConfirmation, Locale } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../../db/pool';
import type { BookingRow } from '../../../../db/types';
import { runBrowserSession, sessionsOfTask } from '../../../browser/client';
import { getRecipe } from '../../../browser/sites';
import type {
  BookingBookOutput,
  BookingLookupOutput,
  BookingSlotsOutput,
} from '../../../browser/sites/fixture-booking';
import {
  bookingKey,
  finalizeBooking,
  reserveBooking,
  restartBooking,
  type BookingFacts,
} from '../../../commerce/bookings';
import { AgentError } from '../../errors';
import { msg, render } from '../../i18n';
import { hasTemplate } from '../../templates';
import { check, evidence, type ToolDefinition } from '../types';
import { BookingOffer } from './booking-find-slots';
import {
  approvedAction,
  artifactEvidence,
  enabledRecipe,
  formatTime,
  isRef,
  outcomeError,
  plannedRecipe,
  refOr,
  SiteId,
} from './common';

export const BookingBookInput = z.object({
  siteId: SiteId,
  slot: refOr(
    BookingOffer,
    'The slot to book: a reference to booking.find_slots output firstSlot, e.g. {{s1.firstSlot}}. Never written out.',
  ),
  details: z
    .record(z.string().min(1).max(100), z.string().trim().min(1).max(500))
    .describe(
      'What the booking form receives, keyed by the site’s field labels (e.g. "Full name", "Email", "Phone"): the account’s name and email, everything else only from the user’s own words.',
    ),
});
export type BookingBookInput = z.infer<typeof BookingBookInput>;

/** Field entries in the order the site's form lists them (unknown labels last, by name). */
export function orderedFields(
  values: Record<string, string>,
  form: readonly { label: string }[],
): [string, string][] {
  const rank = (label: string) => {
    const i = form.findIndex((f) => f.label.toLowerCase() === label.trim().toLowerCase());
    return i < 0 ? form.length : i;
  };
  return Object.entries(values).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

const offerOf = (input: BookingBookInput): BookingOffer | null =>
  typeof input.slot === 'object' && input.slot !== null ? (input.slot as BookingOffer) : null;

function slotTakenError(
  lang: Locale,
  site: string,
  alternatives: BookingSlotsOutput['slots'],
): AgentError {
  const offered = alternatives.slice(0, 3).map((s) => formatTime(lang, s.start, s.timeZone));
  return new AgentError(
    'TOOL_FAILED',
    `That appointment on ${site} was taken in the meantime, so nothing was booked.${offered.length ? ` Free now: ${offered.join('; ')}.` : ''}`,
    { retryable: false, reason: 'SLOT_TAKEN', params: { alternatives: alternatives.length } },
  );
}

function output(
  row: BookingRow,
  offer: BookingOffer,
  extra: {
    location: string | null;
    icsArtifactId: string | null;
    screenshotArtifactId: string | null;
    sessionId: string | null;
    reconciled: boolean;
  },
) {
  const confirmation: BookingConfirmation = {
    bookingId: row.id,
    reference: row.reference ?? '',
    service: row.service,
    start: new Date(row.slot_start).toISOString(),
    end: row.slot_end ? new Date(row.slot_end).toISOString() : null,
    timeZone: row.time_zone,
    location: extra.location,
    siteId: row.site_id,
    siteHost: row.site_host,
    icsArtifactId: extra.icsArtifactId,
    screenshotArtifactId: extra.screenshotArtifactId,
    confirmedAt: new Date(row.updated_at).toISOString(),
  };
  return {
    bookingId: row.id,
    reference: row.reference,
    title: `${row.service} — ${offer.siteName}`,
    siteName: offer.siteName,
    start: confirmation.start,
    end: confirmation.end,
    timeZone: row.time_zone,
    location: extra.location ?? offer.siteName,
    siteId: row.site_id,
    status: row.status satisfies Booking['status'],
    confirmation,
    icsArtifactId: extra.icsArtifactId,
    evidenceArtifactId: extra.screenshotArtifactId,
    sessionId: extra.sessionId,
    reconciled: extra.reconciled,
  };
}

export const bookingBookTool: ToolDefinition<BookingBookInput> = {
  id: 'booking.book',
  version: '1.0.0',
  description:
    'Book one slot on a SUPPORTED booking site, exactly once, after the user approves the slot and every detail sent. slot must reference booking.find_slots output firstSlot ({{s1.firstSlot}}); details are keyed by the site’s field labels: name and email of the account, anything else (e.g. phone) only if the user wrote it — otherwise ask with assistant.clarify (contact_details).',
  inputSchema: BookingBookInput,
  allowedRefTools: ['booking.find_slots'],
  validatePlanned(input) {
    const { recipe, issues } = plannedRecipe(input.siteId, 'book');
    const out = issues.map((i) => `booking.book: ${i}`);
    if (!isRef(input.slot))
      out.push(
        'booking.book slot must be a reference to booking.find_slots firstSlot ({{sN.firstSlot}}), never written out',
      );
    for (const [k, v] of Object.entries(input.details ?? {}))
      if (hasTemplate(k) || hasTemplate(v))
        out.push('booking.book details must be the user’s own words, never references');
    if (recipe?.booking) {
      const labels = new Set(recipe.booking.fields.map((f) => f.label.toLowerCase()));
      for (const k of Object.keys(input.details ?? {}))
        if (!labels.has(k.trim().toLowerCase()))
          out.push(`booking.book: ${recipe.name}'s form has no field "${k}"`);
    }
    return out;
  },
  outputFields: [
    'bookingId',
    'reference',
    'title',
    'start',
    'end',
    'timeZone',
    'location',
    'confirmation',
    'icsArtifactId',
  ],
  requiredConnection: 'web',
  permissions: ['web:read', 'web:submit'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 200_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  outbound: true,
  runsInBrowser: true,
  riskLevel: (input) => {
    const o = offerOf(input);
    return o && (o.binding || o.slot.price) ? 'HIGH' : 'MEDIUM';
  },
  binding: (input) => offerOf(input)?.binding === true,
  purchase: (input) => {
    const price = offerOf(input)?.slot.price;
    return price ? { amountMicro: price.amountMicro, currency: price.currency } : null;
  },
  estimateCostMicro: () => 0,
  preview: (input) => {
    const o = offerOf(input);
    return {
      siteId: input.siteId,
      slot: o
        ? { id: o.slot.id, start: o.slot.start, timeZone: o.slot.timeZone, service: o.service }
        : input.slot,
      fields: Object.keys(input.details),
    };
  },
  approvalDetails(input, ctx) {
    const o = offerOf(input);
    const recipe = getRecipe(input.siteId);
    const site = o?.siteName ?? recipe?.name ?? input.siteId;
    const service = o?.service ?? '';
    const summaryMessage = msg('approval.booking', { service, site });
    const personal = (label: string) =>
      recipe?.booking?.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())
        ?.personal ?? true;
    return {
      details: {
        kind: 'booking',
        siteId: input.siteId,
        siteName: site,
        siteHost: o?.siteHost ?? ctx.siteHost?.(input.siteId) ?? recipe?.hostLabel ?? input.siteId,
        service,
        start: o?.slot.start ?? new Date(0).toISOString(),
        end: o?.slot.end ?? null,
        timeZone: o?.slot.timeZone ?? recipe?.booking?.timeZone ?? 'UTC',
        // In the form's own order (stored JSON does not keep key order).
        fields: orderedFields(input.details, recipe?.booking?.fields ?? []).map(
          ([label, value]) => ({
            label,
            value,
            personal: personal(label),
          }),
        ),
        price: o?.slot.price ?? null,
        binding: o?.binding === true,
        cancellationTerms: o?.cancellationTerms ?? null,
        evidenceArtifactId: o?.evidenceArtifactId ?? null,
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  resultLine: (_input, output) =>
    output.reference
      ? msg('result.booked', {
          service: String((output.confirmation as BookingConfirmation | undefined)?.service ?? ''),
          site: String(output.siteName ?? ''),
          reference: String(output.reference),
        })
      : null,
  resultFact: (_input, output) =>
    `Booked ${String(output.title ?? '')} (reference ${String(output.reference ?? '')})`,
  async execute(input, rt, signal) {
    const offer = offerOf(input);
    if (!offer)
      throw new AgentError('TOOL_FAILED', 'The slot to book is missing.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'booking.book' },
      });
    const { recipe, origins } = enabledRecipe(rt.config, input.siteId);
    const host = new URL(origins[0]!).host;
    // The slot must be exactly one this task read live from the site (never invented).
    const [read] = await sessionsOfTask(rt, [offer.sessionId]);
    const listed =
      read?.status === 'succeeded' && read.site_id === recipe.id && read.operation === 'slots'
        ? ((read.result as BookingSlotsOutput | null)?.slots ?? []).find(
            (s) => s.id === offer.slot.id && s.start === offer.slot.start,
          )
        : undefined;
    if (!listed || offer.siteId !== recipe.id)
      throw new AgentError('TOOL_FAILED', 'That slot is not one the site offered in this task.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'booking.book' },
      });
    const given = new Set(Object.keys(input.details).map((k) => k.trim().toLowerCase()));
    const missing = offer.requiredFields.filter((f) => !given.has(f.toLowerCase()));
    if (missing.length)
      throw new AgentError('TOOL_FAILED', `The booking form needs: ${missing.join(', ')}.`, {
        reason: 'BOOKING_DETAILS_MISSING',
        params: { fields: missing.join(', ') },
      });

    const key = bookingKey(rt.stepId);
    const { approvalId, actionHash } = await approvedAction(rt, 'booking.book', input);
    const facts: BookingFacts = {
      taskId: rt.taskId,
      stepId: rt.stepId,
      siteId: recipe.id,
      siteName: offer.siteName,
      siteHost: offer.siteHost || host,
      service: offer.service,
      slotStart: offer.slot.start,
      slotEnd: offer.slot.end,
      timeZone: offer.slot.timeZone,
      priceMicro: offer.slot.price?.amountMicro ?? null,
      priceCurrency: offer.slot.price?.currency ?? null,
      binding: offer.binding,
      approvalId,
      actionHash,
      slotsArtifactId: offer.evidenceArtifactId,
    };
    const reserved = await withContext(rt.db, rt.ctx, (trx) =>
      reserveBooking(trx, rt.ctx, key, facts),
    );
    let row = reserved.row;

    if (reserved.existing && row.status === 'confirmed') {
      // Already booked by an earlier attempt of this step: never again.
      return {
        output: output(row, offer, {
          location: null,
          icsArtifactId: row.ics_artifact_id,
          screenshotArtifactId: row.confirmation_artifact_id,
          sessionId: null,
          reconciled: true,
        }),
        outputPreview: {
          bookingId: row.id,
          reference: row.reference,
          start: new Date(row.slot_start).toISOString(),
          reconciled: true,
        },
        evidence: [
          evidence('record', 'Booking', `${row.reference}`, 'BOOKING_CONFIRMATION', {
            bookingId: row.id,
            reference: row.reference ?? '',
          }),
        ],
        costMicro: 0,
      };
    }
    if (reserved.existing && (row.status === 'submitting' || row.status === 'unknown')) {
      // An earlier attempt may have submitted: ask the site by the same key first.
      const look = await runBrowserSession(
        rt,
        { siteId: recipe.id, operation: 'booking_lookup', input: { idempotencyKey: key } },
        signal,
      );
      if (look.status !== 'succeeded' || !look.result)
        throw outcomeError(look, { siteName: recipe.name, fallbackHost: host, readOnly: true });
      const found = look.result as BookingLookupOutput;
      if (found.found) {
        const done = await withContext(rt.db, rt.ctx, (trx) =>
          finalizeBooking(trx, rt.ctx, key, {
            kind: 'confirmed',
            reference: found.reference,
            slotStart: found.start,
            slotEnd: found.end,
            confirmationArtifactId: found.screenshotArtifactId,
            icsArtifactId: null,
          }),
        );
        row = done ?? row;
        return {
          output: output(row, offer, {
            location: found.location,
            icsArtifactId: null,
            screenshotArtifactId: found.screenshotArtifactId,
            sessionId: look.sessionId,
            reconciled: true,
          }),
          outputPreview: {
            bookingId: row.id,
            reference: row.reference,
            start: found.start,
            reconciled: true,
          },
          evidence: [
            ...artifactEvidence(look.artifacts),
            evidence('record', 'Booking', found.reference, 'BOOKING_CONFIRMATION', {
              bookingId: row.id,
              reference: found.reference,
            }),
          ],
          costMicro: 0,
        };
      }
    }
    // Nothing at the site for this key (or a definite failure before): submit again — the site
    // dedupes the key as well, so even a race cannot book twice.
    if (reserved.existing && row.status !== 'submitting')
      row = await withContext(rt.db, rt.ctx, (trx) => restartBooking(trx, rt.ctx, row, facts));

    const o = await runBrowserSession(
      rt,
      {
        siteId: recipe.id,
        operation: 'book',
        input: {
          slotId: offer.slot.id,
          expectedStart: offer.slot.start,
          service: offer.serviceId,
          details: input.details,
          idempotencyKey: key,
        },
      },
      signal,
    );
    if (o.status !== 'succeeded' || !o.result)
      throw outcomeError(o, {
        siteName: recipe.name,
        fallbackHost: host,
        readOnly: false,
        unknownReason: 'BOOKING_UNCONFIRMED',
      });
    const r = o.result as BookingBookOutput;
    if (r.outcome === 'slot_taken') throw slotTakenError(rt.language, recipe.name, r.slots);
    if (r.outcome === 'details_missing')
      throw new AgentError('TOOL_FAILED', `The booking form needs: ${r.fields.join(', ')}.`, {
        reason: 'BOOKING_DETAILS_MISSING',
        params: { fields: r.fields.join(', ') },
      });
    if (r.outcome === 'unconfirmed')
      throw new AgentError(
        'OUTCOME_UNKNOWN',
        `The booking was sent to ${recipe.name}, but the site showed no confirmation. Check with the site before trying again.`,
        { retryable: false, reason: 'BOOKING_UNCONFIRMED', params: { step: recipe.name } },
      );
    const final = await withContext(rt.db, rt.ctx, (trx) =>
      trx.selectFrom('bookings').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow(),
    );
    if (final.status !== 'confirmed' || !final.reference)
      throw new AgentError('OUTCOME_UNKNOWN', 'The booking’s confirmation could not be recorded.', {
        reason: 'BOOKING_UNCONFIRMED',
        params: { step: recipe.name },
      });
    return {
      output: output(final, offer, {
        location: r.location,
        icsArtifactId: r.icsArtifactId,
        screenshotArtifactId: r.screenshotArtifactId,
        sessionId: o.sessionId,
        reconciled: false,
      }),
      outputPreview: {
        bookingId: final.id,
        reference: final.reference,
        title: `${final.service} — ${offer.siteName}`,
        start: r.start,
        end: r.end,
        timeZone: r.timeZone,
        location: r.location,
      },
      evidence: [
        ...artifactEvidence(o.artifacts),
        evidence(
          'record',
          'Booking confirmed by the site',
          final.reference,
          'BOOKING_CONFIRMATION',
          { bookingId: final.id, reference: final.reference },
        ),
      ],
      costMicro: 0,
    };
  },
  verify(input, output) {
    const reference = typeof output.reference === 'string' ? output.reference : '';
    const o = offerOf(input);
    const sameSlot = !o || output.start === o.slot.start;
    const checks = [
      check('confirmationReceived', `The site confirmed the booking (reference ${reference})`, {
        reference,
      }),
    ];
    if (typeof output.evidenceArtifactId === 'string')
      checks.push(
        check('screenshotStored', 'Screenshot of the confirmation stored', {
          artifactId: output.evidenceArtifactId,
        }),
      );
    return { ok: reference.length > 0 && sameSlot, checks };
  },
};
