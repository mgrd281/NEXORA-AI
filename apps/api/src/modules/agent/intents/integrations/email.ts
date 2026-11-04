/**
 * Offline intents of the email agent (en/de/ar; docs/architecture/phase-c.md §3.2):
 *   "summarize my unread emails"      email.search {unreadOnly} → email.read_thread → text.summarize
 *   "what needs my reply"             email.search {needsReply}
 *   "draft a reply to <sender> saying …"  email.search {from} → email.draft_reply (approval first)
 * The sender is as the user wrote it; the reply's recipients and subject come
 * from the found conversation's headers by reference and are shown in the
 * approval; the body is the user's own text. Nothing is read before planning.
 */
import { msg } from '../../i18n';
import { clarify, objective, stepTitled, titled, type OfflineIntent } from '../types';

const SUMMARIZE =
  /summari[sz]e|summary|recap|digest|go\s+through|zusammenfass\w*|fasse\b|überblick|لخص|لخّص|تلخيص|ملخص/i;
const UNREAD =
  /\bunread\b|\bnew\s+(?:e-?mails?|mails?|messages)\b|ungelesen\w*|neuen?\s+(?:e-?mails?|mails?|nachrichten)|غير\s+المقروءة|غير\s+مقروءة|الجديدة/i;
const MAIL =
  /e-?mails?|\bmails?\b|\binbox\b|\bmessages\b|nachrichten|posteingang|postfach|رسائل|رسائلي|بريد|بريدي|الرسائل|البريد/i;

const NEEDS_REPLY: RegExp[] = [
  /\b(?:what|which)\b[^?]{0,40}\b(?:needs?|waiting\s+for|awaiting|requires?)\b[^?]{0,20}\b(?:my\s+)?(?:reply|response|answer)\b/i,
  /\b(?:e-?mails?|mails?|messages)\b[^?]{0,30}\b(?:i\s+(?:need|have)\s+to|to)\s+(?:reply|respond|answer)\b/i,
  /\bworauf\s+(?:muss|sollte|soll)\s+ich\s+(?:noch\s+)?antworten\b/i,
  /\b(?:welche|was)\b[^?]{0,40}\b(?:e-?mails?|mails?|nachrichten)\b[^?]{0,40}\bantwort\w*/i,
  /(?:ما|ماذا|أي|اي)\s+(?:الذي\s+)?(?:الرسائل\s+التي\s+)?(?:يحتاج|تحتاج|ينتظر|تنتظر)\s+(?:إلى\s+|الى\s+)?(?:رد|ردي|ردّي)/,
];

const DRAFT: RegExp[] = [
  /^(?:please\s+)?(?:draft|write|prepare)\s+(?:a\s+|an\s+)?(?:reply|response|answer)\s+to\s+(.+?)(?:\s+(?:saying|that\s+says|telling\s+(?:him|her|them))\s+|\s*:\s*)([\s\S]+)$/i,
  /^(?:bitte\s+)?(?:entwirf|entwerfe|schreib|schreibe|formulier\w*)\s+(?:mir\s+)?(?:eine[n]?\s+)?(?:antwort(?:entwurf)?|entwurf(?:\s+einer\s+antwort)?)\s+an\s+(.+?)(?:\s*:\s*|\s*,\s*(?:dass|mit)\s+)([\s\S]+)$/i,
  /^(?:من\s+فضلك\s+)?(?:اكتب|أكتب|صغ|حضّر|حضر|جهز|جهّز)\s+(?:لي\s+)?(?:مسودة\s+)?(?:رد|ردا|رداً|ردًا)\s+(?:على|إلى|الى|ل)\s*(.+?)(?:\s*:\s*|\s+(?:يقول|تقول|مفاده|بأن|بان)\s+)([\s\S]+)$/,
];
const DRAFT_BARE: RegExp[] = [
  /^(?:please\s+)?(?:draft|write|prepare)\s+(?:a\s+|an\s+)?(?:reply|response|answer)\s+to\s+(.+?)[.!]?$/i,
  /^(?:bitte\s+)?(?:entwirf|entwerfe|schreib|schreibe)\s+(?:mir\s+)?(?:eine[n]?\s+)?(?:antwort(?:entwurf)?|entwurf)\s+an\s+(.+?)[.!]?$/i,
  /^(?:من\s+فضلك\s+)?(?:اكتب|أكتب|صغ|حضّر|حضر|جهز|جهّز)\s+(?:لي\s+)?(?:مسودة\s+)?(?:رد|ردا|رداً|ردًا)\s+(?:على|إلى|الى|ل)\s*(.+?)[.!؟]?$/,
];

const cleanName = (s: string) =>
  s
    .trim()
    .replace(/^["'“„«]+|["'”“»]+$/g, '')
    .replace(/[,.;]+$/, '')
    .trim();

export const emailUnreadIntent: OfflineIntent = {
  id: 'email.unread-summary',
  plan(request, ctx) {
    if (!(SUMMARIZE.test(request) && UNREAD.test(request) && MAIL.test(request))) return null;
    const lang = ctx.language;
    return {
      ok: true,
      plan: {
        ...titled(lang, msg('plan.emailUnread')),
        ...objective(lang, msg('objective.emailUnread')),
        steps: [
          {
            key: 's1',
            toolId: 'email.search',
            ...stepTitled(lang, msg('step.searchEmail')),
            input: { unreadOnly: true, limit: 10 },
          },
          {
            key: 's2',
            toolId: 'email.read_thread',
            ...stepTitled(lang, msg('step.readThreads')),
            input: { threadIds: '{{s1.threadIds}}' },
          },
          {
            key: 's3',
            toolId: 'text.summarize',
            ...stepTitled(lang, msg('step.summarizeEmail')),
            input: { text: '{{s2.digest}}', language: lang },
          },
        ],
      },
    };
  },
};

export const emailNeedsReplyIntent: OfflineIntent = {
  id: 'email.needs-reply',
  plan(request, ctx) {
    if (!NEEDS_REPLY.some((re) => re.test(request))) return null;
    const lang = ctx.language;
    return {
      ok: true,
      plan: {
        ...titled(lang, msg('plan.emailNeedsReply')),
        ...objective(lang, msg('objective.emailNeedsReply')),
        steps: [
          {
            key: 's1',
            toolId: 'email.search',
            ...stepTitled(lang, msg('step.searchEmail')),
            input: { needsReply: true, limit: 10 },
          },
        ],
      },
    };
  },
};

export const emailDraftReplyIntent: OfflineIntent = {
  id: 'email.draft-reply',
  plan(request, ctx) {
    const lang = ctx.language;
    const text = request.trim();
    for (const re of DRAFT) {
      const m = re.exec(text);
      if (!m) continue;
      const name = cleanName(m[1]!);
      const body = m[2]!.trim();
      if (!name || name.length > 120) return null;
      if (!body) return clarify(lang, ['email_content']);
      return {
        ok: true,
        plan: {
          ...titled(lang, msg('plan.draftReply', { name })),
          ...objective(lang, msg('objective.draftReply', { name })),
          steps: [
            {
              key: 's1',
              toolId: 'email.search',
              ...stepTitled(lang, msg('step.searchEmail')),
              input: { from: name, limit: 1, requireMatch: true },
            },
            {
              key: 's2',
              toolId: 'email.draft_reply',
              ...stepTitled(lang, msg('step.draftReply', { name })),
              input: {
                threadId: '{{s1.firstThreadId}}',
                to: ['{{s1.firstReplyTo}}'],
                subject: '{{s1.firstReplySubject}}',
                body,
              },
            },
          ],
        },
      };
    }
    // "draft a reply to Anna" without what to say: ask, never invent the text. ('details', not
    // 'email_content': the generic answer to that question is an email to yourself, not a reply.)
    if (DRAFT_BARE.some((re) => re.test(text))) return clarify(lang, ['details']);
    return null;
  },
};
