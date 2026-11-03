/**
 * Offline planner: a deterministic, multilingual (en/de/ar) rules engine used
 * when no external model may be used. It understands three intents:
 *
 *   summarize/read/open a URL [and email it to me]   → web.fetch → text.summarize [→ email.send to self]
 *   remember (that) X / merk dir X / تذكر أن X        → memory.save
 *   email me …: <text> / schick mir …: / أرسل لي …:   → email.send to self
 *
 * Everything else fails with PLANNER_UNSUPPORTED. Emails produced here only
 * ever go to the account owner's own address.
 */
import type { Locale } from '@jarvis/contracts';
import { truncate } from '../../../lib/redact';
import { t } from '../i18n';
import type { Plan } from '../plan';

export const OFFLINE_UNSUPPORTED_MESSAGE =
  'JARVIS is running without an AI model, so it understands only these commands: ' +
  '“Summarize <link>” (add “and email it to me” to get the summary by email), ' +
  '“Remember that <something>”, and “Email me: <text>”.';

export type OfflinePlanResult =
  { ok: true; plan: Plan } | { ok: false; code: 'PLANNER_UNSUPPORTED'; message: string };

/* ------------------------------------------------------------------ */
/* Language detection                                                  */
/* ------------------------------------------------------------------ */

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const GERMAN =
  /[äöüß]|\b(bitte|und|mir|mich|dass|fasse|zusammen|zusammenfassen|zusammenfassung|merk|merke|schick|schicke|sende|lies|öffne|die|der|das|ist|ich|eine?n?|nicht|auf|für)\b/i;
const ENGLISH =
  /\b(the|and|me|my|please|summari[sz]e|summary|remember|email|send|read|open|what|is|are|that|it|to)\b/i;

/** Best-effort request language: Arabic script, then German/English markers, then the fallback. */
export function detectLanguage(text: string, fallback: Locale): Locale {
  if (ARABIC.test(text)) return 'ar';
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  const de = (withoutUrls.match(new RegExp(GERMAN.source, 'gi')) ?? []).length;
  const en = (withoutUrls.match(new RegExp(ENGLISH.source, 'gi')) ?? []).length;
  if (de === 0 && en === 0) return fallback;
  if (de > en) return 'de';
  if (en > de) return 'en';
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Intent patterns                                                     */
/* ------------------------------------------------------------------ */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/i;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»”’،؛؟]+$/;

// JS \b is ASCII-only, so words starting with umlauts and Arabic words are matched without it.
const SUMMARIZE =
  /\b(summari[sz]e|summary|sum\s+up|tl;?dr|digest|gist|recap|read|open|fetch|check\s+out|look\s+at|zusammenfass\w*|zusammen|lies|lese|lesen)\b|öffne|überblick|لخص|لخّص|تلخيص|ملخص|اقرأ|إقرأ|اقرا|افتح/i;

const EMAIL_TO_ME =
  /\b(e-?mail|mail|send|forward)\b[^.\n]{0,40}\b(me|myself)\b|\b(to\s+me|to\s+my\s+(inbox|email))\b|\b(schick|schicke|sende|send|maile|mail|leite)\w*\b[^.\n]{0,40}\b(mir|mich)\b|\b(an\s+mich|per\s+e-?mail|per\s+mail)\b|أرسل|ارسل|ابعث|أرسله|ارسله|ابعثه|بالبريد|إيميل|ايميل/i;

const REMEMBER: RegExp[] = [
  /^\s*(?:please\s+|pls\s+|hey\s+jarvis,?\s+|jarvis,?\s+)?(?:remember|memori[sz]e|don'?t\s+forget|keep\s+in\s+mind|note)\s*(?:,|:)?\s*(?:that\s+)?([\s\S]+)$/i,
  /^\s*(?:bitte\s+)?(?:merk|merke|merken\s+sie)\s+(?:dir|sich)\s*(?:,|:)?\s*(?:bitte\s+)?(?:,\s*)?(?:dass\s+)?([\s\S]+)$/i,
  /^\s*(?:bitte\s+)?(?:denk|denke)\s+daran\s*(?:,|:)?\s*(?:dass\s+)?([\s\S]+)$/i,
  /^\s*(?:من\s+فضلك\s+|رجاءً?\s+)?(?:تذكر|تذكّر|احفظ|إحفظ|تذكري)\s*(?:،|:)?\s*(?:أن|أنّ|ان)?\s+([\s\S]+)$/,
];

const EMAIL_NOTE: RegExp[] = [
  /^\s*(?:please\s+)?(?:e-?mail|mail|send)\s+(?:me|myself)\b([^:：\n]*)[:：]\s*([\s\S]+)$/i,
  /^\s*(?:bitte\s+)?(?:schick|schicke|sende|maile)\s+mir\b([^:：\n]*)[:：]\s*([\s\S]+)$/i,
  /^\s*(?:من\s+فضلك\s+)?(?:أرسل|ارسل|ابعث)\s+(?:لي|إلي|إليّ|الي)([^:：\n]*)[:：]\s*([\s\S]+)$/,
];

const PREFERENCE =
  /\b(prefer|like|love|hate|dislike|favou?rite|always|never|allergic|vegetarian|vegan)\b|\b(bevorzuge|mag|liebe|hasse|lieblings\w*|immer|nie|allergisch)\b|أفضل|أحب|أكره|المفضل|دائما|دائمًا|أبدا/i;

const FILLER_SUBJECT =
  /^(?:(?:a|an|the|some)\s+)?(?:e-?mail|mail|note|message|reminder)?$|^(?:eine?n?\s+)?(?:e-?mail|mail|nachricht|notiz|erinnerung)?$|^(?:بريد(?:اً|ًا)?|رسالة|ملاحظة|تذكير)?$/i;

function cleanUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT, '');
  if (/^www\./i.test(url)) url = `https://${url}`;
  return url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase() + s.slice(1) : s);

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

export interface OfflinePlanContext {
  language: Locale;
  ownEmail: string;
}

export function planOffline(request: string, ctx: OfflinePlanContext): OfflinePlanResult {
  const text = request.trim();
  const lang = ctx.language;

  // 1. Memory
  for (const re of REMEMBER) {
    const m = re.exec(text);
    if (!m) continue;
    const content = m[1]!.trim().replace(/\s+/g, ' ');
    if (!content) break;
    if (content.length > 1000) {
      return {
        ok: false,
        code: 'PLANNER_UNSUPPORTED',
        message: 'A memory can be at most 1000 characters long.',
      };
    }
    return {
      ok: true,
      plan: {
        title: truncate(t(lang, 'plan.remember', { text: content }), 80),
        objective: t(lang, 'objective.remember'),
        steps: [
          {
            key: 's1',
            toolId: 'memory.save',
            title: t(lang, 'step.remember'),
            input: { content, kind: PREFERENCE.test(content) ? 'preference' : 'fact' },
          },
        ],
      },
    };
  }

  // 2. Summarize a link (optionally email it to me)
  const urlMatch = URL_RE.exec(text);
  const notePattern = EMAIL_NOTE.some((re) => re.test(text));
  if (urlMatch && (SUMMARIZE.test(text.replace(urlMatch[0], ' ')) || !notePattern)) {
    const url = cleanUrl(urlMatch[0]);
    const host = hostOf(url);
    const withEmail = EMAIL_TO_ME.test(text.replace(urlMatch[0], ' '));
    const steps: Plan['steps'] = [
      { key: 's1', toolId: 'web.fetch', title: t(lang, 'step.fetch', { host }), input: { url } },
      {
        key: 's2',
        toolId: 'text.summarize',
        title: t(lang, 'step.summarize'),
        input: { text: '{{s1.text}}', title: '{{s1.title}}', language: lang },
      },
    ];
    if (withEmail) {
      steps.push({
        key: 's3',
        toolId: 'email.send',
        title: t(lang, 'step.emailSummary'),
        input: {
          to: [ctx.ownEmail],
          subject: t(lang, 'email.summarySubject', { title: '{{s1.title}}' }),
          body: `{{s2.summary}}\n\n{{s2.methodNote}}\n${t(lang, 'email.source')}: {{s1.finalUrl}}`,
        },
      });
    }
    return {
      ok: true,
      plan: {
        title: truncate(
          t(lang, withEmail ? 'plan.summarizeEmail' : 'plan.summarize', { host }),
          80,
        ),
        objective: t(lang, withEmail ? 'objective.summarizeEmail' : 'objective.summarize', {
          url,
          email: ctx.ownEmail,
        }),
        steps,
      },
    };
  }

  // 3. Email me: <text>
  for (const re of EMAIL_NOTE) {
    const m = re.exec(text);
    if (!m) continue;
    const hint = m[1]!.trim().replace(/^(?:a|an|the|eine?n?)\s+/i, '');
    const body = m[2]!.trim();
    if (!body) break;
    const firstLine = body.split('\n')[0]!.trim();
    const subject = truncate(
      FILLER_SUBJECT.test(m[1]!.trim()) || hint.length < 3 ? firstLine : capitalize(hint),
      120,
    );
    return {
      ok: true,
      plan: {
        title: truncate(t(lang, 'plan.emailSelf', { text: subject }), 80),
        objective: t(lang, 'objective.emailSelf', { email: ctx.ownEmail }),
        steps: [
          {
            key: 's1',
            toolId: 'email.send',
            title: t(lang, 'step.emailNote'),
            input: {
              to: [ctx.ownEmail],
              subject: subject || t(lang, 'email.noteSubject'),
              body,
            },
          },
        ],
      },
    };
  }

  return { ok: false, code: 'PLANNER_UNSUPPORTED', message: OFFLINE_UNSUPPORTED_MESSAGE };
}
