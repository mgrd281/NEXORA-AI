import type { Approval } from '@jarvis/contracts';
import type { Formatters } from '@/i18n/format';
import type { TranslateFn } from '@/i18n/translate';

/** Left-to-right isolate … pop isolate: an email address stays one LTR run in any sentence. */
const LRI = '\u2066';
const PDI = '\u2069';
/** Word joiner: no line break here. */
const WJ = '\u2060';

/**
 * The one sentence the user consents to ("Send “Subject” to owner@example.com"), in the
 * interface language. For email it is built from the approval's details, so it never shows in
 * the language the request happened to be typed in. Other tools fall back to the server's
 * summary (`localized: false`: render it as user text, e.g. with <UserText>).
 */
export function approvalSentence(
  approval: Pick<Approval, 'details' | 'summary'>,
  { t, f }: { t: TranslateFn; f: Pick<Formatters, 'list'> },
): { text: string; localized: boolean } {
  const details = approval.details;
  if (details.kind !== 'email') return { text: approval.summary, localized: false };
  const subject = details.subject.trim() || t('approvals.fields.noSubject');
  // Each address is one LTR run that never breaks at its hyphens (word joiner after each).
  const recipients = f.list(
    details.to.map((address) => `${LRI}${address.replace(/-/g, `-${WJ}`)}${PDI}`),
  );
  return { text: t('approvals.summary.email', { subject, recipients }), localized: true };
}
