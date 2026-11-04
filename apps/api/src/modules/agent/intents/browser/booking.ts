/**
 * Offline intents for booking on supported sites (docs/architecture/phase-c.md §3.4,
 * scenario 1), en/de/ar:
 *
 *   "find free appointments at Fixture Dental [for a cleaning] [tomorrow]"
 *   "book a check-up at Fixture Dental"                        → booking.find_slots (lists live slots)
 *   "book a check-up at Fixture Dental on 2026-11-12 at 10:00 for Alex Example, phone +49 30 1234567"
 *        → booking.find_slots { from, to, at } → booking.book { slot: {{s1.firstSlot}}, details }
 *          [→ calendar.create_event from the booking's output when a calendar grants calendar.write]
 *   follow-ups: "book Thursday at 10 for …" after a find-slots turn of the same site, and the
 *   answers to the questions asked here (contact details, date/time, site, service).
 *
 * Only registered recipes are named; the name and email the form receives are the
 * user's words (or the account's display name and email); a phone number only if written. Anything
 * missing → assistant.clarify (contact_details / date_time / site / details). The
 * planner never reads the site: the slot is chosen by the live read at run time.
 */
import type { MissingInfo } from '@jarvis/contracts';
import { recipesNamedIn } from '../../../browser/sites';
import type { Recipe } from '../../../browser/types';
import { msg } from '../../i18n';
import type { Plan } from '../../plan';
import {
  clarify,
  hasCapability,
  objective,
  stepTitled,
  titled,
  type OfflineIntent,
  type OfflinePlanContext,
  type OfflinePlanResult,
} from '../types';
import { nameFromAnswer, parseDate, parseEmail, parseName, parsePhone, parseTime } from './parse';

const BOOK_VERB =
  /\b(?:book|reserve|schedule|make\s+an?\s+appointment|get\s+an?\s+appointment)\b|\b(?:buche|buchen|buch|reserviere|reservieren|vereinbare|vereinbaren)\b|احجز|أحجز|احجزي|احجزوا|حجز\s+موعد/i;
const FIND_VERB =
  /\b(?:free|available|open)\s+(?:appointments?|slots?|times?)\b|\bavailability\b|\bwhen\s+can\s+i\b|\bfreie[nr]?\s+termine?\b|\btermine?\s+frei\b|\bwann\b[^?]{0,40}\btermin|مواعيد\s+(?:متاحة|فارغة|شاغرة)|موعد\s+متاح|المواعيد\s+المتاحة/i;
const APPOINTMENT_WORD =
  /\b(?:appointment|slot|check-?up|cleaning|dentist)\b|\b(?:termin|zahnarzt|kontrolle|zahnreinigung)\b|موعد|طبيب|أسنان/i;

interface BookingParts {
  recipe: Recipe | null;
  serviceId: string | null;
  date: string | null;
  time: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
}

function serviceIn(recipe: Recipe, text: string): string | null {
  const t = ` ${text.toLowerCase().replace(/[.,;:!?()"“”]/g, ' ')} `;
  for (const s of recipe.booking?.services ?? [])
    for (const name of [s.name.toLowerCase(), ...s.aliases])
      if (
        t.includes(` ${name} `) ||
        (name.length > 3 && !/^[a-z -]+$/.test(name) && t.includes(name))
      )
        return s.id;
  return (recipe.booking?.services.length ?? 0) === 1 ? recipe.booking!.services[0]!.id : null;
}

function partsOf(text: string, zone: string, answer?: string): BookingParts {
  const recipe = recipesNamedIn(text).find((r) => r.booking) ?? null;
  // "for Fixture Dental" names the site, not the person.
  const named = parseName(text) ?? (answer ? nameFromAnswer(answer) : null);
  const name = named && recipesNamedIn(named).length === 0 ? named : null;
  return {
    recipe,
    serviceId: recipe ? serviceIn(recipe, text) : null,
    date: parseDate(text, zone),
    time: parseTime(text),
    name,
    phone: parsePhone(text),
    email: parseEmail(text),
  };
}

/** Later words win field by field (a follow-up only says what changes). */
function merge(earlier: BookingParts, later: BookingParts): BookingParts {
  return {
    recipe: later.recipe ?? earlier.recipe,
    serviceId: later.recipe ? later.serviceId : (later.serviceId ?? earlier.serviceId),
    date: later.date ?? earlier.date,
    time: later.time ?? earlier.time,
    name: later.name ?? earlier.name,
    phone: later.phone ?? earlier.phone,
    email: later.email ?? earlier.email,
  };
}

const serviceName = (recipe: Recipe, id: string) =>
  recipe.booking?.services.find((s) => s.id === id)?.name ?? id;

function findSlotsPlan(
  ctx: OfflinePlanContext,
  p: BookingParts & { recipe: Recipe; serviceId: string },
): OfflinePlanResult {
  const lang = ctx.language;
  const site = p.recipe.name;
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.findSlots', { site })),
      ...objective(lang, msg('objective.findSlots', { site })),
      steps: [
        {
          key: 's1',
          toolId: 'booking.find_slots',
          ...stepTitled(lang, msg('step.findSlots', { site })),
          input: {
            siteId: p.recipe.id,
            service: serviceName(p.recipe, p.serviceId),
            ...(p.date ? { from: p.date, to: p.date } : {}),
          },
        },
      ],
    },
  };
}

function bookPlan(
  ctx: OfflinePlanContext,
  p: BookingParts & { recipe: Recipe; serviceId: string; date: string; time: string },
): OfflinePlanResult {
  const lang = ctx.language;
  const site = p.recipe.name;
  const service = serviceName(p.recipe, p.serviceId);
  const details: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of p.recipe.booking?.fields ?? []) {
    const value =
      f.kind === 'name'
        ? (p.name ?? (ctx.ownName?.trim() || null))
        : f.kind === 'email'
          ? (p.email ?? ctx.ownEmail)
          : f.kind === 'phone'
            ? p.phone
            : null;
    if (value) details[f.label] = value;
    else if (f.required) missing.push(f.label);
  }
  if (missing.length) return clarify(lang, ['contact_details']);
  const steps: Plan['steps'] = [
    {
      key: 's1',
      toolId: 'booking.find_slots',
      ...stepTitled(lang, msg('step.findSlots', { site })),
      input: { siteId: p.recipe.id, service, from: p.date, to: p.date, at: p.time },
    },
    {
      key: 's2',
      toolId: 'booking.book',
      ...stepTitled(lang, msg('step.book', { site })),
      input: { siteId: p.recipe.id, slot: '{{s1.firstSlot}}', details },
    },
  ];
  if (hasCapability(ctx, 'calendar.write'))
    steps.push({
      key: 's3',
      toolId: 'calendar.create_event',
      ...stepTitled(lang, msg('step.saveToCalendar')),
      input: {
        title: '{{s2.title}}',
        start: '{{s2.start}}',
        end: '{{s2.end}}',
        timeZone: p.recipe.booking?.timeZone ?? ctx.timeZone ?? 'UTC',
        location: '{{s2.location}}',
        sourceBookingId: '{{s2.bookingId}}',
      },
    });
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.book', { service, site })),
      ...objective(lang, msg('objective.book', { service, site })),
      steps,
    },
  };
}

/** The plan for parts: list slots, book one, or ask for what is missing. */
function planFor(
  ctx: OfflinePlanContext,
  p: BookingParts,
  wantsBooking: boolean,
): OfflinePlanResult {
  const lang = ctx.language;
  if (!p.recipe) return clarify(lang, ['site']);
  if (!p.serviceId) return clarify(lang, ['details']);
  const r = { ...p, recipe: p.recipe, serviceId: p.serviceId };
  if (!wantsBooking || (!p.time && !p.date)) return findSlotsPlan(ctx, r);
  if (!p.time) return p.date ? findSlotsPlan(ctx, r) : clarify(lang, ['date_time']);
  if (!p.date) return clarify(lang, ['date_time']);
  return bookPlan(ctx, { ...r, date: p.date, time: p.time });
}

const MY_QUESTIONS: ReadonlySet<MissingInfo> = new Set([
  'contact_details',
  'date_time',
  'site',
  'details',
]);

/** What a one-step clarify plan asks for, or null. */
export function clarifyOf(r: OfflinePlanResult): MissingInfo[] | null {
  if (!r.ok || r.plan.steps.length !== 1 || r.plan.steps[0]!.toolId !== 'assistant.clarify')
    return null;
  return (r.plan.steps[0]!.input.missing as MissingInfo[] | undefined) ?? null;
}

export const bookingIntent: OfflineIntent = {
  id: 'booking.site',
  plan(request, ctx) {
    const zone = ctx.timeZone ?? 'UTC';
    const turns = ctx.conversation ?? [];
    const last = turns.at(-1);

    // An answer to a question this intent asked: the question's request plus the answer.
    if (last?.outcome === 'question' && (last.missing ?? []).some((m) => MY_QUESTIONS.has(m))) {
      const asked = partsOf(last.request, zone);
      if (asked.recipe || BOOK_VERB.test(last.request)) {
        const answer = partsOf(request, zone, request);
        const merged = merge(asked, answer);
        const r = planFor(ctx, merged, BOOK_VERB.test(last.request));
        // Asking the very same thing again would loop: let other intents try instead.
        const asksAgain = clarifyOf(r);
        if (!asksAgain || asksAgain.join() !== (last.missing ?? []).join()) return r;
      }
    }

    const wantsBooking = BOOK_VERB.test(request);
    const wantsSlots = FIND_VERB.test(request);
    const here = partsOf(request, zone);
    if (!here.recipe) {
      // A follow-up ("book Thursday at 10 for …") to an earlier turn about a booking site.
      if (wantsBooking && (here.time || here.date)) {
        for (const t of [...turns].reverse()) {
          const earlier = partsOf(t.request, zone);
          if (earlier.recipe) return planFor(ctx, merge(earlier, here), true);
        }
      }
      // "book an appointment" without a site we support: ask which one (never guess).
      if ((wantsBooking || wantsSlots) && APPOINTMENT_WORD.test(request) && !/@/.test(request))
        return clarify(ctx.language, ['site']);
      return null;
    }
    if (!wantsBooking && !wantsSlots && !APPOINTMENT_WORD.test(request)) return null;
    return planFor(ctx, here, wantsBooking && !(wantsSlots && !here.time));
  },
};
