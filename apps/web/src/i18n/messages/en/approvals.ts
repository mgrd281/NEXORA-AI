const approvals = {
  title: {
    email: 'Review this email',
    generic: 'Review this action',
    schedule: 'Review this schedule',
    memory: 'Review what JARVIS will remember',
  },
  fields: {
    from: 'From',
    to: 'To',
    subject: 'Subject',
    body: 'Message',
    noSubject: '(no subject)',
    scheduleTitle: 'Name',
    request: 'Each run asks',
    repeats: 'Repeats',
    nextRuns: 'Next runs',
    timeZone: 'Time zone',
    rule: 'Rule (RFC 5545)',
    memoryContent: 'Will be saved',
    memoryKind: 'Kind',
    source: 'Taken from',
  },
  recipients: '{count, plural, one {# recipient} other {# recipients}}',
  /** The sentence the user consents to; subject and recipients are isolated user text. */
  summary: {
    email: 'Send “{subject}” to {recipients}',
  },
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
      'The action uses content from a web page that contains text that looks like instructions aimed at AI.',
    AUTO_APPROVED_SELF: 'Your settings allow emails to yourself without asking.',
    SKILL_DISABLED: 'The skill this needs is turned off in Settings.',
    SKILL_COST_LIMIT: 'This may cost more than the limit set for this skill.',
    MEMORY_FROM_CONTENT:
      'The text comes from an earlier result, so you decide exactly what JARVIS keeps.',
    UNTRUSTED_MEMORY:
      'The text comes from content that tried to instruct AI assistants, so it can’t be saved.',
    FUTURE_RUNS:
      'This sets up requests that run later on their own. JARVIS asks before creating it.',
    unknown: 'The safety policy flagged this action ({code}).',
  },
  untrusted: {
    chip: 'Untrusted source',
    title: 'Text on {host} tried to give instructions to AI assistants.',
    titleNoHost: 'A source used for this tried to give instructions to AI assistants.',
    leftOut: 'JARVIS left that text out of the summary.',
    leftOutCount:
      '{count, plural, one {JARVIS left that sentence out of the summary.} other {JARVIS left those # sentences out of the summary.}}',
    mayInclude: 'Parts of it may appear in the message.',
    check: 'Check the message before you approve.',
  },
  expires: 'Expires {time}',
  note: {
    add: 'Add a note',
    label: 'Note',
    hint: 'Kept with your decision. It is not sent to anyone.',
  },
  approve: {
    email: 'Approve and send',
    generic: 'Approve',
    schedule: 'Approve and create',
    memory: 'Approve and save',
  },
  approveLabel: {
    email: 'Approve and send this email',
    generic: 'Approve this action',
    schedule: 'Approve and create this schedule',
    memory: 'Approve and save this to memory',
  },
  decline: 'Decline',
  declineLabel: {
    email: 'Decline sending this email',
    generic: 'Decline this action',
    schedule: 'Decline creating this schedule',
    memory: 'Decline saving this to memory',
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
  scheduleNote:
    'Nothing is approved in advance: every run is planned and checked on its own, and anything that needs your approval will ask you then.',
  memorySource: 'The result of an earlier task',
  memoryNote: 'JARVIS keeps exactly this text. You can edit or delete it in Memory later.',
  openTask: 'Open task',
  task: 'Task',
};

export default approvals;
