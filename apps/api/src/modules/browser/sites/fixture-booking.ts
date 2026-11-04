/**
 * Recipe for "Fixture Dental", the fictional appointment site of the local
 * fixture site (scripts/fixture-site.mjs /booking). Development/test only
 * (BROWSER_FIXTURE_ORIGIN; refused in production).
 *
 * Operations:
 *   read            the generic schema.org reader (common.ts)
 *   slots           the free slots the site shows right now (optionally a date window and a
 *                   local start time), its price, cancellation terms and the details its form
 *                   requires — with a screenshot
 *   book            re-reads the chosen slot (taken → 'slot_taken' with the other free times
 *                   the site shows), fills exactly the given details, submits once with the
 *                   booking's idempotency key and reads the confirmation (schema.org
 *                   Reservation + ICS) — binding (commit: booking)
 *   booking_lookup  the reservation made with an idempotency key (reconciliation)
 *   fill            the contact form (browser.fill)
 * Availability and confirmations are read from the site's live pages only.
 */
import { BROWSER_LIMITS, BookingSlot, Money } from '@jarvis/contracts';
import { z } from 'zod';
import type { DomElement } from '../dom';
import { cleanText, jsonLdNodes, parseIcs, reservation } from '../structured';
import {
  stopSession,
  type FormField,
  type Recipe,
  type RecipeContext,
  type RecipeOperation,
} from '../types';
import { attrs, fixtureOrigin, moneyOf, readOperation } from './common';

export const BOOKING_TIME_ZONE = 'Europe/Berlin';
const MAX_SLOTS = 20;

export const BOOKING_SERVICES = [
  {
    id: 'checkup',
    name: 'Check-up',
    aliases: [
      'check-up',
      'checkup',
      'check up',
      'kontrolle',
      'kontrolltermin',
      'untersuchung',
      'vorsorge',
      'فحص',
    ],
  },
  {
    id: 'cleaning',
    name: 'Dental cleaning',
    aliases: [
      'dental cleaning',
      'cleaning',
      'teeth cleaning',
      'zahnreinigung',
      'reinigung',
      'تنظيف',
    ],
  },
] as const;

export const BOOKING_FIELDS: readonly FormField[] = [
  { label: 'Full name', kind: 'name', required: true, personal: true },
  { label: 'Email', kind: 'email', required: true, personal: true },
  { label: 'Phone', kind: 'phone', required: true, personal: true },
];

const CONTACT_FIELDS: readonly FormField[] = [
  { label: 'Name', kind: 'name', required: true, personal: true },
  { label: 'Email', kind: 'email', required: true, personal: true },
  { label: 'Message', kind: 'text', required: true, personal: false },
];

const ServiceId = z.enum(['checkup', 'cleaning']);
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SlotsInput = z.object({
  service: ServiceId,
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  /** Only slots starting at this local time (HH:MM, the site's time zone). */
  at: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
});
const SlotsOutput = z.object({
  siteName: z.string(),
  serviceId: ServiceId,
  service: z.string(),
  timeZone: z.string(),
  slots: z.array(BookingSlot).max(MAX_SLOTS),
  requiredFields: z.array(z.string()),
  price: Money.nullable(),
  binding: z.boolean(),
  cancellationTerms: z.string().nullable(),
  slotsUrl: z.string(),
  evidenceArtifactId: z.string(),
  capturedAt: z.string(),
});
export type BookingSlotsOutput = z.infer<typeof SlotsOutput>;

const BookInput = z.object({
  slotId: z.string().regex(/^[a-z]+-\d{8}-\d{4}$/),
  expectedStart: z.string(),
  service: ServiceId,
  /** Exactly what the form receives, keyed by the site's labels. */
  details: z.record(z.string().min(1).max(100), z.string().max(500)),
  idempotencyKey: z.string().min(16).max(200),
});
const BookOutput = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('confirmed'),
    reference: z.string(),
    service: z.string(),
    start: z.string(),
    end: z.string().nullable(),
    timeZone: z.string(),
    location: z.string().nullable(),
    icsArtifactId: z.string().nullable(),
    screenshotArtifactId: z.string(),
    confirmationUrl: z.string(),
  }),
  z.object({
    outcome: z.literal('slot_taken'),
    /** The other free times the site offered instead (re-offer; live). */
    slots: z.array(BookingSlot).max(MAX_SLOTS),
    screenshotArtifactId: z.string(),
  }),
  z.object({ outcome: z.literal('details_missing'), fields: z.array(z.string()) }),
  z.object({ outcome: z.literal('unconfirmed'), screenshotArtifactId: z.string().nullable() }),
]);
export type BookingBookOutput = z.infer<typeof BookOutput>;

const LookupInput = z.object({ idempotencyKey: z.string().min(16).max(200) });
const LookupOutput = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    reference: z.string(),
    start: z.string(),
    end: z.string().nullable(),
    location: z.string().nullable(),
    screenshotArtifactId: z.string(),
  }),
  z.object({ found: z.literal(false), screenshotArtifactId: z.string() }),
]);
export type BookingLookupOutput = z.infer<typeof LookupOutput>;

const FillInput = z.object({
  form: z.literal('contact'),
  fields: z.record(z.string().min(1).max(100), z.string().max(2000)),
  idempotencyKey: z.string().min(16).max(200),
});
const FillOutput = z.object({
  submitted: z.literal(true),
  reference: z.string().nullable(),
  screenshotArtifactId: z.string(),
});
export type BookingFillOutput = z.infer<typeof FillOutput>;

const serviceName = (id: string) => BOOKING_SERVICES.find((s) => s.id === id)?.name ?? id;

const originOf = (ctx: RecipeContext): string => {
  if (!ctx.origin) stopSession('SITE_UNSUPPORTED');
  return ctx.origin;
};

/** The slots listed on the current page ([data-testid=slot]), as the site states them. */
async function listedSlots(ctx: RecipeContext, service: string): Promise<BookingSlot[]> {
  const rows = await attrs(ctx, '[data-testid=slot]');
  const out: BookingSlot[] = [];
  for (const r of rows.slice(0, MAX_SLOTS)) {
    const start = Date.parse(r.start ?? '');
    const end = Date.parse(r.end ?? '');
    if (!r['slot-id'] || Number.isNaN(start)) continue;
    out.push({
      id: r['slot-id'],
      start: new Date(start).toISOString(),
      end: Number.isNaN(end) ? null : new Date(end).toISOString(),
      timeZone: r['time-zone'] || BOOKING_TIME_ZONE,
      service: serviceName(service),
      price: null,
    });
  }
  return out;
}

/** Local HH:MM of an instant in a zone. */
function localTime(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

const slots: RecipeOperation<z.infer<typeof SlotsInput>, BookingSlotsOutput> = {
  description: 'Read the free appointment slots Fixture Dental shows right now.',
  input: SlotsInput,
  output: SlotsOutput,
  sideEffect: 'none',
  risk: 'LOW',
  idempotency: 'safe_to_retry',
  async run(ctx, input) {
    const origin = originOf(ctx);
    const q = new URLSearchParams({ service: input.service });
    if (input.from) q.set('from', input.from);
    if (input.to) q.set('to', input.to);
    const slotsUrl = `${origin}/booking/slots?${q}`;
    await ctx.goto(slotsUrl);
    await ctx.require('[data-testid=slots]');
    await ctx.require('[data-testid=required-fields]');
    const [priceAttr] = await attrs(ctx, '[data-testid=price]');
    const price = priceAttr ? moneyOf(priceAttr.amount, priceAttr.currency) : null;
    const [terms] = await attrs(ctx, '[data-testid=terms]');
    const requiredFields = (
      await ctx.page.$$eval('[data-testid=required-fields] li', (els) =>
        (els as unknown as DomElement[]).map((e) => (e.textContent ?? '').trim()),
      )
    )
      .map((f) => cleanText(f, 100))
      .filter((f): f is string => !!f);
    let found = (await listedSlots(ctx, input.service)).map((s) => ({ ...s, price }));
    if (input.at) found = found.filter((s) => localTime(s.start, s.timeZone) === input.at);
    const shot = await ctx.screenshot();
    const out: BookingSlotsOutput = {
      siteName: 'Fixture Dental',
      serviceId: input.service,
      service: serviceName(input.service),
      timeZone: BOOKING_TIME_ZONE,
      slots: found,
      requiredFields,
      price,
      binding: terms?.binding === 'true',
      cancellationTerms: cleanText(terms?.__text ?? null, 500),
      slotsUrl,
      evidenceArtifactId: shot.artifactId,
      capturedAt: new Date().toISOString(),
    };
    await ctx.saveExtract(out, found.length);
    return out;
  },
  verify: (input, out) =>
    out.serviceId === input.service &&
    (!input.at || out.slots.every((s) => localTime(s.start, s.timeZone) === input.at)),
};

const book: RecipeOperation<z.infer<typeof BookInput>, BookingBookOutput> = {
  description: 'Book one slot on Fixture Dental with exactly the given details, once.',
  input: BookInput,
  output: BookOutput,
  sideEffect: 'binding',
  risk: 'MEDIUM',
  idempotency: 'once_per_step',
  commit: 'booking',
  async run(ctx, input) {
    const origin = originOf(ctx);
    const form = await ctx.goto(`${origin}/booking/book?slot=${encodeURIComponent(input.slotId)}`, {
      acceptStatus: [409],
    });
    if (form.status === 409 || (await ctx.page.locator('[data-testid=slot-taken]').count()) > 0) {
      const shot = await ctx.screenshot();
      return {
        outcome: 'slot_taken',
        slots: await listedSlots(ctx, input.service),
        screenshotArtifactId: shot.artifactId,
      };
    }
    await ctx.require('[data-testid=booking-form]');
    // The slot the form offers must be the one approved (same id, same start).
    const [chosen] = await attrs(ctx, '[data-testid=slot-chosen]');
    if (
      !chosen ||
      chosen['slot-id'] !== input.slotId ||
      Date.parse(chosen.start ?? '') !== Date.parse(input.expectedStart)
    ) {
      const shot = await ctx.screenshot();
      return {
        outcome: 'slot_taken',
        slots: await listedSlots(ctx, input.service),
        screenshotArtifactId: shot.artifactId,
      };
    }
    // Fill exactly the given details, matched to the form's own labels; never invent one.
    const inputs = await ctx.page.$$eval('[data-testid=booking-form] [data-label]', (els) =>
      (els as unknown as DomElement[]).map((e) => ({
        label: e.getAttribute('data-label') ?? '',
        name: e.getAttribute('name') ?? '',
        required: e.required === true,
      })),
    );
    const given = new Map(
      Object.entries(input.details).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
    );
    const missing = inputs
      .filter((i) => i.required && !given.get(i.label.toLowerCase()))
      .map((i) => i.label);
    if (missing.length) return { outcome: 'details_missing', fields: missing };
    for (const i of inputs) {
      const v = given.get(i.label.toLowerCase());
      if (v !== undefined && /^[a-z_]{1,32}$/.test(i.name))
        await ctx.page.fill(`[data-testid=booking-form] [name=${i.name}]`, v);
    }
    await ctx.setExtraHeaders({ 'Idempotency-Key': input.idempotencyKey });
    ctx.markSubmitting();
    const nav = await ctx.navigateBy(() => ctx.page.click('[data-testid=book-submit]'), {
      acceptStatus: [409, 422],
    });
    if (nav.status === 409) {
      // The site refused it: taken in the very last moment — nothing was booked.
      const shot = await ctx.screenshot();
      return {
        outcome: 'slot_taken',
        slots: await listedSlots(ctx, input.service),
        screenshotArtifactId: shot.artifactId,
      };
    }
    if (nav.status === 422) {
      const errors = cleanText(
        await ctx.page.textContent('[data-testid=form-errors]').catch(() => null),
        300,
      );
      return {
        outcome: 'details_missing',
        fields: errors ? [errors.replace(/^Missing:\s*/i, '')] : [],
      };
    }
    const nodes = jsonLdNodes(await ctx.jsonLd()).filter((n) =>
      /Reservation$/.test(String(n['@type'] ?? '')),
    );
    const r = nodes[0] ? reservation(nodes[0]) : null;
    if (!r?.reference || !r.confirmed || !r.start) {
      const shot = await ctx.screenshot().catch(() => null);
      return { outcome: 'unconfirmed', screenshotArtifactId: shot?.artifactId ?? null };
    }
    let icsArtifactId: string | null = null;
    const icsHref = await ctx.page
      .$eval('[data-testid=ics-link]', (a) => (a as unknown as DomElement).href ?? '')
      .catch(() => null);
    if (icsHref && ctx.allowed(icsHref)) {
      const file = await ctx.fetchText(icsHref, BROWSER_LIMITS.maxIcsBytes);
      const ev = file.status === 200 ? parseIcs(file.text) : null;
      // The ICS must describe the same appointment as the page (or it is not kept as evidence).
      if (ev?.start && Date.parse(ev.start) === Date.parse(r.start)) {
        icsArtifactId = (await ctx.saveIcs(file.text, icsHref)).artifactId;
      }
    }
    const shot = await ctx.screenshot();
    return {
      outcome: 'confirmed',
      reference: r.reference,
      service: serviceName(input.service),
      start: r.start,
      end: r.end,
      timeZone: BOOKING_TIME_ZONE,
      location: r.location,
      icsArtifactId,
      screenshotArtifactId: shot.artifactId,
      confirmationUrl: nav.url,
    };
  },
  // A confirmation must be for the slot that was approved.
  verify: (input, out) =>
    out.outcome !== 'confirmed' || Date.parse(out.start) === Date.parse(input.expectedStart),
};

const lookup: RecipeOperation<z.infer<typeof LookupInput>, BookingLookupOutput> = {
  description:
    'Look up the reservation Fixture Dental made for an idempotency key (reconciliation).',
  input: LookupInput,
  output: LookupOutput,
  sideEffect: 'none',
  risk: 'LOW',
  idempotency: 'safe_to_retry',
  async run(ctx, input) {
    const origin = originOf(ctx);
    await ctx.goto(
      `${origin}/booking/reservations?key=${encodeURIComponent(input.idempotencyKey)}`,
    );
    const nodes = jsonLdNodes(await ctx.jsonLd()).filter((n) =>
      /Reservation$/.test(String(n['@type'] ?? '')),
    );
    const r = nodes[0] ? reservation(nodes[0]) : null;
    const shot = await ctx.screenshot();
    if (r?.reference && r.confirmed && r.start)
      return {
        found: true,
        reference: r.reference,
        start: r.start,
        end: r.end,
        location: r.location,
        screenshotArtifactId: shot.artifactId,
      };
    if ((await ctx.page.locator('[data-testid=no-reservation]').count()) === 0)
      stopSession('PAGE_CHANGED', { host: new URL(origin).host });
    return { found: false, screenshotArtifactId: shot.artifactId };
  },
  verify: () => true,
};

const fill: RecipeOperation<z.infer<typeof FillInput>, BookingFillOutput> = {
  description: 'Send the Fixture Dental contact form with exactly the given fields, once.',
  input: FillInput,
  output: FillOutput,
  sideEffect: 'binding',
  risk: 'MEDIUM',
  idempotency: 'once_per_step',
  async run(ctx, input) {
    const origin = originOf(ctx);
    await ctx.goto(`${origin}/booking/contact`);
    await ctx.require('[data-testid=contact-form]');
    const inputs = await ctx.page.$$eval('[data-testid=contact-form] [data-label]', (els) =>
      (els as unknown as DomElement[]).map((e) => ({
        label: e.getAttribute('data-label') ?? '',
        name: e.getAttribute('name') ?? '',
      })),
    );
    const given = new Map(
      Object.entries(input.fields).map(([k, v]) => [k.trim().toLowerCase(), v]),
    );
    for (const i of inputs) {
      const v = given.get(i.label.toLowerCase());
      if (v === undefined || !/^[a-z_]{1,32}$/.test(i.name))
        stopSession('PAGE_CHANGED', { host: new URL(origin).host });
      await ctx.page.fill(`[data-testid=contact-form] [name=${i.name}]`, v);
    }
    await ctx.setExtraHeaders({ 'Idempotency-Key': input.idempotencyKey });
    ctx.markSubmitting();
    await ctx.navigateBy(() => ctx.page.click('[data-testid=contact-submit]'));
    const reference = cleanText(
      await ctx.page.textContent('[data-testid=reference]').catch(() => null),
      100,
    );
    const shot = await ctx.screenshot();
    return { submitted: true, reference, screenshotArtifactId: shot.artifactId };
  },
  verify: () => true,
};

export const fixtureBookingRecipe: Recipe = {
  id: 'fixture-booking',
  version: '1.0.0',
  name: 'Fixture Dental',
  aliases: ['fixture dental', 'fixture-dental', 'fixture booking', 'fixture-booking'],
  fixture: true,
  hostLabel: 'local fixture site',
  origins: (config) => {
    const o = fixtureOrigin(config);
    return o ? [o] : [];
  },
  operations: {
    read: readOperation as RecipeOperation<never, unknown>,
    slots: slots as RecipeOperation<never, unknown>,
    book: book as RecipeOperation<never, unknown>,
    booking_lookup: lookup as RecipeOperation<never, unknown>,
    fill: fill as RecipeOperation<never, unknown>,
  },
  booking: { timeZone: BOOKING_TIME_ZONE, services: BOOKING_SERVICES, fields: BOOKING_FIELDS },
  forms: { contact: { fields: CONTACT_FIELDS, commitment: false } },
};

export { localTime as bookingLocalTime };
