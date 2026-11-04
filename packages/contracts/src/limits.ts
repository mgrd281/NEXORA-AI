import type { AttachmentMediaType } from './enums';

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
