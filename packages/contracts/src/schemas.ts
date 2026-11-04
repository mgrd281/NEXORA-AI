import { z } from 'zod';
import {
  AnsweredBy,
  ApprovalStatus,
  AttachmentMediaType,
  AttendeeResponse,
  BookingStatus,
  CallNoteCode,
  CallPurpose,
  CallResult,
  CallSpeaker,
  CallStatus,
  CallTurnKind,
  DoNotCallSource,
  PhoneVerificationStatus,
  RecordingConsent,
  RecordingMode,
  VoiceEndReason,
  VoiceSessionMode,
  VoicemailAction,
  BrowserSessionStatus,
  BrowserStopReason,
  ConnectionCapability,
  ConnectionProvider,
  ConnectionStatus,
  ConnectionStatusReason,
  EmailWatchStatus,
  ErrorCode,
  EvidenceArtifactKind,
  EvidenceMediaType,
  Locale,
  MemoryKind,
  MessageKind,
  MissingInfo,
  NotificationKind,
  OAuthProvider,
  OrderStatus,
  Platform,
  ReliabilitySignalCode,
  RiskLevel,
  Role,
  ScheduleFrequency,
  SchedulePauseReason,
  ScheduleRunReason,
  ScheduleRunStatus,
  ScheduleStatus,
  SkillId,
  SkillStatus,
  SkillUnavailableReason,
  StepStatus,
  TaskOutcome,
  TaskSource,
  TaskStatus,
  ThemePreference,
  ToolId,
  WebhookDeliveryEventType,
  WebhookDeliveryStatus,
  WebhookDisabledReason,
  WebhookEndpointStatus,
  WebhookEventType,
  WebhookFailureReason,
  Weekday,
} from './enums';
import {
  ATTACHMENT_LIMITS,
  CALENDAR_LIMITS,
  CALL_LIMITS,
  COMMERCE_LIMITS,
  EMAIL_LIMITS,
  MEMORY_RETENTION_DAYS,
  OAUTH_LIMITS,
  SCHEDULE_LIMITS,
  TASK_HISTORY_RETENTION_DAYS,
  VOICE_LIMITS,
} from './limits';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const Id = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
/** Money is transported as integer micro-dollars to avoid float drift. */
export const MicroUsd = z.number().int().nonnegative();
/**
 * Phase D: a phone number in E.164 ("+" and 8–15 digits, no spaces). The server
 * additionally checks it is a valid, diallable number of its country
 * (libphonenumber metadata) and rejects it otherwise (PHONE_NUMBER_INVALID).
 */
export const E164PhoneNumber = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'an E.164 number with its country code, e.g. +493012345678');

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

/**
 * Automatic deletion (Phase B). null = keep until the user deletes it. A daily
 * sweep deletes memories not updated for `memoryDays`, and finished tasks
 * (with their steps, approvals, events, messages and attachments) older than
 * `taskHistoryDays`.
 */
export const RetentionPreferences = z.object({
  memoryDays: z.literal(MEMORY_RETENTION_DAYS).nullable(),
  taskHistoryDays: z.literal(TASK_HISTORY_RETENTION_DAYS).nullable(),
});
export type RetentionPreferences = z.infer<typeof RetentionPreferences>;

/**
 * Skills the user switched off (Phase B). Written only through
 * PATCH /v1/skills/:id; the Policy Engine denies the tools of a disabled skill
 * (SKILL_DISABLED). personal-memory is not listed here: it mirrors
 * `memory.enabled`.
 */
export const SkillPreferences = z.object({
  disabled: z.array(SkillId).max(SkillId.options.length),
});
export type SkillPreferences = z.infer<typeof SkillPreferences>;

/** The model tier that plans tasks (preferences.ai.planningModel). */
export const PlanningModel = z.enum(['balanced', 'deep']);
export type PlanningModel = z.infer<typeof PlanningModel>;

export const Preferences = z.object({
  voice: z.object({
    /** Read final results aloud after a voice request. */
    speakResponses: z.boolean(),
    /** 'auto' follows the interface language. */
    recognitionLocale: z.enum(['auto', 'en-US', 'de-DE', 'ar-SA']),
    // Phase D (docs/architecture/phase-d.md §3.1): defaults apply to stored preferences without them.
    /**
     * Voice mode opens as a continuous conversation (listen → answer aloud → listen again)
     * instead of a single dictated request. Either can be switched in the overlay.
     */
    conversationMode: z.boolean().default(false),
    /** Speech rate multiplier for JARVIS's voice (1 = the platform's normal rate). */
    speakingRate: z
      .number()
      .min(VOICE_LIMITS.speakingRate.min)
      .max(VOICE_LIMITS.speakingRate.max)
      .default(VOICE_LIMITS.speakingRate.default),
    /**
     * How long a pause ends what you are saying (end-of-utterance), in ms: longer for people who
     * pause while speaking (WCAG 2.2.1 Timing Adjustable).
     */
    endOfSpeechSilenceMs: z
      .number()
      .int()
      .min(VOICE_LIMITS.endOfSpeechSilenceMs.min)
      .max(VOICE_LIMITS.endOfSpeechSilenceMs.max)
      .default(VOICE_LIMITS.endOfSpeechSilenceMs.default),
    /**
     * The platform voice to speak with, per language (a Web Speech voiceURI / an
     * AVSpeechSynthesisVoice identifier); null = the platform's default voice for it. A voice the
     * device does not have falls back to the default.
     */
    voiceNames: z
      .object({
        en: z.string().min(1).max(VOICE_LIMITS.maxVoiceNameChars).nullable(),
        de: z.string().min(1).max(VOICE_LIMITS.maxVoiceNameChars).nullable(),
        ar: z.string().min(1).max(VOICE_LIMITS.maxVoiceNameChars).nullable(),
      })
      .default({ en: null, de: null, ar: null }),
  }),
  autonomy: z.object({
    /** MEDIUM-risk emails addressed only to the account's own address run without asking. */
    autoApproveEmailToSelf: z.boolean(),
  }),
  ai: z.object({
    /** When false, requests are never sent to external model providers. */
    allowExternalModels: z.boolean(),
    /**
     * Which model plans tasks: 'balanced' (Claude Sonnet 5.5, effort medium; the default,
     * fast and inexpensive) or 'deep' (Claude Opus 5.5, effort medium; strongest, ~2× cost).
     */
    planningModel: PlanningModel.default('balanced'),
  }),
  notifications: z.object({
    approvalRequested: z.boolean(),
    taskCompleted: z.boolean(),
    taskFailed: z.boolean(),
  }),
  spending: z.object({
    /** Monthly ceiling for AI model costs, in USD. 0 blocks paid model usage. */
    monthlyAiBudgetUsd: z.number().min(0).max(10_000),
    /**
     * Phase C: the most JARVIS may spend on purchases (shop.checkout, paid
     * bookings) per calendar month of the account's time zone, in USD. 0 (the
     * default) turns purchases off (PURCHASES_DISABLED). Orders that are
     * submitting, placed or of unknown outcome count against it. Every purchase
     * still needs an explicit approval of its exact total (PURCHASE).
     */
    monthlyPurchaseLimitUsd: z
      .number()
      .min(0)
      .max(COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax)
      .default(0),
  }),
  memory: z.object({
    /** When false, JARVIS neither reads nor writes long-term memory. */
    enabled: z.boolean(),
  }),
  // Phase B groups default when absent (stored preferences and older fixtures).
  retention: RetentionPreferences.default({ memoryDays: null, taskHistoryDays: null }),
  skills: SkillPreferences.default({ disabled: [] }),
});
export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = {
  voice: {
    speakResponses: false,
    recognitionLocale: 'auto',
    conversationMode: false,
    speakingRate: VOICE_LIMITS.speakingRate.default,
    endOfSpeechSilenceMs: VOICE_LIMITS.endOfSpeechSilenceMs.default,
    voiceNames: { en: null, de: null, ar: null },
  },
  autonomy: { autoApproveEmailToSelf: false },
  ai: { allowExternalModels: true, planningModel: 'balanced' },
  notifications: { approvalRequested: true, taskCompleted: true, taskFailed: true },
  spending: { monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: 0 },
  memory: { enabled: true },
  retention: { memoryDays: null, taskHistoryDays: null },
  skills: { disabled: [] },
};

export const Me = z.object({
  id: Id,
  email: z.email(),
  displayName: z.string(),
  locale: Locale,
  timeZone: z.string(),
  theme: ThemePreference,
  roles: z.array(Role),
  tenant: z.object({ id: Id, name: z.string() }),
  preferences: Preferences,
  createdAt: Timestamp,
  // Phase D. Always sent by this API; optional only for older servers and fixtures.
  /**
   * The account's own phone number (E.164), used only to put a callee through to you when
   * they ask for a person (transfer) and as the default country of numbers written without
   * one. Personal data: exported, deleted with the account. null = none.
   */
  phoneNumber: E164PhoneNumber.nullable().optional(),
  /** When a verification call to that number confirmed it (transfers need it); null = not verified. */
  phoneNumberVerifiedAt: Timestamp.nullable().optional(),
});
export type Me = z.infer<typeof Me>;

export const UpdateMeRequest = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    locale: Locale,
    timeZone: z.string().min(1).max(64),
    theme: ThemePreference,
    /**
     * Phase D: set (E.164) or remove (null) the account's phone number. A different number
     * clears its verification. Invalid numbers: VALIDATION_FAILED, reason PHONE_NUMBER_INVALID.
     */
    phoneNumber: E164PhoneNumber.nullable(),
    preferences: z
      .object({
        // Spelled out without defaults (Phase D fields): a PATCH that omits a field keeps it.
        voice: z
          .object({
            speakResponses: z.boolean(),
            recognitionLocale: z.enum(['auto', 'en-US', 'de-DE', 'ar-SA']),
            conversationMode: z.boolean(),
            speakingRate: z
              .number()
              .min(VOICE_LIMITS.speakingRate.min)
              .max(VOICE_LIMITS.speakingRate.max),
            endOfSpeechSilenceMs: z
              .number()
              .int()
              .min(VOICE_LIMITS.endOfSpeechSilenceMs.min)
              .max(VOICE_LIMITS.endOfSpeechSilenceMs.max),
            /** Per language; an omitted language keeps its stored voice, null resets it. */
            voiceNames: z
              .object({
                en: z.string().min(1).max(VOICE_LIMITS.maxVoiceNameChars).nullable(),
                de: z.string().min(1).max(VOICE_LIMITS.maxVoiceNameChars).nullable(),
                ar: z.string().min(1).max(VOICE_LIMITS.maxVoiceNameChars).nullable(),
              })
              .partial(),
          })
          .partial(),
        autonomy: Preferences.shape.autonomy.partial(),
        // Spelled out without defaults: a PATCH that omits planningModel keeps it.
        ai: z.object({ allowExternalModels: z.boolean(), planningModel: PlanningModel }).partial(),
        notifications: Preferences.shape.notifications.partial(),
        // Spelled out without defaults: a PATCH that omits a field must keep its stored value.
        spending: z
          .object({
            monthlyAiBudgetUsd: z.number().min(0).max(10_000),
            monthlyPurchaseLimitUsd: z
              .number()
              .min(0)
              .max(COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax),
          })
          .partial(),
        memory: Preferences.shape.memory.partial(),
        retention: RetentionPreferences.partial(),
        // `skills` is written through PATCH /v1/skills/:id only.
      })
      .partial(),
  })
  .partial();
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

export const LoginRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  deviceName: z.string().trim().max(80).optional(),
  platform: Platform.default('web'),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  user: Me,
  session: z.object({ id: Id, expiresAt: Timestamp }),
  /** Only returned to native clients (platform !== 'web'); web uses an httpOnly cookie. */
  token: z.string().optional(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const SessionInfo = z.object({
  id: Id,
  deviceName: z.string().nullable(),
  platform: Platform,
  userAgent: z.string().nullable(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
  expiresAt: Timestamp,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const DeleteAccountRequest = z.object({
  password: z.string().min(1).max(256),
  confirmation: z.literal('DELETE'),
});

/* ------------------------------------------------------------------ */
/* Server-written sentences (localised by clients)                     */
/* ------------------------------------------------------------------ */

/**
 * Keys of the sentences the server composes (offline plan and step titles,
 * approval summaries, result lines). Clients render them in the viewer's
 * locale from `{ key, params }`; the server keeps en/de/ar templates of the
 * same keys (apps/api/src/modules/agent/i18n.ts) for its plain-text fallback.
 *
 * Parameters per key:
 *   plan.summarize, plan.summarizeEmail, step.fetch      { host }
 *   plan.remember, plan.emailSelf                         { text }   (the user's own words)
 *   objective.summarize                                   { url }
 *   objective.summarizeEmail                              { url, email }
 *   objective.emailSelf                                   { email }
 *   objective.remember, step.summarize, step.emailSummary, step.remember,
 *   step.emailNote, result.cancelled, result.expired      {}
 *   approval.email, result.emailSent                      { subject, recipients }
 *   approval.generic                                      { title, tool }
 *   approval.recipientsMany                               { count }
 *   result.memorySaved                                    { text }
 *   result.declined                                       { action }
 * Phase B:
 *   plan.emailResult, plan.rememberResult                 { title }  (the earlier task's title)
 *   plan.forwardResult                                    { title, recipients } (earlier task's title)
 *   step.forwardResult                                    { recipients }
 *   plan.summarizeDocument, objective.summarizeDocument,
 *   step.summarizeDocument, result.documentSummarized     { name }   (the file name)
 *   plan.schedule, objective.schedule, approval.schedule,
 *   result.scheduleCreated                                { title }  (the schedule's title)
 *   objective.emailResult                                 { email }
 *   approval.memory                                       { text }
 *   plan.clarify, objective.clarify, objective.rememberResult, step.recall,
 *   step.emailResult, step.schedule, step.clarify, question.*   {}
 * Phase C (docs/architecture/phase-c.md §6):
 *   plan.emailUnread, plan.emailNeedsReply, plan.calendarUpcoming,
 *   objective.emailUnread, objective.emailNeedsReply, objective.calendarUpcoming,
 *   step.searchEmail, step.readThreads, step.summarizeEmail, step.trackReplies,
 *   step.listEvents, step.freeBusy, step.saveToCalendar, step.compareOffers,
 *   question.dateTime, question.contactDetails, question.product, question.site   {}
 *   plan.draftReply, objective.draftReply, step.draftReply      { name }   (as the user wrote it)
 *   plan.findMeetingTime, objective.findMeetingTime            { who }    (as the user wrote it)
 *   step.createEvent, step.updateEvent, step.cancelEvent,
 *   approval.eventCreate, approval.eventUpdate, approval.eventCancel,
 *   result.eventCreated, result.eventUpdated, result.eventCancelled   { title }
 *   approval.eventInvite                                       { title, recipients }
 *   plan.findSlots, objective.findSlots, step.findSlots, step.book, step.readSite,
 *   step.fillForm, step.prepareCart, step.checkout, approval.formSubmission,
 *   approval.cart, result.formSubmitted, result.cartPrepared     { site }   (the site's name)
 *   plan.book, objective.book, approval.booking                 { service, site }
 *   result.booked                                              { service, site, reference }
 *   plan.compareProducts, objective.compareProducts, step.searchShops   { query }
 *   plan.buy, objective.buy                                    { product, site }
 *   approval.emailDraft                                        { subject, recipients }
 *   approval.purchase                                          { total, merchant }
 *   result.orderPlaced                                         { merchant, orderId }
 *   result.draftCreated, result.watchingReplies                { subject }
 * Phase D (docs/architecture/phase-d.md §6):
 *   plan.call, objective.call, step.call, result.callCompleted,
 *   result.callAnswered, result.callTransferred                { who }   (the callee as the user
 *                                                              named them, else the number)
 *   approval.call                                              { who, number }  (number: E.164)
 *   question.phoneNumber, question.callGoal                    {}
 * Money parameters (`total`) are strings "<ISO 4217 code> <amount>" with a "."
 * decimal separator (e.g. "USD 129.99"): unambiguous in every locale; clients
 * may reformat them. Times are never sentence parameters: approvals carry them
 * as data (ApprovalDetails), formatted by clients in the event's time zone.
 * A parameter is a string, a number or a nested message (e.g. `recipients`
 * is a nested approval.recipientsMany for more than two recipients, `title`
 * a nested step title, `action` the declined approval's summary).
 */
export const ServerMessageKey = z.enum([
  'plan.summarize',
  'plan.summarizeEmail',
  'plan.remember',
  'plan.emailSelf',
  'objective.summarize',
  'objective.summarizeEmail',
  'objective.remember',
  'objective.emailSelf',
  'step.fetch',
  'step.summarize',
  'step.emailSummary',
  'step.remember',
  'step.emailNote',
  'approval.email',
  'approval.generic',
  'approval.recipientsMany',
  'result.emailSent',
  'result.memorySaved',
  'result.declined',
  'result.cancelled',
  'result.expired',
  // Phase B: follow-ups, documents, schedules, clarifying questions
  'plan.emailResult',
  'plan.rememberResult',
  'plan.summarizeDocument',
  'plan.schedule',
  'plan.clarify',
  'plan.forwardResult',
  'objective.emailResult',
  'objective.rememberResult',
  'objective.summarizeDocument',
  'objective.schedule',
  'objective.clarify',
  'step.recall',
  'step.emailResult',
  'step.summarizeDocument',
  'step.schedule',
  'step.clarify',
  'step.forwardResult',
  'approval.schedule',
  'approval.memory',
  'result.scheduleCreated',
  'result.documentSummarized',
  'question.emailContent',
  'question.recipient',
  'question.url',
  'question.document',
  'question.scheduleTime',
  'question.targetLanguage',
  'question.previousResult',
  'question.details',
  // Phase C — offline plan titles and objectives
  'plan.emailUnread',
  'plan.emailNeedsReply',
  'plan.draftReply',
  'plan.calendarUpcoming',
  'plan.findMeetingTime',
  'plan.findSlots',
  'plan.book',
  'plan.compareProducts',
  'plan.buy',
  'objective.emailUnread',
  'objective.emailNeedsReply',
  'objective.draftReply',
  'objective.calendarUpcoming',
  'objective.findMeetingTime',
  'objective.findSlots',
  'objective.book',
  'objective.compareProducts',
  'objective.buy',
  // Phase C — offline step titles
  'step.searchEmail',
  'step.readThreads',
  'step.summarizeEmail',
  'step.draftReply',
  'step.trackReplies',
  'step.listEvents',
  'step.freeBusy',
  'step.createEvent',
  'step.updateEvent',
  'step.cancelEvent',
  'step.saveToCalendar',
  'step.findSlots',
  'step.book',
  'step.readSite',
  'step.fillForm',
  'step.searchShops',
  'step.compareOffers',
  'step.prepareCart',
  'step.checkout',
  // Phase C — approval summaries
  'approval.emailDraft',
  'approval.eventCreate',
  'approval.eventInvite',
  'approval.eventUpdate',
  'approval.eventCancel',
  'approval.booking',
  'approval.formSubmission',
  'approval.cart',
  'approval.purchase',
  // Phase C — result lines
  'result.draftCreated',
  'result.watchingReplies',
  'result.eventCreated',
  'result.eventUpdated',
  'result.eventCancelled',
  'result.booked',
  'result.formSubmitted',
  'result.cartPrepared',
  'result.orderPlaced',
  // Phase C — clarifying questions
  'question.dateTime',
  'question.contactDetails',
  'question.product',
  'question.site',
  // Phase D — phone calls
  'plan.call',
  'objective.call',
  'step.call',
  'approval.call',
  'result.callCompleted',
  'result.callAnswered',
  'result.callTransferred',
  'question.phoneNumber',
  'question.callGoal',
]);
export type ServerMessageKey = z.infer<typeof ServerMessageKey>;

export type ServerMessageParam = string | number | ServerMessage;
export interface ServerMessage {
  key: ServerMessageKey;
  params: Record<string, ServerMessageParam>;
}
export const ServerMessage: z.ZodType<ServerMessage> = z.object({
  key: ServerMessageKey,
  get params() {
    return z.record(z.string(), z.union([z.string(), z.number(), ServerMessage]));
  },
});

/* ------------------------------------------------------------------ */
/* Phase B building blocks (attachments, recurrence, questions)        */
/* ------------------------------------------------------------------ */

/**
 * A file the user uploaded (POST /v1/attachments). Only its owner can read or
 * download it (RLS). Uploads are unattached until a request names them in
 * `attachmentIds`; then they belong to that request's conversation (follow-ups
 * in the same conversation may use them again) and are deleted with it, with
 * the task history retention, or by DELETE /v1/attachments/:id.
 */
export const Attachment = z.object({
  id: Id,
  /** As uploaded (sanitised: no path, no control characters). User content: display isolated. */
  filename: z.string(),
  /** Identified from the content, not the extension. */
  mediaType: AttachmentMediaType,
  sizeBytes: z.number().int().positive(),
  /** Hex SHA-256 of the stored bytes. */
  sha256: z.string(),
  /** Null until a request uses the file. */
  conversationId: Id.nullable(),
  /** Known once document.analyze has read it (PDF pages; 1 for other types). */
  pageCount: z.number().int().nonnegative().nullable(),
  /** Characters of extracted text, once read. */
  textChars: z.number().int().nonnegative().nullable(),
  /** API path that streams the file to its owner (same auth as every route). */
  downloadPath: z.string(),
  /** When an unattached upload is deleted; null once attached. */
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Attachment = z.infer<typeof Attachment>;

/** Local wall-clock time "HH:MM" (24 h). */
export const LocalTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (00:00–23:59)');

/**
 * When a schedule runs: an RFC 5545 RRULE subset the server turns into the
 * stored RRULE (Schedule.rrule) and evaluates in `timeZone` (DST-correct).
 *   daily   — every `interval` days at `time`
 *   weekly  — every `interval` weeks on `byWeekday` at `time`
 *   monthly — every `interval` months on `byMonthDay` (1–31, −1 = last day;
 *             a day a month lacks is skipped, as RFC 5545 specifies) at `time`
 * `until` (last local date, inclusive) and `count` (total runs) are optional
 * and exclusive. A local time that does not exist on a DST change day runs
 * at the first valid time after it; one that exists twice runs once.
 */
export const Recurrence = z
  .object({
    frequency: ScheduleFrequency,
    interval: z.number().int().min(1).max(12).default(1),
    byWeekday: z.array(Weekday).min(1).max(7).optional(),
    byMonthDay: z
      .array(
        z
          .number()
          .int()
          .min(-1)
          .max(31)
          .refine((d) => d !== 0, 'day 0 does not exist'),
      )
      .min(1)
      .max(31)
      .optional(),
    time: LocalTime,
    /** IANA zone the server accepts (GET /v1/meta/time-zones). */
    timeZone: z.string().min(1).max(64),
    until: z.iso.date().optional(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (r.frequency === 'weekly' && !r.byWeekday?.length)
      issue('byWeekday', 'weekly schedules need at least one weekday');
    if (r.frequency !== 'weekly' && r.byWeekday !== undefined)
      issue('byWeekday', 'only weekly schedules have weekdays');
    if (r.frequency === 'monthly' && !r.byMonthDay?.length)
      issue('byMonthDay', 'monthly schedules need at least one day of the month');
    if (r.frequency !== 'monthly' && r.byMonthDay !== undefined)
      issue('byMonthDay', 'only monthly schedules have days of the month');
    if (r.byWeekday && new Set(r.byWeekday).size !== r.byWeekday.length)
      issue('byWeekday', 'weekdays must be unique');
    if (r.byMonthDay && new Set(r.byMonthDay).size !== r.byMonthDay.length)
      issue('byMonthDay', 'days must be unique');
    if (r.until !== undefined && r.count !== undefined)
      issue('count', 'until and count cannot both be set');
  });
export type Recurrence = z.infer<typeof Recurrence>;

/**
 * A clarifying question (TaskSummary.question when outcome is 'question').
 * JARVIS asks instead of inventing missing information; the user answers with
 * a follow-up in the same conversation.
 */
export const AssistantQuestion = z.object({
  /** In the request's language (model-written, or the server sentence rendered). */
  text: z.string(),
  /** Set when the server composed the question (offline planner): render it in the viewer's locale. */
  message: ServerMessage.nullable(),
  /** What is missing; clients may offer a matching input (e.g. attach a file for 'document'). */
  missing: z.array(MissingInfo).min(1),
});
export type AssistantQuestion = z.infer<typeof AssistantQuestion>;

/* ------------------------------------------------------------------ */
/* Phase C building blocks (money, evidence files, browser sessions)   */
/* ------------------------------------------------------------------ */

/** ISO 4217 currency code, e.g. USD, EUR. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code, e.g. USD');

/**
 * An amount of money as integer micro-units of its currency (1 USD =
 * 1 000 000), like MicroUsd: no float drift, no table of minor-unit exponents.
 * Every amount JARVIS shows comes from a verifiable source (the merchant's
 * page, with evidence) — never estimated.
 */
export const Money = z.object({
  amountMicro: z.number().int().nonnegative(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

/**
 * A file the browser agent kept as evidence (a screenshot of the live page, the
 * data it extracted, a booking's ICS file). Stored in object storage under the
 * owner's prefix; only its owner can download it (downloadPath).
 */
export const EvidenceArtifact = z.object({
  id: Id,
  kind: EvidenceArtifactKind,
  mediaType: EvidenceMediaType,
  sizeBytes: z.number().int().positive(),
  /** Hex SHA-256 of the stored bytes. */
  sha256: z.string(),
  /** The page it was captured on (null for files the site sent, e.g. an ICS download). */
  pageUrl: z.string().nullable(),
  taskId: Id.nullable(),
  browserSessionId: Id.nullable(),
  /**
   * Phase D: the call a recording belongs to (kind 'recording'); null for browser evidence.
   * Optional: older servers do not send it.
   */
  callSessionId: Id.nullable().optional(),
  /** API path that streams the file to its owner. */
  downloadPath: z.string(),
  createdAt: Timestamp,
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

/**
 * One run of the isolated browser agent: a fresh, ephemeral browser context
 * on one supported site, for one tool execution. Its rows record the
 * lifecycle; `handoverUrl` is set when it stopped at something only the user
 * may do (CAPTCHA, login, bot protection) — JARVIS never works around those.
 */
export const BrowserSession = z.object({
  id: Id,
  taskId: Id,
  stepId: Id,
  /** The supported site's recipe id, e.g. 'fixture-shop'. */
  siteId: z.string(),
  /**
   * The site's display name as its recipe declares it ('Fixture Shop'); null for a recipe this
   * server no longer has. Optional: older servers do not send it.
   */
  siteName: z.string().min(1).max(200).nullable().optional(),
  /** The recipe operation, e.g. 'search', 'slots', 'book', 'checkout'. */
  operation: z.string(),
  status: BrowserSessionStatus,
  stopReason: BrowserStopReason.nullable(),
  /** Where the user can continue themselves (handover only). */
  handoverUrl: z.string().nullable(),
  navigations: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  /** Requests the agent refused (outside the site's allow-list, private addresses, downloads). */
  blockedRequests: z.number().int().nonnegative(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  artifacts: z.array(EvidenceArtifact),
});
export type BrowserSession = z.infer<typeof BrowserSession>;

/* ------------------------------------------------------------------ */
/* Phase D building blocks (phone calls; docs/architecture/phase-d.md) */
/* ------------------------------------------------------------------ */

/**
 * What JARVIS says on a call, in the call's language, fixed when the step is
 * planned (the tool's bind) so the approval — and its action hash — cover the
 * exact words. The opening always says that an AI assistant is calling and on
 * whose behalf, before anything else.
 */
export const CallScript = z.object({
  /** "Hello, this is JARVIS, an AI assistant calling on behalf of <name>. I'm calling to …" */
  opening: z.string().min(1).max(CALL_LIMITS.maxAgentUtteranceChars),
  /** Asked right after the opening when recording is not 'off'; null otherwise. */
  recordingQuestion: z.string().min(1).max(CALL_LIMITS.maxAgentUtteranceChars).nullable(),
  /** The message delivered (purpose 'message'), as spoken; null otherwise. */
  message: z.string().min(1).max(CALL_LIMITS.maxAgentUtteranceChars).nullable(),
  /** The questions as spoken, in order. */
  questions: z
    .array(z.string().min(1).max(CALL_LIMITS.maxAgentUtteranceChars))
    .max(CALL_LIMITS.maxQuestions + 2),
  /** Said before hanging up. */
  closing: z.string().min(1).max(CALL_LIMITS.maxAgentUtteranceChars),
  /** Left on an answering machine (voicemail 'leave_message' only); null otherwise. */
  voicemailMessage: z.string().min(1).max(CALL_LIMITS.maxAgentUtteranceChars).nullable(),
});
export type CallScript = z.infer<typeof CallScript>;

/** A personal detail JARVIS may tell the callee — exactly this label and value, nothing else. */
export const CallShareItem = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(CALL_LIMITS.maxShareValueChars),
});
export type CallShareItem = z.infer<typeof CallShareItem>;

/**
 * Input of the phone.call tool (validated by the plan validator and again on
 * the resolved input). The number must be written in the user's request
 * (NUMBER_NOT_LITERAL otherwise); nothing a callee says can change any field.
 * TaskStep.inputPreview shows it.
 */
export const PhoneCallInput = z.object({
  /** E.164, normalised from the user's own words. */
  to: E164PhoneNumber,
  /** How the user named the callee ("my dentist", "Dr. Weber"); null when they did not. */
  calleeName: z.string().trim().min(1).max(120).nullable().default(null),
  /** The language JARVIS speaks and recognises on the call. */
  language: Locale,
  /** IANA zone of the callee: allowed hours are checked there (bind: the account's zone). */
  calleeTimeZone: z.string().min(1).max(64).nullable().default(null),
  purpose: CallPurpose,
  /** One sentence: what the call should achieve, in the user's words. */
  goal: z.string().trim().min(1).max(CALL_LIMITS.maxGoalChars),
  /** purpose 'message': the message to deliver, in the user's words. */
  message: z.string().trim().min(1).max(CALL_LIMITS.maxMessageChars).nullable().default(null),
  /** purpose 'questions' (and optional extras): asked in order, in the user's words. */
  questions: z
    .array(z.string().trim().min(1).max(CALL_LIMITS.maxQuestionChars))
    .max(CALL_LIMITS.maxQuestions)
    .default([]),
  /** purpose 'availability' / 'appointment': the date asked about (callee's zone). */
  date: z.iso.date().nullable().default(null),
  /** An acceptable time window on that date (HH:MM, callee's zone); null = any time. */
  window: z.object({ start: LocalTime, end: LocalTime }).nullable().default(null),
  /** Personal details JARVIS may share — exactly these; anything else is refused on the call. */
  shareInfo: z.array(CallShareItem).max(CALL_LIMITS.maxShareInfo).default([]),
  maxDurationSeconds: z
    .number()
    .int()
    .min(CALL_LIMITS.minDurationSeconds)
    .max(CALL_LIMITS.maxDurationSeconds)
    .default(300),
  recording: RecordingMode.default('off'),
  voicemail: VoicemailAction.default('hang_up'),
  /** Put the callee through to the account's own verified number when they ask for a person. */
  allowTransfer: z.boolean().default(false),
  /**
   * 'scripted': only the script's lines and fixed clarifications; 'model': JARVIS may also
   * answer within the purpose. Bound at planning ('model' only when a model is available) and
   * approved as part of the input; a call never uses more than was approved.
   */
  dialog: z.enum(['scripted', 'model']).default('scripted'),
  /** Filled at planning (bind); a step whose script is still null does not run. */
  script: CallScript.nullable().default(null),
});
export type PhoneCallInput = z.infer<typeof PhoneCallInput>;

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Machine-readable detail of a TaskError (the `code` says what kind of
 * failure; the reason says which one). Clients localise `code` + `reason` +
 * `params`; `message` is an English developer fallback.
 */
export const TaskErrorReason = z.enum([
  // web.fetch / SSRF guard
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'EMBEDDED_CREDENTIALS',
  'MISSING_HOST',
  'PRIVATE_ADDRESS', // { host }
  'FETCH_TIMEOUT', // { host, seconds }
  'HOST_NOT_FOUND', // { host }
  'CONNECT_FAILED', // { host }
  'TLS_CERTIFICATE', // { host }
  'FETCH_FAILED', // { host }
  'UNSUPPORTED_ENCODING', // { encoding }
  'PAGE_TOO_LARGE', // { limitMb }
  'TOO_MANY_REDIRECTS', // { max }
  'HTTP_ERROR', // { host, status }
  'UNSUPPORTED_CONTENT_TYPE', // { contentType }
  'MISSING_CONTENT_TYPE',
  'NO_READABLE_TEXT',
  // email.send
  'EMAIL_NOT_CONNECTED',
  'SMTP_AUTH',
  'SMTP_REFUSED', // { responseCode }
  'SMTP_CONNECT',
  'SMTP_UNUSABLE',
  'SEND_INTERRUPTED',
  'SEND_TIMEOUT',
  // runtime
  'STEP_INTERRUPTED', // { step }
  'STEP_TIMEOUT', // { step }
  'STEP_CRASHED', // { step }
  'INVALID_STEP_INPUT', // { step }
  'UNKNOWN_TOOL', // { tool }
  'VERIFICATION_FAILED', // { steps }
  // planner
  'OFFLINE_UNSUPPORTED',
  'MEMORY_TOO_LONG', // { max }
  'INVALID_PLAN',
  'NO_TOOLS',
  'PLANNING_FAILED',
  // policy (same names as the policy reason codes)
  'CONNECTION_MISSING', // { step }
  'MEMORY_DISABLED',
  'RISK_CRITICAL',
  'BUDGET_ZERO',
  'BUDGET_EXHAUSTED',
  'EXTERNAL_MODELS_DISABLED',
  'MODEL_UNAVAILABLE',
  'POLICY_DENIED', // { step }
  // Phase B — document.analyze
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_UNREADABLE',
  'ATTACHMENT_ENCRYPTED',
  'DOCUMENT_NO_TEXT',
  'DOCUMENT_TOO_MANY_PAGES', // { max }
  'STORAGE_UNAVAILABLE',
  // text.translate
  'UNSUPPORTED_LANGUAGE', // { language }
  // conversation.recall
  'NOTHING_TO_RECALL',
  // schedule.create
  'SCHEDULE_LIMIT_REACHED', // { max }
  'INVALID_RECURRENCE',
  // policy (same names as the policy reason codes)
  'SKILL_DISABLED', // { skill }
  'UNTRUSTED_MEMORY',
  // Phase C — OAuth connections (code CONNECTION_REQUIRED unless noted; offer "Reconnect")
  'CONNECTION_EXPIRED', // { provider }   also the policy reason (deny)
  'CONNECTION_SCOPE_MISSING', // { provider, capability }   also the policy reason (deny)
  'PROVIDER_RATE_LIMITED', // { provider, seconds }   TOOL_FAILED, retryable
  'PROVIDER_UNAVAILABLE', // { provider }   TOOL_FAILED, retryable (5xx, timeouts)
  'PROVIDER_REJECTED', // { provider, status }   TOOL_FAILED (other 4xx)
  // Phase C — email
  'EMAIL_THREAD_NOT_FOUND',
  'WATCH_LIMIT_REACHED', // { max }
  // Phase C — calendars
  'CALENDAR_CONFLICT', // { count }   the time is already busy; nothing was written
  'EVENT_NOT_FOUND',
  'EVENT_CHANGED', // the event changed since JARVIS read it; nothing was written
  'NO_FREE_SLOTS',
  'INVALID_TIME_RANGE',
  // Phase C — browser agent (same names as BrowserStopReason)
  'CAPTCHA_DETECTED', // { host }   handover: the user continues on the site
  'LOGIN_REQUIRED', // { host }   handover
  'BOT_PROTECTION', // { host }   handover
  'SITE_UNSUPPORTED', // { host }
  'NAVIGATION_BLOCKED', // { host }   left the site's allow-list or a private address
  'PAGE_CHANGED', // { host }   the recipe no longer matches the page
  'SITE_ERROR', // { host, status }
  'BROWSER_BUDGET_EXCEEDED', // { limit }
  'BROWSER_TIMEOUT', // { seconds }
  'BROWSER_CRASHED',
  'BROWSER_UNAVAILABLE',
  // Phase C — booking
  'SLOT_TAKEN', // the slot is no longer available; nothing was booked { alternatives: count of live free slots offered again }
  'BOOKING_DETAILS_MISSING', // { fields }
  'BOOKING_UNCONFIRMED', // OUTCOME_UNKNOWN: submitted, but the site showed no confirmation
  // Phase C — shopping
  'PRICE_CHANGED', // { expected, actual }   money strings; nothing was ordered
  'OUT_OF_STOCK',
  'CHECKOUT_UNSUPPORTED', // { host }   the site's recipe hands over a prepared cart instead
  'ORDER_UNKNOWN', // OUTCOME_UNKNOWN: the checkout was interrupted after submission started
  // Phase C — policy (same names as the policy reason codes; POLICY_DENIED)
  'PURCHASES_DISABLED',
  'PURCHASE_LIMIT', // { limit, spent, amount }   money strings
  'PURCHASE_CURRENCY', // { currency }
  // Phase D — phone calls (docs/architecture/phase-d.md §3.2). The call ended without reaching
  // anyone / its goal; nothing was agreed. TOOL_FAILED, retryable: a retry places a NEW call
  // (this one definitely ended), checked by the policy again.
  'CALL_BUSY',
  'CALL_NO_ANSWER',
  'CALL_FAILED', // { status? }   the provider could not connect it
  'CALL_VOICEMAIL', // a machine answered (no message left unless approved)
  'CALL_HUNG_UP', // the callee hung up before the goal was reached
  'CALL_DECLINED', // the callee did not want to talk to an AI assistant (not retryable)
  'CALL_DURATION_LIMIT', // { seconds }   ended at the approved maximum duration
  'RECORDING_CONSENT_DECLINED', // recording 'required' and the callee said no: ended politely
  'CALL_STATE_UNKNOWN', // OUTCOME_UNKNOWN: the provider did not confirm whether the call was placed
  'PHONE_NUMBER_INVALID', // { number }   not a valid, diallable number
  'NUMBER_NOT_LITERAL', // PLANNER_UNSUPPORTED: the number is not written in the user's request
  // Phase D — policy (same names as the policy reason codes; POLICY_DENIED)
  'DO_NOT_CALL', // { number }   masked; the number asked not to be called again
  'CALL_OUTSIDE_HOURS', // { start, end, timeZone }   HH:MM in the callee's zone
  'CALL_LIMIT', // { max }   calls per day
  'CALL_DESTINATION_BLOCKED', // { country }   premium-rate / shared-cost / not an allowed country
  'TELEPHONY_NOT_CONFIGURED',
]);
export type TaskErrorReason = z.infer<typeof TaskErrorReason>;

export const TaskError = z.object({
  code: ErrorCode,
  /** English developer fallback. Clients show copy for code / reason / params instead. */
  message: z.string(),
  /** Whether a retry is safe without risking a duplicate side effect. */
  retryable: z.boolean(),
  reason: TaskErrorReason.optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type TaskError = z.infer<typeof TaskError>;

/**
 * What a piece of evidence records, with its facts as parameters, so clients
 * can label it in the viewer's locale. `label` / `value` stay as the
 * protocol-level, English fallback.
 *   HTTP_RESPONSE      { method, url, status, contentType, bytes }
 *   CONTENT_HASH       { algorithm, hash }
 *   SMTP_RECEIPT       { replyCode, accepted, total, response, messageId }
 *   MODEL_OUTPUT       { model, inputTokens, outputTokens }
 *   EXTRACTIVE_SUMMARY { sentences, chars, excludedSentences }
 *   MEMORY_RECORD      { memoryId, kind }
 *   ANSWER_TRUNCATED   {}
 * Phase B:
 *   DOCUMENT_EXTRACTED { attachmentId, mediaType, pages, chars, truncated (0|1) }
 *   SCHEDULE_RECORD    { scheduleId, nextRunAt }
 *   RECALLED_RESULT    { taskId }
 *   QUESTION_ASKED     { missing }  (comma-separated MissingInfo values)
 * Phase C (kind provider_response unless noted):
 *   PROVIDER_RESPONSE  { provider, operation, status }      a Gmail / Graph / Calendar API call
 *   MAIL_SEARCH        { provider, threads }                threads found (no content)
 *   MAIL_SENT          { provider, messageId, threadId }    the provider's id of the sent message
 *   MAIL_DRAFT         { provider, draftId, threadId }
 *   EMAIL_WATCH        { watchId, expiresAt }               (kind record)
 *   CALENDAR_EVENT     { provider, eventId, action }        action: create | update | cancel
 *   FREE_BUSY          { provider, calendars, slots }
 *   SCREENSHOT         { artifactId, url, sha256 }          (kind browser_capture)
 *   PAGE_EXTRACT       { artifactId, url, items }           (kind browser_capture)
 *   ICS_FILE           { artifactId, sha256 }               (kind browser_capture)
 *   BOOKING_CONFIRMATION { bookingId, reference }           (kind record)
 *   ORDER_CONFIRMATION { orderId, merchantOrderId, total }  (kind record; total a money string)
 *   CART_SNAPSHOT      { artifactId, total }                (kind browser_capture)
 *   HANDOVER           { host, reason, url }                (kind note) the user continues there
 * Phase D (calls; docs/architecture/phase-d.md §3.2):
 *   CALL_PLACED        { provider, callSid }                (kind provider_response) the provider accepted it
 *   CALL_ENDED         { callSid, result, seconds }         (kind provider_response) final status
 *   AI_DISCLOSED       { callSid, sequence }                (kind record) the opening turn that said so
 *   RECORDING_CONSENT  { callSid, consent, sequence }       (kind record) the callee's answer, as a turn
 *   CALL_TRANSCRIPT    { callId, turns }                    (kind record) the turns kept as task data
 *   CALL_RECORDING     { artifactId, seconds, sha256 }      (kind record) only with consent
 *   CALL_TRANSFER      { callSid, status }                  (kind provider_response)
 *   DO_NOT_CALL_RECORDED { number }                         (kind record) masked
 */
export const EvidenceCode = z.enum([
  'HTTP_RESPONSE',
  'CONTENT_HASH',
  'SMTP_RECEIPT',
  'MODEL_OUTPUT',
  'EXTRACTIVE_SUMMARY',
  'MEMORY_RECORD',
  'ANSWER_TRUNCATED',
  'DOCUMENT_EXTRACTED',
  'SCHEDULE_RECORD',
  'RECALLED_RESULT',
  'QUESTION_ASKED',
  // Phase C
  'PROVIDER_RESPONSE',
  'MAIL_SEARCH',
  'MAIL_SENT',
  'MAIL_DRAFT',
  'EMAIL_WATCH',
  'CALENDAR_EVENT',
  'FREE_BUSY',
  'SCREENSHOT',
  'PAGE_EXTRACT',
  'ICS_FILE',
  'BOOKING_CONFIRMATION',
  'ORDER_CONFIRMATION',
  'CART_SNAPSHOT',
  'HANDOVER',
  // Phase D
  'CALL_PLACED',
  'CALL_ENDED',
  'AI_DISCLOSED',
  'RECORDING_CONSENT',
  'CALL_TRANSCRIPT',
  'CALL_RECORDING',
  'CALL_TRANSFER',
  'DO_NOT_CALL_RECORDED',
]);
export type EvidenceCode = z.infer<typeof EvidenceCode>;

export const Evidence = z.object({
  kind: z.enum([
    'http_response',
    'smtp_receipt',
    'record',
    'content_hash',
    'model_output',
    'note',
    // Phase C
    'provider_response',
    'browser_capture',
  ]),
  label: z.string(),
  value: z.string(),
  at: Timestamp,
  /** Absent on evidence recorded before codes existed. */
  code: EvidenceCode.optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * One verification result, as carried in `verification.passed` /
 * `verification.failed` event data (`checks`). Clients localise `key` +
 * `params`; `text` is the English fallback and `step` the step's title.
 *   http { status, url } · textExtracted { count } · hashRecorded · hashMissing
 *   injectionFlagged · summaryLength { count } · extractive · writtenBy { model }
 *   recipientsAccepted { accepted, count } · noneRejected · rejected { list }
 *   serverResponse { response } · messageId { id } · answerLength { count }
 *   memoryStored { id } · memoryMissing
 * Phase B: documentRead { pages, chars } · translationLength { count }
 *   translationLanguage { language } · numbersPreserved { count } · scheduleStored { id }
 *   nextRunComputed { at } · resultRecalled { taskId } · questionAsked
 * Phase C: providerAccepted { provider, id } · threadsRead { count } · draftCreated { id }
 *   watchCreated { id } · eventWritten { id } · noConflict · slotsFound { count }
 *   liveSource { url } · screenshotStored { artifactId } · confirmationReceived { reference }
 *   totalMatches { total } · orderPlaced { orderId } · offersCompared { count }
 *   withinLimit { remaining }
 * Phase D: callConnected { callSid } · aiDisclosed · callEnded { result } · goalReached
 *   detailsCollected { count } · consentRespected { consent } · transcriptStored { turns }
 */
export const VerificationCheckKey = z.enum([
  'http',
  'textExtracted',
  'hashRecorded',
  'hashMissing',
  'injectionFlagged',
  'summaryLength',
  'extractive',
  'writtenBy',
  'recipientsAccepted',
  'noneRejected',
  'rejected',
  'serverResponse',
  'messageId',
  'answerLength',
  'memoryStored',
  'memoryMissing',
  'documentRead',
  'translationLength',
  'translationLanguage',
  'numbersPreserved',
  'scheduleStored',
  'nextRunComputed',
  'resultRecalled',
  'questionAsked',
  // Phase C
  'providerAccepted',
  'threadsRead',
  'draftCreated',
  'watchCreated',
  'eventWritten',
  'noConflict',
  'slotsFound',
  'liveSource',
  'screenshotStored',
  'confirmationReceived',
  'totalMatches',
  'orderPlaced',
  'offersCompared',
  'withinLimit',
  // Phase D
  'callConnected',
  'aiDisclosed',
  'callEnded',
  'goalReached',
  'detailsCollected',
  'consentRespected',
  'transcriptStored',
]);
export type VerificationCheckKey = z.infer<typeof VerificationCheckKey>;

export const VerificationCheck = z.object({
  stepId: Id,
  /** The step's title as stored (see TaskStep.titleMessage for its localisable form). */
  step: z.string(),
  key: VerificationCheckKey,
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  text: z.string(),
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const PolicyDecision = z.object({
  decision: z.enum(['allow', 'require_approval', 'deny']),
  /** Machine-readable reason codes, e.g. RISK_MEDIUM, RECIPIENT_EXTERNAL, CONNECTION_MISSING. */
  reasons: z.array(z.string()),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const TaskStep = z.object({
  id: Id,
  position: z.number().int().nonnegative(),
  title: z.string(),
  /** Set when the server wrote the title (offline planner): render it in the viewer's locale. */
  titleMessage: ServerMessage.nullable().optional(),
  toolId: ToolId,
  riskLevel: RiskLevel,
  status: StepStatus,
  requiresApproval: z.boolean(),
  policy: PolicyDecision,
  /** Redacted, display-safe view of the resolved input. */
  inputPreview: z.record(z.string(), z.unknown()),
  /** Redacted, display-safe output. */
  output: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(Evidence),
  attempts: z.number().int().nonnegative(),
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  error: TaskError.nullable(),
});
export type TaskStep = z.infer<typeof TaskStep>;

/**
 * Facts about content flagged as a suspected prompt injection that this
 * action consumes (attached when the policy adds UNTRUSTED_CONTENT). Never
 * contains the flagged text itself.
 */
export const UntrustedSource = z.object({
  /** Host of the page the content came from, when it came from web.fetch. */
  host: z.string().nullable(),
  /** Sentences left out of the extractive summary because they addressed AI assistants; null when not applicable. */
  excludedSentences: z.number().int().nonnegative().nullable(),
  /** Detector signal ids, e.g. ignore_previous_instructions, exfiltration_request. */
  signals: z.array(z.string()),
});
export type UntrustedSource = z.infer<typeof UntrustedSource>;

export const ApprovalDetails = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    from: z.string(),
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    untrusted: UntrustedSource.optional(),
    // Phase C (absent on older approvals: a send through SMTP)
    /** 'draft': email.draft_reply creates a draft in the mailbox; nothing is sent. */
    mode: z.enum(['send', 'draft']).optional(),
    /** How it is sent: the SMTP connection, or the Google / Microsoft account itself. */
    via: z.enum(['smtp', 'google', 'microsoft']).optional(),
    cc: z.array(z.string()).optional(),
    /** A reply in this thread (its subject as the provider reports it: untrusted text). */
    inReplyTo: z.object({ threadId: z.string(), subject: z.string() }).nullable().optional(),
  }),
  z.object({
    kind: z.literal('generic'),
    toolId: ToolId,
    fields: z.array(z.object({ label: z.string(), value: z.string() })),
    untrusted: UntrustedSource.optional(),
  }),
  /** schedule.create: future runs, each planned and checked by the policy when it happens. */
  z.object({
    kind: z.literal('schedule'),
    title: z.string(),
    /** The request each run will carry out, exactly as stored. */
    request: z.string(),
    recurrence: Recurrence,
    rrule: z.string(),
    /** The first runs (SCHEDULE_LIMITS.upcomingShown), as instants: format in recurrence.timeZone. */
    nextOccurrences: z.array(Timestamp),
    untrusted: UntrustedSource.optional(),
  }),
  /** memory.save of text that came from an earlier result (MEMORY_FROM_CONTENT): exactly what is kept. */
  z.object({
    kind: z.literal('memory'),
    content: z.string(),
    memoryKind: MemoryKind,
    /** The task whose result the text came from. */
    sourceTaskId: Id.nullable(),
    untrusted: UntrustedSource.optional(),
  }),
  /**
   * Phase C — calendar.create_event / update_event / cancel_event: exactly
   * what is written to which calendar, and who is told. Clients format the
   * instants in `timeZone`.
   */
  z.object({
    kind: z.literal('calendar_event'),
    action: z.enum(['create', 'update', 'cancel']),
    provider: OAuthProvider,
    /** The calendar's account (its address). */
    account: z.string(),
    /** The provider's event id (update, cancel); null when creating. */
    eventId: z.string().nullable(),
    title: z.string(),
    start: Timestamp,
    end: Timestamp,
    /** IANA zone the event is stored in and shown in. */
    timeZone: z.string(),
    allDay: z.boolean(),
    location: z.string().nullable(),
    description: z.string().nullable(),
    /** Everyone who receives the invitation, update or cancellation — exactly these addresses. */
    attendees: z.array(z.string()),
    /** The provider emails the attendees (sendUpdates). */
    notifyAttendees: z.boolean(),
    /** update / cancel: the event as JARVIS read it (what the change replaces); null when creating. */
    previous: z.object({ title: z.string(), start: Timestamp, end: Timestamp }).nullable(),
    /** JARVIS re-checks free/busy right before writing and stops if the time is taken. */
    conflictCheck: z.boolean(),
    untrusted: UntrustedSource.optional(),
  }),
  /**
   * Phase C — booking.book on a supported site: the slot as the site offered
   * it live (evidence), and exactly the personal details the form receives.
   */
  z.object({
    kind: z.literal('booking'),
    siteId: z.string(),
    siteName: z.string(),
    siteHost: z.string(),
    service: z.string(),
    start: Timestamp,
    end: Timestamp.nullable(),
    timeZone: z.string(),
    /** Every field the form will submit, with its exact value. */
    fields: z.array(z.object({ label: z.string(), value: z.string(), personal: z.boolean() })),
    /** Price as the site states it; null when the site states none. */
    price: Money.nullable(),
    /** The site says it is binding (cancellation fees or payment due). */
    binding: z.boolean(),
    /** The site's cancellation terms as shown (untrusted text: display isolated); null if none. */
    cancellationTerms: z.string().nullable(),
    /** Screenshot of the live availability this booking relies on. */
    evidenceArtifactId: Id.nullable(),
    untrusted: UntrustedSource.optional(),
  }),
  /**
   * Phase C — shop.checkout: the exact order (items, quantities, total,
   * merchant, delivery) and the monthly limit it is checked against. Never
   * auto-approved; the order is submitted exactly once.
   */
  z.object({
    kind: z.literal('purchase'),
    siteId: z.string(),
    merchant: z.object({ name: z.string(), host: z.string() }),
    items: z.array(
      z.object({
        title: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: Money,
        lineTotal: Money,
        productUrl: z.string(),
      }),
    ),
    subtotal: Money,
    shipping: Money,
    tax: Money.nullable(),
    total: Money,
    delivery: z.object({
      method: z.string(),
      /** As the merchant states it (e.g. "2–4 business days"); null when it states none. */
      estimate: z.string().nullable(),
      address: z.string(),
    }),
    /** As the merchant's checkout shows it (e.g. "Visa •••• 4242"). */
    paymentMethod: z.string(),
    /** preferences.spending.monthlyPurchaseLimitUsd and this month's committed purchases (USD). */
    limit: z.object({ monthly: Money, spentThisMonth: Money, remainingAfter: Money }),
    /** Screenshot of the cart / checkout page as checked before asking. */
    evidenceArtifactId: Id.nullable(),
    untrusted: UntrustedSource.optional(),
  }),
  /** Phase C — browser.fill on a supported site: exactly what the form receives. */
  z.object({
    kind: z.literal('form_submission'),
    siteId: z.string(),
    siteName: z.string(),
    siteHost: z.string(),
    /** The recipe's form, e.g. 'contact', 'reservation'. */
    form: z.string(),
    fields: z.array(z.object({ label: z.string(), value: z.string(), personal: z.boolean() })),
    binding: z.boolean(),
    evidenceArtifactId: Id.nullable(),
    untrusted: UntrustedSource.optional(),
  }),
  /**
   * Phase D — phone.call: who is called, from which number, in which language,
   * for what, exactly what JARVIS will say and ask, which personal details it may
   * share, for how long, when, and whether it records. Approved by a tap / click
   * only — never by voice.
   */
  z.object({
    kind: z.literal('phone_call'),
    /** E.164, exactly as dialled. */
    to: z.string(),
    /** The same number in international format for reading ("+49 30 1234567"). */
    toDisplay: z.string(),
    /** ISO 3166-1 alpha-2 of the number; null when unknown. */
    country: z.string().nullable(),
    calleeName: z.string().nullable(),
    /** The name JARVIS says it calls for (the account's display name). */
    onBehalfOf: z.string(),
    /** The number the callee sees (this server's caller id); null when not configured. */
    callerId: z.string().nullable(),
    /** The caller id in international format for reading; optional only for older servers. */
    callerIdDisplay: z.string().nullable().optional(),
    language: Locale,
    purpose: CallPurpose,
    goal: z.string(),
    /** Exactly what JARVIS will say and ask, in the call's language. */
    script: CallScript,
    /**
     * 'scripted': only the lines above plus fixed clarifications (offline); 'model': JARVIS may
     * also answer the callee's questions within the purpose and the details below — it never
     * agrees to anything else and never shares anything else.
     */
    dialog: z.enum(['scripted', 'model']),
    date: z.iso.date().nullable(),
    window: z.object({ start: LocalTime, end: LocalTime }).nullable(),
    shareInfo: z.array(CallShareItem),
    maxDurationSeconds: z.number().int().positive(),
    /** The call is placed only inside these hours of the callee's zone. */
    allowedHours: z.object({ start: LocalTime, end: LocalTime, timeZone: z.string() }),
    recording: RecordingMode,
    voicemail: VoicemailAction,
    /** Putting the callee through to the account's own verified number (masked), if allowed. */
    transfer: z.object({ allowed: z.boolean(), to: z.string().nullable() }),
    /** The call may create a binding commitment (purpose 'appointment'). */
    binding: z.boolean(),
    /** Upper bound of the provider's price (CALL_PRICE_PER_MINUTE_USD × max minutes); null = unknown. */
    costEstimate: Money.nullable(),
    untrusted: UntrustedSource.optional(),
  }),
]);
export type ApprovalDetails = z.infer<typeof ApprovalDetails>;

export const Approval = z.object({
  id: Id,
  taskId: Id,
  taskTitle: z.string(),
  taskTitleMessage: ServerMessage.nullable().optional(),
  stepId: Id,
  toolId: ToolId,
  status: ApprovalStatus,
  riskLevel: RiskLevel,
  /** Exactly what will happen, in one sentence (request language; see summaryMessage). */
  summary: z.string(),
  /** `summary` as a message key + params, to render in the viewer's locale. */
  summaryMessage: ServerMessage.nullable().optional(),
  details: ApprovalDetails,
  /** Hash binding the approval to the exact action shown; required when deciding. */
  actionHash: z.string(),
  reasons: z.array(z.string()),
  expiresAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: Timestamp,
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalDecisionRequest = z.object({
  decision: z.enum(['approve', 'reject']),
  actionHash: z.string().min(16).max(128),
  note: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const PlannerInfo = z.object({
  /** 'model' = an external LLM planned the task; 'offline' = deterministic rules engine. */
  mode: z.enum(['model', 'offline']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
});
export type PlannerInfo = z.infer<typeof PlannerInfo>;

export const TaskSummary = z.object({
  id: Id,
  /** In the request's language (or the request itself until planned); see titleMessage. */
  title: z.string(),
  /** Set when the server wrote the title (offline planner): render it in the viewer's locale. */
  titleMessage: ServerMessage.nullable().optional(),
  request: z.string(),
  status: TaskStatus,
  riskLevel: RiskLevel,
  source: TaskSource,
  /** `completed` counts succeeded steps only. */
  progress: z.object({ completed: z.number().int(), total: z.number().int() }),
  pendingApprovalId: Id.nullable(),
  /** The pending approval, with whether it acts on content flagged as a prompt injection. */
  pendingApproval: z.object({ id: Id, untrustedSource: z.boolean() }).nullable().optional(),
  /** In the request's language; see resultSummaryMessage. */
  resultSummary: z.string().nullable(),
  /**
   * Set when the result line is a server sentence (not page or model text):
   * render it in the viewer's locale instead of `resultSummary`.
   */
  resultSummaryMessage: ServerMessage.nullable().optional(),
  error: TaskError.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  // Phase B. Always sent by this API; optional only for older servers and fixtures.
  conversationId: Id.optional(),
  /** What the completed task produced; null until COMPLETED. */
  outcome: TaskOutcome.nullable().optional(),
  /** Set when outcome is 'question' (also shown as resultSummary / resultSummaryMessage). */
  question: AssistantQuestion.nullable().optional(),
  /** The schedule that created this task (source 'schedule'). */
  scheduleId: Id.nullable().optional(),
  /** Files attached to the request. */
  attachmentCount: z.number().int().nonnegative().optional(),
  /**
   * Phase D. The request's language as the planner detected it (null until planned, or when it
   * is none of the supported locales): voice mode reads the answer aloud in this language.
   * Always sent by this API; optional only for older servers and fixtures.
   */
  language: Locale.nullable().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskEventType = z.enum([
  'task.created',
  'task.status_changed',
  'plan.ready',
  'step.started',
  'step.succeeded',
  'step.failed',
  'step.blocked',
  'approval.requested',
  'approval.decided',
  'verification.passed',
  'verification.failed',
  'task.answer.delta',
  'task.cancel_requested',
  'task.retried',
]);
export type TaskEventType = z.infer<typeof TaskEventType>;

export const TaskEvent = z.object({
  /** Monotonic id; doubles as the SSE `id:` for resumable streams. */
  id: z.string(),
  taskId: Id,
  type: TaskEventType,
  at: Timestamp,
  data: z.record(z.string(), z.unknown()),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/* ------------------------------------------------------------------ */
/* Phase D — phone calls (docs/architecture/phase-d.md §3.2)           */
/* ------------------------------------------------------------------ */

/**
 * One utterance of a call. JARVIS's lines are verbatim; the callee's are the
 * provider's speech recognition — untrusted text (display isolated, never
 * followed, never a source of numbers, recipients, amounts or memories).
 */
export const CallTurn = z.object({
  id: Id,
  /** 0, 1, 2 … in the order spoken. */
  sequence: z.number().int().nonnegative(),
  speaker: CallSpeaker,
  kind: CallTurnKind,
  text: z.string().max(CALL_LIMITS.maxCalleeUtteranceChars),
  language: Locale,
  /** Recognition confidence 0–1 (callee turns); null otherwise. */
  confidence: z.number().min(0).max(1).nullable(),
  /** The callee's words contained instructions to AI assistants (ignored). */
  flagged: z.boolean(),
  at: Timestamp,
});
export type CallTurn = z.infer<typeof CallTurn>;

/** One status change of a call as the provider reported it (or JARVIS decided). */
export const CallStatusEvent = z.object({
  status: CallStatus,
  /** The provider's status word, e.g. 'ringing', 'in-progress', 'no-answer'; null for JARVIS's own. */
  providerStatus: z.string().max(40).nullable(),
  /** The provider's SequenceNumber of the callback; null for JARVIS's own entries. */
  sequence: z.number().int().nonnegative().nullable(),
  at: Timestamp,
});
export type CallStatusEvent = z.infer<typeof CallStatusEvent>;

/**
 * What a call collected — only what the callee said explicitly, extracted by
 * rules (offline) or by the model as structured output; the turns are the
 * evidence. Strings are the callee's words (untrusted).
 */
export const CallCollectedDetails = z.object({
  /** The date discussed (availability, appointment), in the callee's zone. */
  date: z.iso.date().nullable(),
  /** Times the callee offered on that date (HH:MM, callee's zone). */
  times: z.array(LocalTime).max(CALL_LIMITS.maxCollectedTimes),
  /** purpose 'appointment': what the callee confirmed; null when nothing was agreed. */
  appointment: z
    .object({
      date: z.iso.date(),
      time: LocalTime,
      name: z.string().max(200).nullable(),
      reference: z.string().max(200).nullable(),
    })
    .nullable(),
  /** purpose 'message': the callee's reply. */
  reply: z.string().max(CALL_LIMITS.maxCalleeUtteranceChars).nullable(),
  /** purpose 'questions': each question with the answer heard (null: not answered). */
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string().max(CALL_LIMITS.maxCalleeUtteranceChars).nullable(),
    }),
  ),
});
export type CallCollectedDetails = z.infer<typeof CallCollectedDetails>;

/** The structured result of an ended call. */
export const CallOutcome = z.object({
  result: CallResult,
  /** The approved goal was reached (only with evidence in the turns). */
  goalReached: z.boolean(),
  details: CallCollectedDetails,
  notes: z.array(CallNoteCode),
  /** The result line (server sentence), rendered by clients in the viewer's locale. */
  summaryMessage: ServerMessage.nullable(),
});
export type CallOutcome = z.infer<typeof CallOutcome>;

/** One call attempt of a phone.call step (a retry after busy / no answer is a new attempt). */
export const CallSession = z.object({
  id: Id,
  taskId: Id,
  stepId: Id,
  /** 1, 2 … per step: a retry of a definitely ended call places attempt n + 1. */
  attempt: z.number().int().positive(),
  /** E.164 as dialled (the user's own input). */
  to: z.string(),
  toDisplay: z.string(),
  calleeName: z.string().nullable(),
  language: Locale,
  purpose: CallPurpose,
  status: CallStatus,
  /** Set when ended. */
  result: CallResult.nullable(),
  outcome: CallOutcome.nullable(),
  provider: z.literal('twilio'),
  /** The provider's call id (evidence); null until the provider accepted the call. */
  providerCallSid: z.string().nullable(),
  answeredBy: AnsweredBy.nullable(),
  /** When the opening (AI disclosure) was spoken; null if the call never got that far. */
  aiDisclosedAt: Timestamp.nullable(),
  recording: z.object({
    mode: RecordingMode,
    consent: RecordingConsent,
    consentAt: Timestamp.nullable(),
    /** The stored recording (kind 'recording'); null unless recorded with consent. */
    artifactId: Id.nullable(),
  }),
  transfer: z.object({
    status: z.enum(['none', 'requested', 'connected', 'failed', 'unavailable']),
    at: Timestamp.nullable(),
  }),
  /** Oldest first. */
  timeline: z.array(CallStatusEvent),
  durationSeconds: z.number().int().nonnegative().nullable(),
  maxDurationSeconds: z.number().int().positive(),
  costEstimate: Money.nullable(),
  /** The provider's price of the call once it reports one. */
  price: Money.nullable(),
  /** Why the attempt did not reach its goal (CALL_BUSY …); null otherwise. */
  failureReason: TaskErrorReason.nullable(),
  /** Oldest first (in a TaskDetail at most CALL_LIMITS.turnsInTaskDetail; GET /v1/calls/:id has all). */
  turns: z.array(CallTurn),
  dialedAt: Timestamp.nullable(),
  answeredAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CallSession = z.infer<typeof CallSession>;

/**
 * A call in lists (GET /v1/calls): without its turns and status timeline, with its task's title
 * (so a list needs no second query). Always sent by this API; optional only for older servers.
 */
export const CallSummary = CallSession.omit({ turns: true, timeline: true }).extend({
  /** The task's title, in the request's language; see taskTitleMessage. */
  taskTitle: z.string().optional(),
  /** Set when the server wrote the title (offline planner): render it in the viewer's locale. */
  taskTitleMessage: ServerMessage.nullable().optional(),
});
export type CallSummary = z.infer<typeof CallSummary>;

export const CallListQuery = PageQuery.extend({ result: CallResult.optional() });
export type CallListQuery = z.infer<typeof CallListQuery>;

/**
 * A number JARVIS will not call for this account (GET /v1/do-not-call). Only a
 * keyed hash of the number is stored, with this masked form for display.
 */
export const DoNotCallEntry = z.object({
  id: Id,
  /** Masked, e.g. "+49 30 ••• •• 67". */
  number: z.string(),
  country: z.string().nullable(),
  source: DoNotCallSource,
  /** The call during which the callee asked (callee_request). */
  callId: Id.nullable(),
  /**
   * The task of that call (null once the task was deleted — the entry outlives it). Always sent
   * by this API; optional only for older servers.
   */
  taskId: Id.nullable().optional(),
  createdAt: Timestamp,
});
export type DoNotCallEntry = z.infer<typeof DoNotCallEntry>;

/** A verification call that reads a code to the account's own number. */
export const PhoneVerification = z.object({
  id: Id,
  status: PhoneVerificationStatus,
  /** The number being verified, masked. */
  number: z.string(),
  attemptsLeft: z.number().int().nonnegative(),
  expiresAt: Timestamp,
  createdAt: Timestamp,
});
export type PhoneVerification = z.infer<typeof PhoneVerification>;

/**
 * GET /v1/me/phone/verification: the account's latest verification while it can still be
 * confirmed or shows why it ended (calling, pending, failed — until its expiry), else null — so a
 * client that left the screen (or reloaded) can show the code field again.
 */
export const PhoneVerificationState = z.object({ verification: PhoneVerification.nullable() });
export type PhoneVerificationState = z.infer<typeof PhoneVerificationState>;

export const ConfirmPhoneVerificationRequest = z.object({
  code: z
    .string()
    .trim()
    .regex(
      new RegExp(`^\\d{${CALL_LIMITS.verificationCodeLength}}$`),
      'the digits JARVIS read out',
    ),
});
export type ConfirmPhoneVerificationRequest = z.infer<typeof ConfirmPhoneVerificationRequest>;

export const TaskDetail = TaskSummary.extend({
  objective: z.string().nullable(),
  objectiveMessage: ServerMessage.nullable().optional(),
  conversationId: Id,
  planner: PlannerInfo.nullable(),
  answer: z.string().nullable(),
  steps: z.array(TaskStep),
  approvals: z.array(Approval),
  events: z.array(TaskEvent),
  cost: z.object({ estimatedMicroUsd: MicroUsd, actualMicroUsd: MicroUsd }),
  evidence: z.array(Evidence),
  canCancel: z.boolean(),
  canRetry: z.boolean(),
  startedAt: Timestamp.nullable(),
  /** Files attached to the request (Phase B; always sent by this API). */
  attachments: z.array(Attachment).optional(),
  /** Phase C: the browser agent's sessions for this task, oldest first (always sent by this API). */
  browserSessions: z.array(BrowserSession).optional(),
  /** Phase D: the task's phone calls, oldest first (always sent by this API). */
  calls: z.array(CallSession).optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const CreateTaskRequest = z.object({
  request: z.string().trim().min(1).max(4000),
  source: TaskSource.extract(['text', 'voice']).default('text'),
  /** BCP-47-ish language of the request, if known (voice recognition supplies it). */
  language: Locale.optional(),
  voiceSessionId: Id.optional(),
  /**
   * Uploaded files the request is about (Phase B): the caller's own uploads,
   * unattached and unexpired (a follow-up may also name files already in its
   * conversation). Unique, at most ATTACHMENT_LIMITS.maxPerRequest. Absent = none.
   */
  attachmentIds: z
    .array(Id)
    .max(ATTACHMENT_LIMITS.maxPerRequest)
    .refine((ids) => new Set(ids).size === ids.length, 'attachment ids must be unique')
    .optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const TaskListQuery = PageQuery.extend({
  status: z.enum(['active', 'needs_approval', 'completed', 'failed', 'all']).default('all'),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

export const RetryTaskRequest = z.object({
  /** Required when the previous attempt ended with OUTCOME_UNKNOWN. */
  acknowledgeUnknownOutcome: z.boolean().default(false),
});

/* ------------------------------------------------------------------ */
/* Realtime stream (SSE: GET /v1/events)                               */
/* ------------------------------------------------------------------ */

/**
 * Stream events that are not part of a task's timeline (task_events rows with
 * these types are never listed in TaskDetail.events). Phase B data shapes:
 *   conversation.message     { conversationId, messageId, taskId, role, kind }
 *   conversation.changed     { conversationId, change: 'title' | 'deleted' }
 *   schedule.changed         { scheduleId, change: 'created' | 'updated' | 'paused' | 'resumed'
 *                              | 'completed' | 'deleted' | 'run', status, nextRunAt }
 *                            (status and nextRunAt are null for 'deleted')
 *   webhook.delivery_failed  { endpointId, deliveryId, eventType, reason, attempts, final }
 *   webhook.endpoint_changed { endpointId, change: 'created' | 'updated' | 'secret_rotated'
 *                              | 'deleted' | 'disabled', status, disabledReason }
 *                            (status and disabledReason are null for 'deleted')
 * Phase C:
 *   connection.changed       { connectionId, provider, status, statusReason?, change? }
 *                            change: 'created' | 'reconnected' | 'capabilities' | 'expired'
 *                            | 'error' | 'deleted' (absent on events of older servers)
 *   email_watch.changed      { watchId, status, change: 'created' | 'replied' | 'stopped'
 *                              | 'expired' | 'failed' }
 *   browser_session.changed  { sessionId, taskId, stepId, status, stopReason }
 *   order.changed            { orderId, taskId, status }
 *   booking.changed          { bookingId, taskId, status }
 * Phase D:
 *   call.status_changed      { callId, taskId, stepId, status, result }   (result null until ended)
 *   call.turn                { callId, taskId, sequence, speaker }        a new utterance (live captions:
 *                                                                          refetch the call or task)
 *   phone_verification.changed { verificationId, status }
 * Ids, enums and times only: clients refetch what they show.
 */
export const AccountEventType = z.enum([
  'notification.created',
  'connection.changed',
  'heartbeat',
  'conversation.message',
  'conversation.changed',
  'schedule.changed',
  'webhook.delivery_failed',
  'webhook.endpoint_changed',
  // Phase C
  'email_watch.changed',
  'browser_session.changed',
  'order.changed',
  'booking.changed',
  // Phase D
  'call.status_changed',
  'call.turn',
  'phone_verification.changed',
]);
export type AccountEventType = z.infer<typeof AccountEventType>;

export const StreamEvent = z.object({
  id: z.string(),
  type: z.union([TaskEventType, AccountEventType]),
  taskId: Id.nullable(),
  at: Timestamp,
  data: z.record(z.string(), z.unknown()),
});
export type StreamEvent = z.infer<typeof StreamEvent>;

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export const Connection = z.object({
  id: Id,
  provider: ConnectionProvider,
  label: z.string(),
  /** e.g. the sender address for SMTP, the account's address for Google / Microsoft; never a secret. */
  accountIdentifier: z.string().nullable(),
  status: ConnectionStatus,
  permissions: z.array(z.string()),
  lastVerifiedAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  // Phase C. Always sent by this API; optional only for older servers and fixtures.
  /** OAuth connections: what JARVIS may do with it (every scope granted); [] for SMTP and web. */
  capabilities: z.array(ConnectionCapability).optional(),
  /** OAuth connections: the provider scopes actually granted (transparency); [] otherwise. */
  scopes: z.array(z.string()).optional(),
  /** Why it is not active (null while active). 'expired' connections are fixed by reconnecting. */
  statusReason: ConnectionStatusReason.nullable().optional(),
});
export type Connection = z.infer<typeof Connection>;

export const CreateSmtpConnectionRequest = z.object({
  label: z.string().trim().min(1).max(60).default('Email'),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** 'tls' = implicit TLS (465); 'starttls' = upgrade (587); 'none' only allowed for localhost in development. */
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().max(254).optional(),
  password: z.string().max(512).optional(),
  fromAddress: z.email(),
  fromName: z.string().trim().max(80).optional(),
});
export type CreateSmtpConnectionRequest = z.infer<typeof CreateSmtpConnectionRequest>;

/* ------------------------------------------------------------------ */
/* Phase C — OAuth connections (docs/architecture/phase-c.md §3.1)     */
/* ------------------------------------------------------------------ */

/** What a connection provider is on this server (GET /v1/connections/providers). */
export const ConnectionProviderInfo = z.object({
  provider: ConnectionProvider,
  kind: z.enum(['oauth', 'smtp', 'web']),
  /** OAuth: the server has a client id and secret for it. false = "not configured on this server". */
  configured: z.boolean(),
  /** OAuth: each capability with the exact provider scopes it requests (OAUTH_SCOPES); [] otherwise. */
  capabilities: z.array(
    z.object({ capability: ConnectionCapability, scopes: z.array(z.string()) }),
  ),
  /** OAuth: scopes requested with every capability (account identity, refresh token). */
  identityScopes: z.array(z.string()),
  /**
   * OAuth: what disconnecting does at the provider. 'provider': the grant is
   * revoked there (Google); 'local_only': the provider has no per-app revocation
   * endpoint, so JARVIS erases its tokens and the user may also remove the app
   * in their account settings (Microsoft). null for SMTP and web.
   */
  revocation: z.enum(['provider', 'local_only']).nullable(),
});
export type ConnectionProviderInfo = z.infer<typeof ConnectionProviderInfo>;

/** A path of the client app to return to after the provider's consent screen. */
const ReturnTo = z
  .string()
  .max(OAUTH_LIMITS.maxReturnToChars)
  .regex(/^\/(?![/\\])[^\s\\]*$/, 'a path of this app, e.g. /connections (no scheme or host)');

/**
 * Starts an authorization (code + PKCE S256). The server stores the state
 * (bound to this session, single use, OAUTH_LIMITS.stateTtlMinutes) and the
 * PKCE verifier, and returns the provider URL to open. `connectionId` adds
 * capabilities to, or reconnects, an existing connection of the same provider
 * (incremental authorization); the provider account must stay the same.
 */
export const OAuthStartRequest = z.object({
  provider: OAuthProvider,
  capabilities: z
    .array(ConnectionCapability)
    .min(1)
    .max(ConnectionCapability.options.length)
    .refine((c) => new Set(c).size === c.length, 'capabilities must be unique'),
  /** Exactly one of the server's allowed redirect URIs (OAUTH_REDIRECT_URIS). */
  redirectUri: z.url({ protocol: /^https?$/ }).max(2048),
  connectionId: Id.optional(),
  returnTo: ReturnTo.optional(),
});
export type OAuthStartRequest = z.infer<typeof OAuthStartRequest>;

export const OAuthStartResponse = z.object({
  /** Open in the browser (web: same tab; iOS: ASWebAuthenticationSession). */
  authorizationUrl: z.string(),
  /** The authorization must be completed before this. */
  expiresAt: Timestamp,
});
export type OAuthStartResponse = z.infer<typeof OAuthStartResponse>;

/**
 * The provider's redirect, forwarded by the client page at the redirect URI
 * (its query parameters, verbatim). Exactly one of `code` and `error`.
 */
export const OAuthCallbackRequest = z
  .object({
    state: z.string().min(16).max(512),
    code: z.string().min(1).max(4096).optional(),
    /** e.g. access_denied when the user declined. */
    error: z.string().max(200).optional(),
    errorDescription: z.string().max(2000).optional(),
    /** RFC 9207 issuer, when the provider sends one (checked against the provider's issuer). */
    iss: z.string().max(2048).optional(),
  })
  .refine((r) => (r.code === undefined) !== (r.error === undefined), {
    message: 'exactly one of code and error',
    path: ['code'],
  });
export type OAuthCallbackRequest = z.infer<typeof OAuthCallbackRequest>;

export const OAuthCallbackResult = z.object({
  connection: Connection,
  /** The OAuthStartRequest.returnTo of this authorization, if any. */
  returnTo: z.string().nullable(),
  /**
   * Recent tasks that failed because this connection had expired
   * (CONNECTION_EXPIRED) and can be retried now — newest first, at most
   * OAUTH_LIMITS.resumableTasksMax from the last resumableWithinDays days.
   */
  resumableTaskIds: z.array(Id),
});
export type OAuthCallbackResult = z.infer<typeof OAuthCallbackResult>;

/* ------------------------------------------------------------------ */
/* Phase C — calendars (live from the provider; nothing is cached)     */
/* ------------------------------------------------------------------ */

export const CalendarAttendee = z.object({
  email: z.string(),
  name: z.string().nullable(),
  response: AttendeeResponse.nullable(),
  organizer: z.boolean(),
  /** The account itself. */
  self: z.boolean(),
});
export type CalendarAttendee = z.infer<typeof CalendarAttendee>;

/**
 * An event as the provider reports it. Titles, locations and descriptions of
 * invitations are written by other people: untrusted text (display isolated,
 * never followed as instructions).
 */
export const CalendarEvent = z.object({
  /** The provider's event id. */
  id: z.string(),
  provider: OAuthProvider,
  connectionId: Id,
  title: z.string(),
  start: Timestamp,
  end: Timestamp,
  /** The event's own zone; null for all-day events and when the provider gives none. */
  timeZone: z.string().nullable(),
  allDay: z.boolean(),
  location: z.string().nullable(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  organizer: z.string().nullable(),
  attendees: z.array(CalendarAttendee),
  /** Opens the event at the provider. */
  webLink: z.string().nullable(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

/** Home "Upcoming": an event's metadata only. */
export const CalendarEventSummary = CalendarEvent.pick({
  id: true,
  provider: true,
  connectionId: true,
  title: true,
  start: true,
  end: true,
  timeZone: true,
  allDay: true,
  location: true,
  status: true,
  webLink: true,
}).extend({ attendeeCount: z.number().int().nonnegative() });
export type CalendarEventSummary = z.infer<typeof CalendarEventSummary>;

/** One calendar connection that was asked, and what it answered. */
export const CalendarSource = z.object({
  connectionId: Id,
  provider: OAuthProvider,
  accountIdentifier: z.string().nullable(),
  /** expired: reconnect; scope_missing: calendar.read not granted; unavailable: no answer in time / error. */
  status: z.enum(['ok', 'expired', 'scope_missing', 'unavailable']),
});
export type CalendarSource = z.infer<typeof CalendarSource>;

/**
 * The next events of every connected calendar (CALENDAR_LIMITS.upcomingDays,
 * at most upcomingMax), merged by start. HomeSnapshot.upcoming is null when no
 * connection grants calendar.read — the section is then not shown at all.
 */
export const UpcomingEvents = z.object({
  events: z.array(CalendarEventSummary),
  sources: z.array(CalendarSource),
  rangeStart: Timestamp,
  rangeEnd: Timestamp,
  fetchedAt: Timestamp,
});
export type UpcomingEvents = z.infer<typeof UpcomingEvents>;

export const CalendarEventListQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  /** At most CALENDAR_LIMITS.listMaxDays after `from`. */
  to: z.iso.datetime({ offset: true }),
  provider: OAuthProvider.optional(),
});
export type CalendarEventListQuery = z.infer<typeof CalendarEventListQuery>;

export const CalendarEventList = z.object({
  items: z.array(CalendarEvent),
  sources: z.array(CalendarSource),
  /** More than CALENDAR_LIMITS.listMaxEvents events: narrow the window. */
  truncated: z.boolean(),
});
export type CalendarEventList = z.infer<typeof CalendarEventList>;

export const BusyInterval = z.object({ start: Timestamp, end: Timestamp });

/** calendar.free_busy output (`result`): busy times per calendar and proposed free slots. */
export const FreeBusyResult = z.object({
  timeMin: Timestamp,
  timeMax: Timestamp,
  timeZone: z.string(),
  durationMinutes: z.number().int().positive(),
  calendars: z.array(
    z.object({
      email: z.string(),
      /** false: the provider does not share this person's free/busy with the account. */
      accessible: z.boolean(),
      busy: z.array(BusyInterval),
    }),
  ),
  /**
   * Times free in every accessible calendar, within working hours, at most
   * CALENDAR_LIMITS.maxProposedSlots. Computed from the providers' answers
   * only; inaccessible calendars are not assumed free.
   */
  slots: z.array(BusyInterval),
});
export type FreeBusyResult = z.infer<typeof FreeBusyResult>;

/* ------------------------------------------------------------------ */
/* Phase C — email agent                                               */
/* ------------------------------------------------------------------ */

export const EmailAddress = z.object({ name: z.string().nullable(), address: z.string() });
export type EmailAddress = z.infer<typeof EmailAddress>;

/** A message's metadata (no body). Subjects and snippets are untrusted text. */
export const EmailMessageSummary = z.object({
  id: z.string(),
  threadId: z.string(),
  from: EmailAddress,
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
  date: Timestamp,
  subject: z.string(),
  /** At most EMAIL_LIMITS.snippetChars. */
  snippet: z.string(),
  unread: z.boolean(),
  hasAttachments: z.boolean(),
});
export type EmailMessageSummary = z.infer<typeof EmailMessageSummary>;

/** email.search output (`threads`): one thread's metadata. */
export const EmailThreadSummary = z.object({
  id: z.string(),
  provider: OAuthProvider,
  connectionId: Id,
  subject: z.string(),
  participants: z.array(EmailAddress),
  lastMessageFrom: EmailAddress,
  lastMessageAt: Timestamp,
  snippet: z.string().max(EMAIL_LIMITS.snippetChars),
  messageCount: z.number().int().positive(),
  unread: z.boolean(),
  /**
   * Deterministic, from headers only: the newest message is from someone else,
   * in the inbox, and not automated (no List-Unsubscribe / List-Id, no
   * Auto-Submitted, Precedence bulk/list, or no-reply sender).
   */
  needsReply: z.boolean(),
  webLink: z.string().nullable(),
});
export type EmailThreadSummary = z.infer<typeof EmailThreadSummary>;

/** A thread JARVIS watches for replies (GET /v1/email/watches). */
export const EmailWatch = z.object({
  id: Id,
  provider: OAuthProvider,
  connectionId: Id,
  threadId: z.string(),
  /** As the provider reports it (untrusted text). */
  subject: z.string(),
  status: EmailWatchStatus,
  /** The task whose email.track_replies step created it. */
  taskId: Id.nullable(),
  lastCheckedAt: Timestamp.nullable(),
  /** Null unless watching. */
  nextCheckAt: Timestamp.nullable(),
  replyAt: Timestamp.nullable(),
  replyFrom: EmailAddress.nullable(),
  expiresAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type EmailWatch = z.infer<typeof EmailWatch>;

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export const Memory = z.object({
  id: Id,
  kind: MemoryKind,
  content: z.string(),
  source: z.enum(['user', 'assistant']),
  sourceTaskId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Memory = z.infer<typeof Memory>;

export const CreateMemoryRequest = z.object({
  kind: MemoryKind.default('fact'),
  content: z.string().trim().min(1).max(1000),
});
export const UpdateMemoryRequest = z.object({
  kind: MemoryKind.optional(),
  content: z.string().trim().min(1).max(1000).optional(),
});
export const MemoryListQuery = PageQuery.extend({ q: z.string().trim().max(200).optional() });

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export const Notification = z.object({
  id: Id,
  kind: NotificationKind,
  taskId: Id.nullable(),
  /** Parameters for client-side localisation (e.g. taskTitle). */
  data: z.record(z.string(), z.string()),
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

/* ------------------------------------------------------------------ */
/* System status, home, usage                                          */
/* ------------------------------------------------------------------ */

export const AssistantStatus = z.object({
  planner: z.object({
    mode: z.enum(['model', 'offline']),
    provider: z.string().nullable(),
    /** Why the assistant is offline, e.g. NO_API_KEY or USER_DISABLED_EXTERNAL_MODELS. */
    reason: z.string().nullable(),
  }),
  worker: z.object({ healthy: z.boolean(), lastHeartbeatAt: Timestamp.nullable() }),
  capabilities: z.object({
    webFetch: z.boolean(),
    email: z.boolean(),
    memory: z.boolean(),
    generalQuestions: z.boolean(),
    // Phase B. Always sent by this API; optional only for older servers and fixtures.
    /** File uploads work (storage configured and the document-analysis skill enabled). */
    attachments: z.boolean().optional(),
    /** Translation can run now (needs a model). */
    translation: z.boolean().optional(),
    /**
     * JARVIS may propose schedules from requests (schedule.create; the task-scheduling skill is
     * enabled). Creating, editing and pausing schedules yourself (the schedules routes) is a
     * direct action and always available; existing schedules keep running until paused.
     */
    schedules: z.boolean().optional(),
    // Phase C. Always sent by this API; optional only for older servers and fixtures.
    // Each is true only when the tools are built on this server, the skill is on and
    // what it needs is connected / running (the same availability GET /v1/skills reports).
    /** Reading, drafting and tracking mail through a Google / Microsoft account. */
    mail: z.boolean().optional(),
    /** Reading and changing a connected calendar. */
    calendar: z.boolean().optional(),
    /** The isolated browser agent is running (and storage for its evidence is configured). */
    browser: z.boolean().optional(),
    /** Finding and booking appointments on supported sites. */
    booking: z.boolean().optional(),
    /** Comparing products on supported shops. */
    shopping: z.boolean().optional(),
    /** Purchases are possible at all: shopping available and a monthly purchase limit above 0. */
    purchases: z.boolean().optional(),
    // Phase D. Always sent by this API; optional only for older servers and fixtures.
    /** Phone calls can be placed: phone.call built, telephony configured, the skill on. */
    phoneCalls: z.boolean().optional(),
  }),
  /**
   * Natural voice: POST /v1/voice/speech can read JARVIS's replies aloud with a neural voice
   * (a speech provider is configured and the user allows external models). Clients fall back
   * to the device's system voice when false or absent.
   */
  voice: z.object({ natural: z.boolean() }).optional(),
  version: z.string(),
});
export type AssistantStatus = z.infer<typeof AssistantStatus>;

/** Speech limits: one request reads one sentence group aloud. */
export const SPEECH_LIMITS = { maxTextChars: 1_500 } as const;

/** POST /v1/voice/speech: text to read aloud in the given language (answers audio/mpeg). */
export const SpeechRequest = z.object({
  text: z.string().trim().min(1).max(SPEECH_LIMITS.maxTextChars),
  language: Locale,
});
export type SpeechRequest = z.infer<typeof SpeechRequest>;

export const Suggestion = z.object({
  id: z.string(),
  kind: z.enum(['command', 'connect', 'review']),
  /** i18n key; clients own the copy. */
  messageKey: z.string(),
  /** For 'command': text placed in the command bar (user still submits it). */
  command: z.string().nullable(),
  /** For 'connect' / 'review': in-app route. */
  href: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const HomeSnapshot = z.object({
  assistant: AssistantStatus,
  pendingApprovals: z.array(Approval),
  activeTasks: z.array(TaskSummary),
  recentTasks: z.array(TaskSummary),
  unreadNotifications: z.number().int(),
  suggestions: z.array(Suggestion),
  /**
   * Phase C: the next events of the connected calendars; null (or absent, from
   * older servers) when no connection grants calendar.read — then the Home
   * "Upcoming" section is not shown at all.
   */
  upcoming: UpcomingEvents.nullable().optional(),
});
export type HomeSnapshot = z.infer<typeof HomeSnapshot>;

export const UsageSummary = z.object({
  periodStart: Timestamp,
  periodEnd: Timestamp,
  aiMicroUsd: MicroUsd,
  toolMicroUsd: MicroUsd,
  totalMicroUsd: MicroUsd,
  budgetMicroUsd: MicroUsd,
  tasks: z.object({
    completed: z.number().int(),
    failed: z.number().int(),
    total: z.number().int(),
  }),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

export const VoiceSessionStart = z.object({
  locale: z.string().max(16),
  engine: z.enum(['browser_speech', 'ios_speech', 'android_speech']),
  /** Phase D: a continuous conversation (several requests) or one dictated request (default). */
  mode: VoiceSessionMode.default('dictation'),
  /** Phase D: the conversation it continues (follow-ups), if any. */
  conversationId: Id.optional(),
});
/**
 * Metadata only — never audio, never transcript text (the requests arrive as
 * tasks). Phase D adds the conversation counters.
 */
export const VoiceSessionEnd = z.object({
  /** 'ended': a conversation the user ended (End, Esc, "stop") after at least one request. */
  outcome: z.enum(['submitted', 'cancelled', 'error', 'no_speech', 'ended']),
  /** Characters of the dictated request(s) sent. */
  transcriptChars: z.number().int().min(0).max(100_000),
  errorCode: z.string().max(64).optional(),
  /** Phase D: requests sent in this session. */
  turns: z.number().int().min(0).max(500).optional(),
  /** Phase D: times the user spoke while JARVIS was speaking (barge-in). */
  bargeIns: z.number().int().min(0).max(10_000).optional(),
  /** Phase D: stream or recognition reconnects. */
  reconnects: z.number().int().min(0).max(1_000).optional(),
  endReason: VoiceEndReason.optional(),
});
export const VoiceSession = z.object({
  id: Id,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  /** Phase D (optional: older servers). */
  mode: VoiceSessionMode.optional(),
  conversationId: Id.nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Admin (aggregates only — never user content)                        */
/* ------------------------------------------------------------------ */

export const AdminOverview = z.object({
  generatedAt: Timestamp,
  health: z.object({
    database: z.boolean(),
    worker: z.object({ healthy: z.boolean(), lastHeartbeatAt: Timestamp.nullable() }),
    planner: AssistantStatus.shape.planner,
    /** Queued jobs that are due now; same as queueReady (kept for older clients). */
    queueDepth: z.number().int(),
    // The three below are always sent by this API; optional only for older fixtures.
    /** Queued jobs that are due now (the backlog the worker has to work through). */
    queueReady: z.number().int().optional(),
    /** Queued jobs that are due later (e.g. approval expiry timers): not backlog. */
    queueScheduled: z.number().int().optional(),
    /** How long the oldest due job has waited, or null when nothing is due. */
    oldestReadyAgeMs: z.number().int().nullable().optional(),
  }),
  users: z.object({ total: z.number().int(), active7d: z.number().int() }),
  tenants: z.object({ total: z.number().int() }),
  tasksByStatus: z.record(z.string(), z.number().int()),
  toolReliability: z.array(
    z.object({
      toolId: z.string(),
      executions: z.number().int(),
      succeeded: z.number().int(),
      failed: z.number().int(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
    }),
  ),
  cost30dMicroUsd: MicroUsd,
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const AdminUser = z.object({
  id: Id,
  email: z.string(),
  tenantName: z.string(),
  roles: z.array(Role),
  status: z.enum(['active', 'disabled', 'deleted']),
  createdAt: Timestamp,
  lastActiveAt: Timestamp.nullable(),
  taskCount: z.number().int(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AuditEvent = z.object({
  id: z.string(),
  at: Timestamp,
  tenantId: Id.nullable(),
  actorType: z.enum(['user', 'system', 'agent', 'admin']),
  actorId: Id.nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/* ------------------------------------------------------------------ */
/* Conversations (Phase B)                                             */
/* ------------------------------------------------------------------ */

/**
 * A message of a conversation: the user's request of a task, or what JARVIS
 * said when the task completed (its answer, clarifying question or result
 * line). At most one assistant message per task.
 */
export const ConversationMessage = z.object({
  id: Id,
  role: z.enum(['user', 'assistant']),
  kind: MessageKind,
  /** User text, model text, or the server sentence rendered in the request language. */
  text: z.string(),
  /** Set when the server composed the text: render it in the viewer's locale. */
  textMessage: ServerMessage.nullable(),
  language: Locale.nullable(),
  taskId: Id.nullable(),
  /** Files attached to a request (user messages); [] otherwise. */
  attachments: z.array(Attachment),
  createdAt: Timestamp,
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

/**
 * One entry of a conversation thread. Per task, in this order: the user's
 * request, the task (live status, approvals, result), and — once it completed —
 * JARVIS's message. Tasks appear in the order they were created.
 */
export const ConversationTurn = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), message: ConversationMessage }),
  z.object({ type: z.literal('task'), task: TaskSummary }),
  z.object({ type: z.literal('assistant_message'), message: ConversationMessage }),
]);
export type ConversationTurn = z.infer<typeof ConversationTurn>;

export const ConversationSummary = z.object({
  id: Id,
  /** In the first request's language; see titleMessage. */
  title: z.string(),
  titleMessage: ServerMessage.nullable(),
  /** Tasks in the conversation. */
  taskCount: z.number().int().nonnegative(),
  /** The newest task. */
  lastTask: TaskSummary.nullable(),
  /** A task of the conversation is QUEUED, PLANNING, AWAITING_APPROVAL, RUNNING or VERIFYING. */
  hasActiveTask: z.boolean(),
  /** Set for the conversation that collects a schedule's runs. */
  scheduleId: Id.nullable(),
  createdAt: Timestamp,
  /** Last activity (a new task, message or title). */
  updatedAt: Timestamp,
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationDetail = ConversationSummary.extend({
  /** The newest `limit` tasks' turns, oldest first. */
  turns: z.array(ConversationTurn),
  /** Pass as `before` to load the turns of earlier tasks; null when there are none. */
  earlierCursor: z.string().nullable(),
  /** A follow-up can be sent now: every task of the conversation has finished. */
  canFollowUp: z.boolean(),
  /** The task that has to finish (or be cancelled / decided) before a follow-up; null when none. */
  activeTaskId: Id.nullable(),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const ConversationListQuery = PageQuery.extend({
  /** Matches titles and requests (word match or literal substring). */
  q: z.string().trim().max(200).optional(),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

export const ConversationDetailQuery = z.object({
  before: z.string().max(200).optional(),
  /** Tasks (with their messages) per page. */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ConversationDetailQuery = z.infer<typeof ConversationDetailQuery>;

/**
 * A follow-up in an existing conversation: creates a NEW task in it. The
 * planner sees the conversation's earlier requests and results as context
 * (bounded, results marked as untrusted data). Answering a clarifying
 * question is a follow-up.
 */
export const FollowUpRequest = CreateTaskRequest.extend({});
export type FollowUpRequest = z.infer<typeof FollowUpRequest>;

/* ------------------------------------------------------------------ */
/* Skills (Phase B)                                                    */
/* ------------------------------------------------------------------ */

/**
 * A skill of the backend registry with its real availability for the
 * signed-in user. Names and descriptions are client copy keyed by `id`.
 * Skills never grant permissions: the Policy Engine decides every step.
 */
export const Skill = z.object({
  id: SkillId,
  /** Semver of the skill definition in the registry. */
  version: z.string(),
  status: SkillStatus,
  /** The user's switch (personal-memory mirrors preferences.memory.enabled). */
  enabled: z.boolean(),
  /** Whether the user may switch it (false for planned and core skills such as workflow-planning). */
  canToggle: z.boolean(),
  /** It can run for this user now. */
  available: z.boolean(),
  unavailableReason: SkillUnavailableReason.nullable(),
  /** Implemented tools the skill owns (disabling the skill denies them). */
  tools: z.array(ToolId),
  /** Tool ids that are planned, not built. */
  plannedTools: z.array(z.string()),
  /** Declarative scopes, e.g. web:read, email:send. Informational: never grants anything. */
  permissions: z.array(z.string()),
  /** Highest risk any of its tools can have. */
  maxRisk: RiskLevel,
  requiredConnections: z.array(ConnectionProvider),
  /**
   * Phase C: the skill also works with any ONE of these (a provider, optionally
   * with a capability it must grant), e.g. email-management: SMTP, or Google /
   * Microsoft with mail access. Empty: only requiredConnections apply.
   */
  connectionOptions: z
    .array(z.object({ provider: ConnectionProvider, capability: ConnectionCapability.optional() }))
    .optional(),
  modelUse: z.enum(['none', 'optional', 'required']),
  /** Projected model cost per run above which the policy asks first (SKILL_COST_LIMIT); null = budget rules only. */
  maxCostPerRunMicroUsd: MicroUsd.nullable(),
  /** Repository path of the skill specification. */
  docsPath: z.string(),
});
export type Skill = z.infer<typeof Skill>;

export const UpdateSkillRequest = z.object({ enabled: z.boolean() });
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequest>;

/* ------------------------------------------------------------------ */
/* Schedules (Phase B)                                                 */
/* ------------------------------------------------------------------ */

/**
 * A request JARVIS runs on a recurrence. Every run is a normal task (source
 * 'schedule') in the schedule's conversation, planned and checked by the
 * policy when it runs; a schedule never pre-approves anything.
 */
export const Schedule = z.object({
  id: Id,
  title: z.string(),
  /** What each run asks JARVIS to do (user text). */
  request: z.string(),
  language: Locale.nullable(),
  /** Normalised (defaults applied). */
  recurrence: Recurrence,
  /** The RFC 5545 rule the server derived (DTSTART;TZID=…, RRULE:…); informational. */
  rrule: z.string(),
  status: ScheduleStatus,
  pausedReason: SchedulePauseReason.nullable(),
  /** Next occurrence; null when paused or completed. */
  nextRunAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  lastTaskId: Id.nullable(),
  /** The conversation that collects the runs (created with the first run). */
  conversationId: Id.nullable(),
  runCount: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** 'agent': created by schedule.create from a request the user approved. */
  createdBy: z.enum(['user', 'agent']),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleRun = z.object({
  id: Id,
  /** The occurrence this run is for (each occurrence runs at most once). */
  occurrenceAt: Timestamp,
  status: ScheduleRunStatus,
  reason: ScheduleRunReason.nullable(),
  /** The task created for it (null when skipped/failed, or deleted by retention). */
  task: TaskSummary.nullable(),
  createdAt: Timestamp,
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const ScheduleDetail = Schedule.extend({
  /** The next occurrences (SCHEDULE_LIMITS.upcomingShown); [] when paused or completed. */
  upcoming: z.array(Timestamp),
  /** Newest first (SCHEDULE_LIMITS.runsShown). */
  runs: z.array(ScheduleRun),
});
export type ScheduleDetail = z.infer<typeof ScheduleDetail>;

export const CreateScheduleRequest = z.object({
  title: z.string().trim().min(1).max(120),
  request: z.string().trim().min(1).max(4000),
  recurrence: Recurrence,
  /** Language of the request; detected when absent. */
  language: Locale.optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const UpdateScheduleRequest = z
  .object({
    title: z.string().trim().min(1).max(120),
    request: z.string().trim().min(1).max(4000),
    recurrence: Recurrence,
  })
  .partial();
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequest>;

export const SchedulePreviewRequest = z.object({
  recurrence: Recurrence,
  count: z.number().int().min(1).max(SCHEDULE_LIMITS.maxPreview).default(5),
});
export type SchedulePreviewRequest = z.infer<typeof SchedulePreviewRequest>;

export const SchedulePreview = z.object({
  rrule: z.string(),
  /** Instants of the next occurrences from now (fewer when until/count end the series). */
  occurrences: z.array(Timestamp),
  /** The zone as the server stores it (canonical spelling). */
  timeZone: z.string(),
});
export type SchedulePreview = z.infer<typeof SchedulePreview>;

/* ------------------------------------------------------------------ */
/* Webhooks (Phase B) — outbound, Standard Webhooks                    */
/* ------------------------------------------------------------------ */

export const WebhookEndpoint = z.object({
  id: Id,
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(WebhookEventType),
  status: WebhookEndpointStatus,
  disabledReason: WebhookDisabledReason.nullable(),
  /** Identifies the secret without revealing it, e.g. "whsec_…x7Qa". */
  secretHint: z.string(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastDeliveryAt: Timestamp.nullable(),
  lastSuccessAt: Timestamp.nullable(),
  lastFailureAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

/** Returned once, on create and on rotate: the secret is never shown again. */
export const WebhookEndpointWithSecret = z.object({
  endpoint: WebhookEndpoint,
  /** whsec_ + base64 key; sign/verify with Standard Webhooks (HMAC-SHA256, v1). */
  secret: z.string(),
});
export type WebhookEndpointWithSecret = z.infer<typeof WebhookEndpointWithSecret>;

export const CreateWebhookRequest = z.object({
  /** https:// (http only for hosts a development server allow-lists). Public addresses only. */
  url: z.url({ protocol: /^https?$/ }).max(2048),
  description: z.string().trim().max(200).optional(),
  eventTypes: z
    .array(WebhookEventType)
    .min(1)
    .max(WebhookEventType.options.length)
    .refine((t) => new Set(t).size === t.length, 'event types must be unique'),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const UpdateWebhookRequest = z
  .object({
    url: CreateWebhookRequest.shape.url,
    description: z.string().trim().max(200).nullable(),
    eventTypes: CreateWebhookRequest.shape.eventTypes,
    /** false disables (reason 'user'); true re-enables and resets the failure count. */
    enabled: z.boolean(),
  })
  .partial();
export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequest>;

export const WebhookDelivery = z.object({
  id: Id,
  endpointId: Id,
  eventType: WebhookDeliveryEventType,
  /** The webhook-id header value (msg_…), identical on every attempt. */
  webhookId: z.string(),
  status: WebhookDeliveryStatus,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: Timestamp.nullable(),
  lastAttemptAt: Timestamp.nullable(),
  /** HTTP status of the last attempt, when there was a response. */
  responseStatus: z.number().int().nullable(),
  failureReason: WebhookFailureReason.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/** `data` of task.* events. Ids, enums and times only — never titles, requests or results. */
export const WebhookTaskData = z.object({
  taskId: Id,
  conversationId: Id,
  scheduleId: Id.nullable(),
  status: TaskStatus,
  outcome: TaskOutcome.nullable(),
  riskLevel: RiskLevel,
  source: TaskSource,
  toolIds: z.array(ToolId),
  error: z
    .object({ code: ErrorCode, reason: z.string().nullable(), retryable: z.boolean() })
    .nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});

/** `data` of approval.* events (no summary or details: they contain message content). */
export const WebhookApprovalData = z.object({
  approvalId: Id,
  taskId: Id,
  stepId: Id,
  toolId: ToolId,
  riskLevel: RiskLevel,
  status: ApprovalStatus,
  expiresAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});

/** `data` of schedule.* events. */
export const WebhookScheduleData = z.object({
  scheduleId: Id,
  occurrenceAt: Timestamp,
  taskId: Id.nullable(),
  status: ScheduleStatus,
  consecutiveFailures: z.number().int().nonnegative(),
  reason: ScheduleRunReason.nullable(),
});

/**
 * The JSON body of every delivery (Standard Webhooks). Headers:
 *   webhook-id         msg_<delivery id>  (same on every attempt: dedupe on it)
 *   webhook-timestamp  Unix seconds of this attempt
 *   webhook-signature  "v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>"
 *                      key = base64-decoded secret without the whsec_ prefix
 * Reject timestamps outside WEBHOOK_LIMITS.toleranceSeconds (replay window).
 */
export const WebhookPayload = z.union([
  z.object({
    type: WebhookEventType.extract([
      'task.created',
      'task.completed',
      'task.failed',
      'task.cancelled',
      'task.expired',
    ]),
    timestamp: Timestamp,
    data: WebhookTaskData,
  }),
  z.object({
    type: WebhookEventType.extract(['approval.requested', 'approval.decided']),
    timestamp: Timestamp,
    data: WebhookApprovalData,
  }),
  z.object({
    type: WebhookEventType.extract(['schedule.triggered', 'schedule.failed']),
    timestamp: Timestamp,
    data: WebhookScheduleData,
  }),
  z.object({
    type: z.literal('webhook.test'),
    timestamp: Timestamp,
    data: z.object({ endpointId: Id, test: z.literal(true) }),
  }),
]);
export type WebhookPayload = z.infer<typeof WebhookPayload>;

/* ------------------------------------------------------------------ */
/* Meta (Phase B)                                                      */
/* ------------------------------------------------------------------ */

/** A time zone the server accepts: known to both Postgres and Node (Intl). */
export const TimeZoneInfo = z.object({
  /** As the server stores it (Postgres's spelling). */
  id: z.string(),
  /** Offset from UTC right now, in minutes (changes with DST). */
  utcOffsetMinutes: z.number().int(),
});
export type TimeZoneInfo = z.infer<typeof TimeZoneInfo>;

/* ------------------------------------------------------------------ */
/* Phase C — shopping (docs/architecture/phase-c.md §3.6)              */
/* ------------------------------------------------------------------ */

/** A fact about a merchant read from its own pages (ReliabilitySignalCode). */
export const ReliabilitySignal = z.object({
  code: ReliabilitySignalCode,
  present: z.boolean(),
  /** e.g. "4.6 (1,203 ratings)" for customer_rating, as the page states it; null otherwise. */
  value: z.string().nullable(),
});
export type ReliabilitySignal = z.infer<typeof ReliabilitySignal>;

/**
 * One product offer as a supported shop showed it live. Prices, shipping and
 * delivery come only from the page (with evidence); null means the page did
 * not state it — never an estimate.
 */
export const ProductOffer = z.object({
  /** Stable within its search result (the tool's id for it). */
  id: z.string(),
  siteId: z.string(),
  merchantName: z.string(),
  merchantHost: z.string(),
  /** As the page states it (untrusted text). */
  title: z.string(),
  productUrl: z.string(),
  price: Money,
  /** null: the page states no shipping cost for this offer. */
  shipping: Money.nullable(),
  /** price + shipping when both are known and in the same currency; null otherwise. */
  total: Money.nullable(),
  delivery: z.object({
    minDays: z.number().int().nonnegative().nullable(),
    maxDays: z.number().int().nonnegative().nullable(),
    /** As the page states it. */
    text: z.string().nullable(),
  }),
  inStock: z.boolean().nullable(),
  rating: z
    .object({ value: z.number().min(0).max(5), count: z.number().int().nonnegative() })
    .nullable(),
  signals: z.array(ReliabilitySignal),
  /** Screenshot of the page the offer was read from. */
  evidenceArtifactId: Id.nullable(),
  capturedAt: Timestamp,
});
export type ProductOffer = z.infer<typeof ProductOffer>;

/** shop.compare output (`comparison`): offers side by side, with where each came from. */
export const ShoppingComparison = z.object({
  query: z.string(),
  offers: z.array(ProductOffer).max(COMMERCE_LIMITS.maxOffers),
  /** Offer ids, lowest known total first; offers without a known total come last. */
  ranking: z.array(z.string()),
  /** Each shop that was asked and what happened there. */
  sites: z.array(
    z.object({
      siteId: z.string(),
      status: z.enum(['ok', 'failed', 'handover']),
      reason: BrowserStopReason.nullable(),
    }),
  ),
  /** Offers in different currencies are not converted (no verifiable exchange rate). */
  mixedCurrencies: z.boolean(),
  generatedAt: Timestamp,
});
export type ShoppingComparison = z.infer<typeof ShoppingComparison>;

export const CartLine = z.object({
  title: z.string(),
  quantity: z.number().int().positive().max(COMMERCE_LIMITS.maxQuantityPerLine),
  unitPrice: Money,
  lineTotal: Money,
  productUrl: z.string(),
});
export type CartLine = z.infer<typeof CartLine>;

/** shop.prepare_cart output (`cart`): a cart on the merchant's site, nothing bought. */
export const PreparedCart = z.object({
  siteId: z.string(),
  merchantName: z.string(),
  merchantHost: z.string(),
  lines: z.array(CartLine).min(1).max(COMMERCE_LIMITS.maxCartLines),
  subtotal: Money,
  shipping: Money.nullable(),
  total: Money.nullable(),
  /** The site's recipe can place the order (shop.checkout); otherwise use handoverUrl. */
  checkoutSupported: z.boolean(),
  /** Where the user finishes the purchase themselves (shops without checkout support). */
  handoverUrl: z.string().nullable(),
  evidenceArtifactId: Id.nullable(),
  preparedAt: Timestamp,
});
export type PreparedCart = z.infer<typeof PreparedCart>;

/** An order shop.checkout placed or tried to place (GET /v1/orders). */
export const Order = z.object({
  id: Id,
  taskId: Id.nullable(),
  siteId: z.string(),
  merchantName: z.string(),
  merchantHost: z.string(),
  status: OrderStatus,
  items: z.array(CartLine),
  subtotal: Money,
  shipping: Money,
  tax: Money.nullable(),
  total: Money,
  /** The merchant's order number (placed only). */
  merchantOrderId: z.string().nullable(),
  placedAt: Timestamp.nullable(),
  /** failed / unknown: why (a TaskErrorReason). */
  failureReason: TaskErrorReason.nullable(),
  evidence: z.array(EvidenceArtifact),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Order = z.infer<typeof Order>;

/* ------------------------------------------------------------------ */
/* Phase C — booking (docs/architecture/phase-c.md §3.4)               */
/* ------------------------------------------------------------------ */

/** A free slot exactly as the site offered it live. */
export const BookingSlot = z.object({
  /** The site's own id of the slot. */
  id: z.string(),
  start: Timestamp,
  end: Timestamp.nullable(),
  timeZone: z.string(),
  service: z.string(),
  price: Money.nullable(),
});
export type BookingSlot = z.infer<typeof BookingSlot>;

/** booking.find_slots output (`result`). */
export const BookingSlots = z.object({
  siteId: z.string(),
  siteName: z.string(),
  service: z.string(),
  slots: z.array(BookingSlot),
  /** Labels of the details the site's form requires (JARVIS asks for the ones it lacks). */
  requiredFields: z.array(z.string()),
  /** Screenshot of the live availability. */
  evidenceArtifactId: Id.nullable(),
  capturedAt: Timestamp,
});
export type BookingSlots = z.infer<typeof BookingSlots>;

/**
 * booking.book output (`confirmation`): what the site confirmed — read from
 * its confirmation page (schema.org Reservation / ICS), never assumed.
 */
export const BookingConfirmation = z.object({
  bookingId: Id,
  reference: z.string(),
  service: z.string(),
  start: Timestamp,
  end: Timestamp.nullable(),
  timeZone: z.string(),
  location: z.string().nullable(),
  siteId: z.string(),
  siteHost: z.string(),
  icsArtifactId: Id.nullable(),
  screenshotArtifactId: Id.nullable(),
  confirmedAt: Timestamp,
});
export type BookingConfirmation = z.infer<typeof BookingConfirmation>;

/** An appointment booking.book made or tried to make (GET /v1/bookings). */
export const Booking = z.object({
  id: Id,
  taskId: Id.nullable(),
  siteId: z.string(),
  siteName: z.string(),
  siteHost: z.string(),
  service: z.string(),
  status: BookingStatus,
  start: Timestamp,
  end: Timestamp.nullable(),
  timeZone: z.string(),
  reference: z.string().nullable(),
  price: Money.nullable(),
  binding: z.boolean(),
  /** The calendar entry JARVIS created for it (calendar.create_event), if any. */
  calendarEventId: z.string().nullable(),
  failureReason: TaskErrorReason.nullable(),
  evidence: z.array(EvidenceArtifact),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Booking = z.infer<typeof Booking>;

export const OrderListQuery = PageQuery.extend({ status: OrderStatus.optional() });
export type OrderListQuery = z.infer<typeof OrderListQuery>;
export const BookingListQuery = PageQuery.extend({ status: BookingStatus.optional() });
export type BookingListQuery = z.infer<typeof BookingListQuery>;
