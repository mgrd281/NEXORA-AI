/**
 * Offline intents of calendars and meetings (en/de/ar; docs/architecture/phase-c.md §3.3, §3.4):
 *   "what's on my calendar [today | tomorrow | this week]"      calendar.list
 *   "find a time to meet <address> [for N minutes] <when>"      calendar.free_busy (no window → ask)
 *   follow-up "book Tuesday 10:00" after proposed times         calendar.create_event with the
 *                                                               attendees of that request (approval)
 *   "add <title> to my calendar on <day> at <time>"             calendar.create_event (no time → ask)
 * Attendees are only addresses the user wrote; times are local wall-clock
 * values the tool resolves in the account's zone (bound at planning).
 */
import type { Locale } from '@jarvis/contracts';
import type { PriorTurn } from '../../conversation-context';
import { msg } from '../../i18n';
import { recipientsParam } from '../../tools/email-send';
import {
  clarify,
  objective,
  stepTitled,
  titled,
  type OfflineIntent,
  type OfflinePlanContext,
} from '../types';
import {
  addMinutesLocal,
  addressesIn,
  asciiDigits,
  localDateTimeString,
  parseDays,
  parseDuration,
  parseTime,
} from './dates';

const CALENDAR_WORDS =
  /\b(?:calendar|schedule|agenda|appointments?|meetings?|events?)\b|kalender|termine?\b|تقويمي|التقويم|جدولي|مواعيدي|اجتماعاتي|أحداثي/i;
const WHATS_ON: RegExp[] = [
  /\b(?:what'?s|what\s+is|what\s+do\s+i\s+have|show(?:\s+me)?|list|check|read)\b[^?]{0,40}\b(?:on\s+)?my\s+(?:calendar|schedule|agenda)\b/i,
  /\bmy\s+(?:upcoming|next)\s+(?:events|appointments|meetings)\b/i,
  /\bwhat\s+(?:meetings|appointments|events)\s+do\s+i\s+have\b/i,
  /\bwas\s+steht\b[^?]{0,40}\bkalender\b/i,
  /\b(?:zeig|zeige)\b[^?]{0,20}\b(?:meine[n]?\s+)?(?:termine|kalender)\b/i,
  /\bwelche\s+termine\s+habe\s+ich\b|\bmeine\s+(?:nächsten|anstehenden)\s+termine\b/i,
  /(?:ما\s+الذي|ماذا)\s+(?:يوجد\s+)?في\s+(?:تقويمي|جدولي)/,
  /(?:اعرض|أظهر|ما\s+هي)\s+(?:لي\s+)?(?:مواعيدي|اجتماعاتي|أحداثي)/,
  /(?:مواعيدي|اجتماعاتي)\s+(?:القادمة|اليوم|غدا|غداً)/,
];
const FIND_TIME: RegExp[] = [
  /\b(?:find|suggest|propose|look\s+for|when\s+can)\b[^?]{0,40}\b(?:time|slot|meet|meeting)\b/i,
  /\b(?:finde|such\w*|schlag\w*)\b[^?]{0,40}\b(?:termin|zeit)\b[^?]{0,40}\b(?:mit|treffen)\b/i,
  /\bwann\s+(?:kann|könnte)\s+ich\b[^?]{0,40}\btreffen\b/i,
  /(?:ابحث|جد|اقترح|أوجد)\s+(?:لي\s+)?(?:عن\s+)?(?:وقت|موعد)[^؟]{0,40}(?:لقاء|اجتماع|مع)/,
];
const BOOK_FOLLOW_UP =
  /^\s*(?:please\s+)?(?:book|schedule|take|let'?s\s+(?:do|take)|go\s+with|choose|pick)\b|^\s*(?:bitte\s+)?(?:buche|buch|nimm|trag\w*|plane|wähle)\b|^\s*(?:من\s+فضلك\s+)?(?:احجز|اختر|ثبّت|ثبت|خذ)/i;
const ADD_EVENT: RegExp[] = [
  /^\s*(?:please\s+)?(?:add|put|create|schedule)\s+(.+?)\s+(?:to|in|on|into)\s+my\s+calendar\b([\s\S]*)$/i,
  /^\s*(?:bitte\s+)?(?:trag\w*|füge|leg\w*)\s+(.+?)\s+(?:in\s+meinen\s+kalender|in\s+den\s+kalender|zu\s+meinem\s+kalender)(?:\s+(?:ein|hinzu|an))?([\s\S]*)$/i,
  /^\s*(?:من\s+فضلك\s+)?(?:أضف|اضف|سجّل|سجل)\s+(.+?)\s+(?:إلى|الى|في)\s+(?:تقويمي|التقويم)([\s\S]*)$/,
];
const TOPIC =
  /\b(?:about|re|regarding|on\s+the\s+topic\s+of)\s+["“]?([^"”,.;\n]{3,80})|\b(?:zum\s+thema|wegen|bezüglich|über)\s+["„]?([^"“,.;\n]{3,80})|(?:بخصوص|حول|بشأن)\s+([^،.;\n]{3,80})/i;

/** "Meeting with {who}" in the request language: the event's title when the user named none (content). */
const MEETING_WITH: Record<Locale, string> = {
  en: 'Meeting with {who}',
  de: 'Termin mit {who}',
  ar: 'اجتماع مع {who}',
};

const findTimeOf = (text: string) => FIND_TIME.some((re) => re.test(text));

function meetingTitle(request: string, who: string[], lang: Locale): string {
  const t = TOPIC.exec(request);
  const topic = (t?.[1] ?? t?.[2] ?? t?.[3])?.trim();
  if (topic) return topic.slice(0, 200);
  return MEETING_WITH[lang].replace('{who}', who.join(', ')).slice(0, 200);
}

export const calendarUpcomingIntent: OfflineIntent = {
  id: 'calendar.upcoming',
  plan(request, ctx) {
    if (!WHATS_ON.some((re) => re.test(request)) || findTimeOf(request)) return null;
    const lang = ctx.language;
    const tz = ctx.timeZone ?? 'UTC';
    const days = parseDays(request, tz);
    const input: Record<string, unknown> = days
      ? { from: `${days.from}T00:00`, to: `${days.to}T00:00` }
      : { days: 7 };
    return {
      ok: true,
      plan: {
        ...titled(lang, msg('plan.calendarUpcoming')),
        ...objective(lang, msg('objective.calendarUpcoming')),
        steps: [
          {
            key: 's1',
            toolId: 'calendar.list',
            ...stepTitled(lang, msg('step.listEvents')),
            input,
          },
        ],
      },
    };
  },
};

export const calendarFindTimeIntent: OfflineIntent = {
  id: 'calendar.find-time',
  plan(request, ctx) {
    if (!findTimeOf(request) || !CALENDAR_WORDS.test(`${request} meeting`)) return null;
    const lang = ctx.language;
    const who = addressesIn(request).filter((a) => a !== ctx.ownEmail.toLowerCase());
    if (who.length === 0) return clarify(lang, ['recipient']);
    const tz = ctx.timeZone ?? 'UTC';
    const days = parseDays(request, tz);
    if (!days) return clarify(lang, ['date_time']);
    const whoParam = who.join(', ');
    return {
      ok: true,
      plan: {
        ...titled(lang, msg('plan.findMeetingTime', { who: whoParam })),
        ...objective(lang, msg('objective.findMeetingTime', { who: whoParam })),
        steps: [
          {
            key: 's1',
            toolId: 'calendar.free_busy',
            ...stepTitled(lang, msg('step.freeBusy')),
            input: {
              attendees: who,
              from: `${days.from}T00:00`,
              to: `${days.to}T00:00`,
              durationMinutes: Math.min(480, Math.max(5, parseDuration(request) ?? 30)),
            },
          },
        ],
      },
    };
  },
};

/** The proposals turn this follow-up answers: the newest completed "find a time" turn. */
function proposalsTurn(turns: readonly PriorTurn[]): PriorTurn | null {
  const last = turns.at(-1);
  return last && last.status === 'COMPLETED' && last.titleMessage?.key === 'plan.findMeetingTime'
    ? last
    : null;
}

function eventPlan(
  lang: Locale,
  p: { title: string; start: string; end: string; attendees: string[] },
) {
  const step = msg('step.createEvent', { title: p.title });
  const what = p.attendees.length
    ? msg('approval.eventInvite', { title: p.title, recipients: recipientsParam(p.attendees) })
    : msg('approval.eventCreate', { title: p.title });
  return {
    ok: true as const,
    plan: {
      ...titled(lang, step),
      ...objective(lang, what),
      steps: [
        {
          key: 's1',
          toolId: 'calendar.create_event' as const,
          ...stepTitled(lang, step),
          input: { title: p.title, start: p.start, end: p.end, attendees: p.attendees },
        },
      ],
    },
  };
}

export const calendarBookMeetingIntent: OfflineIntent = {
  id: 'calendar.book-meeting',
  plan(request, ctx) {
    const turn = proposalsTurn(ctx.conversation ?? []);
    if (!turn || !BOOK_FOLLOW_UP.test(asciiDigits(request))) return null;
    const lang = ctx.language;
    const tz = ctx.timeZone ?? 'UTC';
    const day = parseDays(request, tz) ?? parseDays(turn.request, tz);
    const time = parseTime(day ? request.replace(day.matched, ' ') : request);
    if (!day || !time || day.to !== addDaysOne(day.from)) return clarify(lang, ['date_time']);
    // The people of the request that asked for the proposals (the user's own words).
    const who = addressesIn(turn.request).filter((a) => a !== ctx.ownEmail.toLowerCase());
    if (who.length === 0) return null;
    const minutes = parseDuration(request) ?? parseDuration(turn.request) ?? 30;
    const start = localDateTimeString(day.from, time.hour, time.minute);
    return eventPlan(lang, {
      title: meetingTitle(turn.request, who, lang),
      start,
      end: addMinutesLocal(start, Math.min(480, Math.max(5, minutes))),
      attendees: who,
    });
  },
};

function addDaysOne(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

const DANGLING =
  /^(?:on|at|for|am|um|für|يوم|الساعة|في)\s+|\s+(?:on|at|for|am|um|für|يوم|الساعة|في)$/i;

export const calendarAddEventIntent: OfflineIntent = {
  id: 'calendar.add-event',
  plan(request, ctx) {
    const lang = ctx.language;
    const text = request.trim();
    for (const re of ADD_EVENT) {
      const m = re.exec(text);
      if (!m) continue;
      const tz = ctx.timeZone ?? 'UTC';
      const day = parseDays(text, tz);
      const time = parseTime(day ? text.replace(day.matched, ' ') : text);
      if (!day || !time || day.to !== addDaysOne(day.from)) return clarify(lang, ['date_time']);
      // The title is the user's words without the date and time phrases ("Zahnarzt am 01.12. um 15 Uhr").
      let title = asciiDigits(m[1]!)
        .replace(day.matched, ' ')
        .replace(time.matched, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      for (let i = 0; i < 3; i++) title = title.replace(DANGLING, '').trim();
      title = title
        .replace(/^(?:an?|the|eine[n]?|den|die|das)\s+/i, '')
        .replace(/^["'“„«]+|["'”“»]+$/g, '')
        .trim();
      if (!title || title.length > 200) return clarify(lang, ['details']);
      const attendees = addressesIn(text).filter((a) => a !== ctx.ownEmail.toLowerCase());
      const start = localDateTimeString(day.from, time.hour, time.minute);
      const minutes = parseDuration(text) ?? 60;
      return eventPlan(lang, {
        title,
        start,
        end: addMinutesLocal(start, Math.min(480, Math.max(5, minutes))),
        attendees,
      });
    }
    return null;
  },
};

/**
 * An answer to a question one of these intents asked ("When?" → "tomorrow"):
 * the earlier request with the answer, planned again — taken only when it is a
 * real plan now (never the same question twice).
 */
export function answerIntent(intents: readonly OfflineIntent[]): OfflineIntent {
  return {
    id: 'integrations.answer',
    plan(request, ctx: OfflinePlanContext) {
      const turns = ctx.conversation ?? [];
      const last = turns.at(-1);
      if (!last || last.outcome !== 'question') return null;
      const missing = last.missing ?? [];
      const joiner = missing.includes('details')
        ? ': '
        : missing.includes('date_time')
          ? ' '
          : null;
      if (!joiner) return null;
      const combined = `${last.request.trim().replace(/[.!?؟]+$/, '')}${joiner}${request.trim()}`;
      const rest = { ...ctx, conversation: turns.slice(0, -1) };
      for (const intent of intents) {
        const r = intent.plan(combined, rest);
        if (!r) continue;
        const asks =
          r.ok && r.plan.steps.length === 1 && r.plan.steps[0]!.toolId === 'assistant.clarify';
        return r.ok && !asks ? r : null;
      }
      return null;
    },
  };
}
