const approvals = {
  title: {
    email: 'Review this email',
    generic: 'Review this action',
  },
  fields: {
    from: 'From',
    to: 'To',
    subject: 'Subject',
    body: 'Message',
    noSubject: '(no subject)',
  },
  recipients: '{count, plural, one {# recipient} other {# recipients}}',
  why: 'Why JARVIS is asking',
  reasons: {
    RISK_LOW: 'This is a low-risk action.',
    RISK_MEDIUM: 'This action has a medium risk, so JARVIS asks before doing it.',
    RISK_HIGH: 'This is a high-risk action. JARVIS always asks first.',
    RISK_CRITICAL: 'This action is classified as critical risk.',
    RECIPIENT_SELF: 'The email goes only to your own address.',
    RECIPIENT_EXTERNAL: 'The email goes to someone other than you.',
    MANY_RECIPIENTS: 'The email has more than three recipients.',
    BUDGET_NEAR_LIMIT: 'This step may cost more than what is left of your monthly AI budget.',
    UNTRUSTED_CONTENT:
      'It uses content from a web page that contains text that looks like instructions aimed at AI.',
    AUTO_APPROVED_SELF: 'Your settings allow emails to yourself without asking.',
    unknown: 'The safety policy flagged this action ({code}).',
  },
  untrustedWarning:
    'Suspected instructions aimed at AI were found in the source. Read the message carefully before approving.',
  expires: 'Expires {time}',
  note: {
    add: 'Add a note',
    label: 'Note',
    hint: 'Kept with your decision. It is not sent to anyone.',
  },
  approve: {
    email: 'Approve and send',
    generic: 'Approve',
  },
  approveLabel: {
    email: 'Approve and send this email',
    generic: 'Approve this action',
  },
  decline: 'Decline',
  declineLabel: {
    email: 'Decline sending this email',
    generic: 'Decline this action',
  },
  results: {
    approved: 'Approved. JARVIS is continuing the task.',
    rejected: 'Declined. JARVIS will not do this.',
  },
  errors: {
    mismatch: 'The action changed — review it again.',
    expired: 'This request expired. Retry the task to get a new one.',
    alreadyDecided: 'This approval was already decided.',
  },
  decided: {
    APPROVED: 'You approved this {time}.',
    REJECTED: 'You declined this {time}.',
    EXPIRED: 'This request expired {time}.',
    CANCELLED: 'This request was cancelled.',
    SUPERSEDED: 'This request was replaced by a newer one.',
  },
  openTask: 'Open task',
  task: 'Task',
};

export default approvals;
