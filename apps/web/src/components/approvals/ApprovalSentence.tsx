'use client';

import type { Approval } from '@jarvis/contracts';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { approvalSentence } from './sentence';

export { approvalSentence } from './sentence';

/**
 * The sentence the user consents to (see approvalSentence): interface language for email, the
 * server's summary as direction-isolated user text otherwise. Use it wherever an approval is
 * summarised (the sheet, Home, the task page) so all three say the same thing.
 */
export function ApprovalSentence({
  approval,
  className,
  as = 'p',
}: {
  approval: Pick<Approval, 'details' | 'summary'>;
  className?: string;
  as?: 'p' | 'span';
}) {
  const i18n = useI18n();
  const { text, localized } = approvalSentence(approval, i18n);
  if (localized) {
    const Tag = as;
    return <Tag className={className}>{text}</Tag>;
  }
  return (
    <UserText as={as} className={className}>
      {text}
    </UserText>
  );
}
