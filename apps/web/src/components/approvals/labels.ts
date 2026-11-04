import type { ApprovalDetails } from '@jarvis/contracts';

/**
 * The kind an approval is labelled by (title, Approve / Decline wording): its details' kind, or
 * `emailDraft` for email.draft_reply (mode 'draft': nothing is sent, so "Save draft").
 */
export type ApprovalLabelKind = ApprovalDetails['kind'] | 'emailDraft';

export function approvalLabelKind(details: ApprovalDetails): ApprovalLabelKind {
  return details.kind === 'email' && details.mode === 'draft' ? 'emailDraft' : details.kind;
}

/** Reasons whose wording depends on what is approved (an invitation is not an email). */
const BY_KIND: Partial<Record<ApprovalLabelKind, readonly string[]>> = {
  calendar_event: ['RECIPIENT_EXTERNAL', 'MANY_RECIPIENTS'],
  emailDraft: ['RECIPIENT_EXTERNAL', 'MANY_RECIPIENTS', 'RECIPIENT_SELF'],
  booking: ['PURCHASE'],
};

/** Catalog key of a policy reason as this approval explains it. */
export function reasonKey(kind: ApprovalLabelKind, code: string): string {
  return BY_KIND[kind]?.includes(code)
    ? `approvals.reasonsByKind.${kind}.${code}`
    : `approvals.reasons.${code}`;
}
