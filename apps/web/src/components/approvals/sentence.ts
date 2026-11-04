import type { Approval } from '@jarvis/contracts';
import type { Messages } from '@/i18n/catalog';
import type { Formatters } from '@/i18n/format';
import { renderServerMessage } from '@/i18n/server-message';
import type { TranslateFn } from '@/i18n/translate';

/** Left-to-right isolate … pop isolate: an email address stays one LTR run in any sentence. */
const LRI = '\u2066';
const PDI = '\u2069';
/** Word joiner: no line break here. */
const WJ = '\u2060';

/**
 * The one sentence the user consents to ("Send “Subject” to owner@example.com"), in the
 * interface language. For email it is built from the approval's details, so it never shows in
 * the language the request happened to be typed in. Other tools use the server's sentence as a
 * message (summaryMessage) in the interface language, and only without one fall back to the
 * stored summary (`localized: false`: render it as user text, e.g. with <UserText>).
 */
export function approvalSentence(
  approval: Pick<Approval, 'details' | 'summary' | 'summaryMessage'>,
  {
    t,
    f,
    messages,
  }: {
    t: TranslateFn;
    f: Pick<Formatters, 'list'> & Partial<Pick<Formatters, 'intlLocale'>>;
    messages?: Messages;
  },
): { text: string; localized: boolean } {
  const details = approval.details;
  if (details.kind !== 'email') {
    // With the locale, a total ("USD 129.99") reads in the viewer's notation.
    const money = f.intlLocale ? { intlLocale: f.intlLocale } : undefined;
    const rendered = messages
      ? renderServerMessage({ t, messages, f: money }, approval.summaryMessage)
      : null;
    return rendered !== null
      ? { text: rendered, localized: true }
      : { text: approval.summary, localized: false };
  }
  const subject = details.subject.trim() || t('approvals.fields.noSubject');
  // Each address is one LTR run that never breaks at its hyphens (word joiner after each).
  const recipients = f.list(
    details.to.map((address) => `${LRI}${address.replace(/-/g, `-${WJ}`)}${PDI}`),
  );
  // A draft is saved in the mailbox, never sent: the sentence must not say "Send".
  const key = details.mode === 'draft' ? 'approvals.summary.emailDraft' : 'approvals.summary.email';
  return { text: t(key, { subject, recipients }), localized: true };
}
