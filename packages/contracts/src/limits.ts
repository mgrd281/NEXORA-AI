import type {
  AttachmentMediaType,
  ConnectionCapability,
  EvidenceArtifactKind,
  EvidenceMediaType,
  OAuthProvider,
} from './enums';

/**
 * Hard limits of Phase B features, shared by the server (which enforces them)
 * and clients (which check before sending and explain them). Changing one is
 * a contract change: see docs/architecture/phase-b.md.
 */

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

export const ATTACHMENT_LIMITS = {
  /** Largest accepted file (10 MiB). Larger uploads fail with PAYLOAD_TOO_LARGE / FILE_TOO_LARGE. */
  maxBytes: 10 * 1024 * 1024,
  /** Attachments per request (CreateTaskRequest / FollowUpRequest `attachmentIds`). */
  maxPerRequest: 5,
  /** An upload not attached to a request within this time is deleted. */
  unattachedTtlHours: 24,
  maxFilenameChars: 255,
  /** document.analyze reads at most this many pages of a PDF (DOCUMENT_TOO_MANY_PAGES beyond). */
  maxPdfPages: 200,
  /** Extracted text kept for analysis per document (longer text is cut, and says so). */
  maxExtractedChars: 200_000,
  /**
   * DOCX (a ZIP): the sum of the entries' uncompressed sizes, read from the
   * central directory before anything is inflated (zip-bomb guard), and the
   * largest compression ratio of any entry.
   */
  maxDocxUncompressedBytes: 50 * 1024 * 1024,
  maxDocxCompressionRatio: 100,
} as const;

/** The multipart/form-data field that carries the file (POST /v1/attachments). */
export const ATTACHMENT_UPLOAD_FIELD = 'file';

/**
 * File-name extensions accepted per media type. The server identifies the type
 * from the content (magic bytes / structure / UTF-8 validity) and requires the
 * extension to agree (FILE_CONTENT_MISMATCH otherwise).
 */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<AttachmentMediaType, readonly string[]>> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md', '.markdown'],
  'text/csv': ['.csv'],
};

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

export const SCHEDULE_LIMITS = {
  /** Schedules per user that are not completed (SCHEDULE_LIMIT_REACHED beyond). */
  maxPerUser: 20,
  /** Consecutive failed runs after which a schedule pauses itself (pausedReason 'failures'). */
  failuresBeforePause: 3,
  /** Occurrences a preview may return. */
  maxPreview: 10,
  /** Occurrences shown with a schedule (ScheduleDetail.upcoming, schedule approvals). */
  upcomingShown: 3,
  /** Runs listed in ScheduleDetail.runs (newest first). */
  runsShown: 10,
} as const;

/* ------------------------------------------------------------------ */
/* Webhooks (Standard Webhooks, https://www.standardwebhooks.com)      */
/* ------------------------------------------------------------------ */

export const WEBHOOK_LIMITS = {
  maxEndpointsPerUser: 10,
  /** Delivery attempts per event, the first included. */
  maxAttempts: 8,
  /**
   * Delay before attempt n+1 after attempt n failed (seconds), n = 1…7:
   * 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h (about 10.7 h in total).
   */
  retryDelaysSeconds: [30, 120, 600, 1_800, 3_600, 10_800, 21_600],
  /** An endpoint is disabled (reason 'failures') after this many consecutive failed deliveries. */
  disableAfterFailedDeliveries: 5,
  /** Receivers should reject a webhook-timestamp further than this from their clock (replay window). */
  toleranceSeconds: 300,
  /** Per-attempt timeout (connect + response). */
  timeoutSeconds: 10,
  /** Response bodies are read up to this size and then discarded (never stored). */
  maxResponseBytes: 64 * 1024,
  /** Delivery log rows are kept this long. */
  deliveryRetentionDays: 30,
} as const;

/** Prefix of endpoint secrets (whsec_ + base64 of 32 random bytes). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Prefix of the webhook-id header (msg_ + the delivery id); stable across retries. */
export const WEBHOOK_ID_PREFIX = 'msg_';

/* ------------------------------------------------------------------ */
/* Retention (preferences.retention)                                   */
/* ------------------------------------------------------------------ */

/** Memory retention choices in days; null = keep until deleted. */
export const MEMORY_RETENTION_DAYS = [30, 90, 365] as const;
/** Task history retention choices in days; null = keep until deleted. */
export const TASK_HISTORY_RETENTION_DAYS = [90, 365] as const;

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export const CONVERSATION_LIMITS = {
  /** Earlier tasks of the conversation passed to the planner as context (newest first). */
  contextTasks: 6,
  /** Characters per earlier result in that context (longer results are cut). */
  contextCharsPerTurn: 2_000,
  /** Characters of all earlier turns together. */
  contextCharsTotal: 8_000,
} as const;

/* ------------------------------------------------------------------ */
/* Phase C — OAuth connections (docs/architecture/phase-c.md §3.1)     */
/* ------------------------------------------------------------------ */

/**
 * Least-privilege provider scopes per capability. A connection requests the
 * identity scopes plus the scopes of the capabilities the user enables (and,
 * when adding a capability later, only the new ones: incremental
 * authorization). The server records the scopes the provider actually granted
 * and grants a capability only when all of its scopes were granted.
 * Microsoft scopes are compared without the "https://graph.microsoft.com/"
 * prefix and case-insensitively (the token endpoint may return either form).
 */
export const OAUTH_SCOPES: Readonly<
  Record<OAuthProvider, Readonly<Record<ConnectionCapability | 'identity', readonly string[]>>>
> = {
  google: {
    // sub + verified email of the account (userinfo); no profile data.
    identity: ['openid', 'email'],
    'mail.read': ['https://www.googleapis.com/auth/gmail.readonly'],
    'mail.compose': ['https://www.googleapis.com/auth/gmail.compose'],
    'mail.send': ['https://www.googleapis.com/auth/gmail.send'],
    'calendar.read': [
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ],
    'calendar.write': ['https://www.googleapis.com/auth/calendar.events'],
  },
  microsoft: {
    // offline_access: a refresh token; User.Read: the account's id and address (GET /me).
    identity: ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/User.Read'],
    'mail.read': ['https://graph.microsoft.com/Mail.Read'],
    // Graph creates drafts with Mail.ReadWrite (there is no draft-only permission).
    'mail.compose': ['https://graph.microsoft.com/Mail.ReadWrite'],
    'mail.send': ['https://graph.microsoft.com/Mail.Send'],
    'calendar.read': ['https://graph.microsoft.com/Calendars.Read'],
    'calendar.write': ['https://graph.microsoft.com/Calendars.ReadWrite'],
  },
};

export const OAUTH_LIMITS = {
  /** An authorization request (state + PKCE verifier) is valid this long and once. */
  stateTtlMinutes: 10,
  /** Unfinished authorization requests per user (OAUTH_PENDING_LIMIT beyond). */
  maxPendingStates: 5,
  /** Access tokens are refreshed when they expire within this many seconds. */
  refreshSkewSeconds: 300,
  /** Timeout of one call to a provider's token, revoke or API endpoint. */
  providerTimeoutMs: 10_000,
  /** OAuthStartRequest.returnTo: a path of the client app (no scheme or host). */
  maxReturnToChars: 512,
  /** Failed tasks offered for a retry after reconnecting (OAuthCallbackResult.resumableTaskIds). */
  resumableTasksMax: 10,
  resumableWithinDays: 7,
} as const;

/* ------------------------------------------------------------------ */
/* Phase C — email agent                                               */
/* ------------------------------------------------------------------ */

export const EMAIL_LIMITS = {
  /** Threads one email.search returns. */
  searchMaxResults: 25,
  /** Messages read from one thread (newest kept). */
  threadMaxMessages: 50,
  /** Characters of message text one email.read_thread passes on (longer is cut, and says so). */
  threadMaxChars: 50_000,
  /** Snippet characters per thread / message summary. */
  snippetChars: 200,
  /** Body of a draft or a reply. */
  bodyMaxChars: 50_000,
  /** Threads watched for replies per user (WATCH_LIMIT_REACHED beyond). */
  watchMaxPerUser: 20,
  watchDefaultDays: 14,
  watchMaxDays: 30,
  /** How often a watched thread is checked for replies. */
  watchPollMinutes: 10,
} as const;

/* ------------------------------------------------------------------ */
/* Phase C — calendars                                                 */
/* ------------------------------------------------------------------ */

export const CALENDAR_LIMITS = {
  /** Home "Upcoming": the next events in this many days, at most upcomingMax. */
  upcomingDays: 7,
  upcomingMax: 10,
  /** Home waits this long for the providers; slower ones are reported as 'unavailable'. */
  homeTimeoutMs: 2_500,
  /** Upcoming events may be served from memory this long (never stored in the database). */
  upcomingCacheSeconds: 60,
  /** GET /v1/calendar/events and calendar.list: the widest window, and the most events. */
  listMaxDays: 62,
  listMaxEvents: 250,
  /** calendar.free_busy window. */
  freeBusyMaxDays: 14,
  /** Attendees of one event (invitations). */
  maxAttendees: 20,
  /** Proposed meeting times returned by calendar.free_busy. */
  maxProposedSlots: 5,
  /** Proposed times start on multiples of this many minutes. */
  slotStepMinutes: 15,
  minDurationMinutes: 5,
  maxDurationMinutes: 480,
  /** Default working hours for proposals, in the account's time zone (HH:MM). */
  defaultWorkdayStart: '08:00',
  defaultWorkdayEnd: '18:00',
} as const;

/* ------------------------------------------------------------------ */
/* Phase C — browser agent                                             */
/* ------------------------------------------------------------------ */

export const BROWSER_LIMITS = {
  /** A whole session (all navigations, waits and extraction). */
  sessionTimeoutSeconds: 90,
  pageLoadTimeoutSeconds: 20,
  /** Top-level navigations per session (redirects included). */
  maxNavigations: 20,
  /** Requests of any kind (documents, scripts, images, XHR) per session. */
  maxRequests: 400,
  maxScreenshotBytes: 2 * 1024 * 1024,
  maxExtractBytes: 256 * 1024,
  maxIcsBytes: 64 * 1024,
  /** Evidence files one session may store. */
  maxArtifactsPerSession: 10,
  /** Sessions one user may have queued or running at once. */
  maxConcurrentPerUser: 2,
  viewport: { width: 1280, height: 900 },
} as const;

/** The media type each kind of evidence file has. */
export const EVIDENCE_MEDIA_TYPE: Readonly<Record<EvidenceArtifactKind, EvidenceMediaType>> = {
  screenshot: 'image/png',
  extract: 'application/json',
  ics: 'text/calendar',
};

/* ------------------------------------------------------------------ */
/* Phase C — shopping                                                  */
/* ------------------------------------------------------------------ */

export const COMMERCE_LIMITS = {
  /** Offers shop.search returns and shop.compare ranks. */
  maxOffers: 20,
  maxCartLines: 10,
  maxQuantityPerLine: 10,
  /** Highest value of preferences.spending.monthlyPurchaseLimitUsd. */
  monthlyPurchaseLimitUsdMax: 10_000,
  /** The currency of the purchase limit; purchases in other currencies are refused (PURCHASE_CURRENCY). */
  limitCurrency: 'USD',
} as const;
