/**
 * Personal data export (GDPR Art. 15/20). One JSON document with everything
 * stored about the user, read in a single RLS-scoped transaction. Credentials
 * are never included: no password hash, session token hashes, push tokens or
 * connection secrets/settings.
 *
 * Version 2: each task step carries its stored data in full — `input` (as
 * planned), `resolvedInput` (what ran), `output` (the full result; v1 held the
 * shortened preview there, now `outputPreview`) — and `toolExecutions`, every
 * recorded attempt of the step with its output, error and evidence. Only
 * internal de-duplication values are left out: execution idempotency keys and
 * hashes of step inputs, both derived from data the export already contains.
 * Step data never holds connection secrets; tools decrypt them in memory only.
 *
 * Version 3 (Phase B): conversations with their localisable titles; messages
 * with kind and server message; tasks with outcome, question, schedule and
 * the ids of their attachments; `attachments` (metadata, the download path,
 * and the file itself, base64, while the export stays within
 * EXPORT_FILE_BYTES — beyond that a file is listed with
 * `contentOmitted: 'EXPORT_SIZE_LIMIT'` and stays downloadable at
 * `downloadPath`); `scheduledTasks` (contract Schedule) with their runs;
 * `webhooks` (endpoints without any secret — not even the envelope — and the
 * delivery log without payloads).
 *
 * Version 4 (Phase C): `connections[]` carry `capabilities`, `scopes` (as
 * granted) and `statusReason` — never OAuth tokens, their envelope, PKCE
 * verifiers or the provider account id; pending authorization requests
 * (oauth_states) are credentials in flight and are not exported. Added:
 * `emailWatches` (contract EmailWatch: subject and sender, no mail content —
 * none is stored), `orders` and `bookings` (contract Order / Booking with
 * their evidence metadata), `browserSessions` (contract BrowserSession plus
 * the recipe `request` and `result` the session stored), and `evidence`
 * (contract EvidenceArtifact; the file itself, base64, within the same
 * EXPORT_FILE_BYTES budget as attachments — attachments first — else
 * `contentOmitted` says why). Calendar and mail content are not stored, so
 * there is none to export (docs/architecture/phase-c.md §3.3).
 *
 * Version 5 (Phase D): `profile.phoneNumber` / `phoneNumberVerifiedAt`; `calls` (contract
 * CallSession — every attempt with its status timeline, outcome and every turn, the callee's
 * words as recognised); `doNotCall` (contract DoNotCallEntry: masked number and source — the
 * keyed hash and the sealed number are internal); `phoneVerifications` (status, masked number,
 * times — never the code); voice sessions with their conversation counters (mode,
 * conversationId, turns, bargeIns, reconnects, endReason). A consented call recording is an
 * evidence file (kind 'recording') and embedded like the others.
 */
import type { Readable } from 'node:stream';
import type { Trx } from '../../db/pool';
import type { AttachmentRow, EvidenceArtifactRow } from '../../db/types';
import { ATTACHMENT_COLUMNS, toAttachment } from '../attachments/mappers';
import { BOOKING_COLUMNS, bookingEvidenceIds, toBooking } from '../bookings/mappers';
import {
  BROWSER_SESSION_COLUMNS,
  EVIDENCE_COLUMNS,
  pickEvidence,
  toBrowserSession,
  toEvidenceArtifact,
} from '../evidence/mappers';
import { toEmailWatch } from '../integrations';
import { ORDER_COLUMNS, orderEvidenceIds, toOrder } from '../orders/mappers';
import { toSchedule } from '../schedules/mappers';
import type { ObjectStorage } from '../storage/types';
import {
  DELIVERY_COLUMNS,
  ENDPOINT_COLUMNS,
  toWebhookDelivery,
  toWebhookEndpoint,
} from '../webhooks/mappers';
import {
  approvalQuery,
  taskSummaryQuery,
  toApproval,
  toTaskEvent,
  toTaskStep,
  toTaskSummary,
  type TaskAggregate,
} from '../tasks/mappers';
import { CONNECTION_COLUMNS, toConnection } from '../connections/routes';
import { MEMORY_COLUMNS, toMemory } from '../memory/routes';
import { toNotification } from '../notifications/routes';
import { loadMe } from './me';
import {
  CALL_COLUMNS,
  doNotCallQuery,
  recordingsOf,
  toCallSession,
  toDoNotCallEntry,
  turnsOf,
  VERIFICATION_COLUMNS,
} from '../telephony/mappers';

export const EXPORT_FORMAT = 'jarvis.account-export';
export const EXPORT_VERSION = 5;
/** Files embedded in one export at most (raw bytes); larger sets list the rest by download path. */
export const EXPORT_FILE_BYTES = 20 * 1024 * 1024;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function groupBy<T, K>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return map;
}

export async function buildAccountExport(
  trx: Trx,
  userId: string,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const me = await loadMe(trx, userId);

  const tasks = (await taskSummaryQuery(trx)
    .where('t.user_id', '=', userId)
    .orderBy('t.created_at')
    .orderBy('t.id')
    .execute()) as TaskAggregate[];
  const steps = await trx
    .selectFrom('task_steps')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('task_id')
    .orderBy('position')
    .execute();
  const approvals = await approvalQuery(trx)
    .where('a.user_id', '=', userId)
    .orderBy('a.created_at')
    .execute();
  const events = await trx
    .selectFrom('task_events')
    .select(['id', 'task_id', 'type', 'data', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('id')
    .execute();
  const executions = await trx
    .selectFrom('tool_executions')
    .select([
      'id',
      'step_id',
      'tool_id',
      'tool_version',
      'status',
      'output',
      'error',
      'evidence',
      'cost_micro',
      'started_at',
      'finished_at',
      'duration_ms',
    ])
    .where('user_id', '=', userId)
    .orderBy('started_at')
    .orderBy('id')
    .execute();
  const stepsByTask = groupBy(steps, (s) => s.task_id);
  const executionsByStep = groupBy(executions, (e) => e.step_id);
  const approvalsByTask = groupBy(approvals, (a) => a.task_id);
  const eventsByTask = groupBy(events, (e) => e.task_id);

  const conversations = await trx
    .selectFrom('conversations')
    .select(['id', 'title', 'title_message', 'created_at', 'updated_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const messages = await trx
    .selectFrom('messages')
    .select([
      'id',
      'conversation_id',
      'task_id',
      'role',
      'kind',
      'content',
      'content_message',
      'language',
      'created_at',
    ])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const attachments = await trx
    .selectFrom('attachments')
    .select(ATTACHMENT_COLUMNS)
    .select(['extracted_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const taskAttachments = await trx
    .selectFrom('task_attachments')
    .select(['task_id', 'attachment_id', 'position'])
    .where('user_id', '=', userId)
    .orderBy('task_id')
    .orderBy('position')
    .execute();
  const attachmentsByTask = groupBy(taskAttachments, (l) => l.task_id);
  const memories = await trx
    .selectFrom('memories')
    .select(MEMORY_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const connections = await trx
    .selectFrom('connections')
    .select(CONNECTION_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const notifications = await trx
    .selectFrom('notifications')
    .select(['id', 'kind', 'task_id', 'data', 'read_at', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const sessions = await trx
    .selectFrom('sessions')
    .select([
      'id',
      'platform',
      'device_name',
      'user_agent',
      'created_at',
      'last_used_at',
      'expires_at',
      'revoked_at',
    ])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const devices = await trx
    .selectFrom('devices')
    .select(['id', 'name', 'platform', 'created_at', 'last_seen_at', 'revoked_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const voiceSessions = await trx
    .selectFrom('voice_sessions')
    .select([
      'id',
      'locale',
      'engine',
      'outcome',
      'transcript_chars',
      'error_code',
      'task_id',
      'started_at',
      'ended_at',
      // Phase D
      'mode',
      'conversation_id',
      'turn_count',
      'barge_in_count',
      'reconnect_count',
      'end_reason',
    ])
    .where('user_id', '=', userId)
    .orderBy('started_at')
    .execute();
  const scheduled = await trx
    .selectFrom('scheduled_tasks')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const scheduleRuns = await trx
    .selectFrom('schedule_runs')
    .select(['id', 'schedule_id', 'occurrence_at', 'status', 'reason', 'task_id', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('occurrence_at')
    .orderBy('id')
    .execute();
  const runsBySchedule = groupBy(scheduleRuns, (r) => r.schedule_id);
  // Never secret_ciphertext / secret_key_id: ENDPOINT_COLUMNS lists display columns only.
  const webhookEndpoints = await trx
    .selectFrom('webhook_endpoints')
    .select(ENDPOINT_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const webhookDeliveries = await trx
    .selectFrom('webhook_deliveries')
    .select(DELIVERY_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const deliveriesByEndpoint = groupBy(webhookDeliveries, (d) => d.endpoint_id);
  // Phase C
  const emailWatches = await trx
    .selectFrom('email_watches')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const evidenceRows = await trx
    .selectFrom('evidence_artifacts')
    .select(EVIDENCE_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const evidence = evidenceRows.map(toEvidenceArtifact);
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const evidenceBySession = groupBy(evidence, (e) => e.browserSessionId);
  const browserSessions = await trx
    .selectFrom('browser_sessions')
    .select(BROWSER_SESSION_COLUMNS)
    .select(['request', 'result'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const orders = await trx
    .selectFrom('orders')
    .select(ORDER_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const bookings = await trx
    .selectFrom('bookings')
    .select(BOOKING_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const usageEvents = await trx
    .selectFrom('usage_events')
    .select([
      'id',
      'task_id',
      'kind',
      'provider',
      'model',
      'input_tokens',
      'output_tokens',
      'quantity',
      'created_at',
    ])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const costRecords = await trx
    .selectFrom('cost_records')
    .select([
      'id',
      'task_id',
      'usage_event_id',
      'category',
      'amount_micro',
      'currency',
      'created_at',
    ])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();

  // Phase D (version 5)
  const calls = await trx
    .selectFrom('call_sessions')
    .select(CALL_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const callIds = calls.map((c) => c.id);
  const [callTurns, callRecordings] = await Promise.all([
    turnsOf(trx, callIds),
    recordingsOf(trx, callIds),
  ]);
  const doNotCall = await doNotCallQuery(trx)
    .where('d.user_id', '=', userId)
    .orderBy('d.created_at')
    .orderBy('d.id')
    .execute();
  const verifications = await trx
    .selectFrom('phone_verifications')
    .select(VERIFICATION_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  const { preferences, ...profile } = me;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    profile,
    preferences,
    tasks: tasks.map((t) => ({
      ...toTaskSummary(t),
      objective: t.objective,
      conversationId: t.conversation_id,
      language: t.language,
      planner: t.planner ?? null,
      answer: t.answer,
      evidence: Array.isArray(t.evidence) ? t.evidence : [],
      attempt: t.attempt,
      cost: { estimatedMicroUsd: t.estimated_cost_micro, actualMicroUsd: t.actual_cost_micro },
      startedAt: iso(t.started_at),
      steps: (stepsByTask.get(t.id) ?? []).map((s) => ({
        ...toTaskStep(s),
        input: s.input,
        resolvedInput: s.resolved_input ?? null,
        output: s.output ?? null,
        outputPreview: s.output_preview ?? null,
        toolExecutions: (executionsByStep.get(s.id) ?? []).map((e) => ({
          id: e.id,
          toolId: e.tool_id,
          toolVersion: e.tool_version,
          status: e.status,
          output: e.output ?? null,
          error: e.error ?? null,
          evidence: Array.isArray(e.evidence) ? e.evidence : [],
          costMicroUsd: Number(e.cost_micro),
          startedAt: e.started_at.toISOString(),
          finishedAt: iso(e.finished_at),
          durationMs: e.duration_ms,
        })),
      })),
      approvals: (approvalsByTask.get(t.id) ?? []).map(toApproval),
      events: (eventsByTask.get(t.id) ?? []).map(toTaskEvent),
      attachmentIds: (attachmentsByTask.get(t.id) ?? []).map((l) => l.attachment_id),
    })),
    // Account-level events (e.g. connection changes) that belong to no task.
    events: (eventsByTask.get(null) ?? []).map((e) => ({
      id: String(e.id),
      type: e.type,
      at: e.created_at.toISOString(),
      data: e.data ?? {},
    })),
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      titleMessage: c.title_message ?? null,
      createdAt: c.created_at.toISOString(),
      updatedAt: c.updated_at.toISOString(),
    })),
    messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      taskId: m.task_id,
      role: m.role,
      kind: m.kind,
      content: m.content,
      contentMessage: m.content_message ?? null,
      language: m.language,
      createdAt: m.created_at.toISOString(),
    })),
    // File contents are added by embedExportFiles (outside the database transaction).
    attachments: attachments.map((a) => ({
      ...toAttachment(a),
      extractedAt: iso(a.extracted_at),
      content: null as ExportFileContent | null,
      contentOmitted: null as ExportFileOmission | null,
    })),
    memories: memories.map(toMemory),
    connections: connections.map(toConnection),
    notifications: notifications.map(toNotification),
    sessions: sessions.map((s) => ({
      id: s.id,
      platform: s.platform,
      deviceName: s.device_name,
      userAgent: s.user_agent,
      createdAt: s.created_at.toISOString(),
      lastUsedAt: s.last_used_at.toISOString(),
      expiresAt: iso(s.expires_at),
      revokedAt: iso(s.revoked_at),
    })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      createdAt: d.created_at.toISOString(),
      lastSeenAt: d.last_seen_at.toISOString(),
      revokedAt: iso(d.revoked_at),
    })),
    voiceSessions: voiceSessions.map((v) => ({
      id: v.id,
      locale: v.locale,
      engine: v.engine,
      outcome: v.outcome,
      transcriptChars: v.transcript_chars,
      errorCode: v.error_code,
      taskId: v.task_id,
      startedAt: v.started_at.toISOString(),
      endedAt: iso(v.ended_at),
      // Phase D: conversation mode and its counters (metadata only; no audio, no transcript).
      mode: v.mode,
      conversationId: v.conversation_id,
      turns: v.turn_count,
      bargeIns: v.barge_in_count,
      reconnects: v.reconnect_count,
      endReason: v.end_reason,
    })),
    scheduledTasks: scheduled.map((row) => ({
      ...toSchedule(row),
      runs: (runsBySchedule.get(row.id) ?? []).map((r) => ({
        id: r.id,
        occurrenceAt: new Date(r.occurrence_at).toISOString(),
        status: r.status,
        reason: r.reason,
        taskId: r.task_id,
        createdAt: r.created_at.toISOString(),
      })),
    })),
    webhooks: webhookEndpoints.map((e) => ({
      ...toWebhookEndpoint(e),
      deliveries: (deliveriesByEndpoint.get(e.id) ?? []).map(toWebhookDelivery),
    })),
    // Phase C (version 4)
    emailWatches: emailWatches.map(toEmailWatch),
    orders: orders.map((o) => toOrder(o, pickEvidence(evidenceById, orderEvidenceIds(o)))),
    bookings: bookings.map((b) => toBooking(b, pickEvidence(evidenceById, bookingEvidenceIds(b)))),
    browserSessions: browserSessions.map((b) => ({
      ...toBrowserSession(b, evidenceBySession.get(b.id) ?? []),
      request: b.request ?? null,
      result: b.result ?? null,
    })),
    // Phase D (version 5): calls with every turn, the do-not-call list (masked), verifications.
    calls: calls.map((c) =>
      toCallSession(c, callTurns.get(c.id) ?? [], callRecordings.get(c.id) ?? null),
    ),
    doNotCall: doNotCall.map(toDoNotCallEntry),
    phoneVerifications: verifications.map((v) => ({
      id: v.id,
      // The number in full: it is the account's own (also in profile.phoneNumber).
      phoneNumber: v.phone_number,
      status: v.status,
      attempts: v.attempts,
      createdAt: v.created_at.toISOString(),
      expiresAt: new Date(v.expires_at).toISOString(),
      verifiedAt: iso(v.verified_at),
    })),
    // File contents are added by embedExportFiles (outside the database transaction).
    evidence: evidence.map((e) => ({
      ...e,
      content: null as ExportFileContent | null,
      contentOmitted: null as ExportFileOmission | null,
    })),
    usage: {
      events: usageEvents.map((u) => ({
        id: u.id,
        taskId: u.task_id,
        kind: u.kind,
        provider: u.provider,
        model: u.model,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        quantity: u.quantity,
        createdAt: u.created_at.toISOString(),
      })),
      costs: costRecords.map((c) => ({
        id: c.id,
        taskId: c.task_id,
        usageEventId: c.usage_event_id,
        category: c.category,
        amountMicroUsd: Number(c.amount_micro),
        currency: c.currency,
        createdAt: c.created_at.toISOString(),
      })),
    },
  };
}

export interface ExportFileContent {
  encoding: 'base64';
  data: string;
}
/** Why a file's bytes are not in the export (it stays downloadable while the account exists). */
export type ExportFileOmission = 'EXPORT_SIZE_LIMIT' | 'STORAGE_NOT_CONFIGURED' | 'NOT_AVAILABLE';

export type ExportFileLocation =
  | Pick<AttachmentRow, 'id' | 'size_bytes' | 'storage_driver' | 'storage_key' | 'sha256'>
  | Pick<EvidenceArtifactRow, 'id' | 'size_bytes' | 'storage_driver' | 'storage_key' | 'sha256'>;

/**
 * Where the export's files are stored (read in the export's transaction,
 * fetched after it): attachments, then (Phase C) evidence files, each oldest first.
 */
export async function exportFileLocations(trx: Trx, userId: string): Promise<ExportFileLocation[]> {
  const columns = ['id', 'size_bytes', 'storage_driver', 'storage_key', 'sha256'] as const;
  const attachments = await trx
    .selectFrom('attachments')
    .select(columns)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const evidence = await trx
    .selectFrom('evidence_artifacts')
    .select(columns)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return [...attachments, ...evidence];
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

interface ExportFileEntry {
  id: string;
  content: ExportFileContent | null;
  contentOmitted: ExportFileOmission | null;
}

/**
 * Embeds the files' bytes (base64) into an export built by buildAccountExport,
 * attachments then evidence files (Phase C), oldest first, up to
 * EXPORT_FILE_BYTES in total. A file that is not embedded says why
 * (contentOmitted); none is ever silently dropped.
 */
export async function embedExportFiles(
  doc: Record<string, unknown>,
  files: readonly ExportFileLocation[],
  storage: ObjectStorage | null,
  log: { warn(obj: object, msg: string): void },
  limitBytes = EXPORT_FILE_BYTES,
): Promise<void> {
  const entries = [
    ...((doc.attachments as ExportFileEntry[] | undefined) ?? []),
    ...((doc.evidence as ExportFileEntry[] | undefined) ?? []),
  ];
  const byId = new Map(files.map((f) => [f.id, f]));
  let used = 0;
  for (const entry of entries) {
    const file = byId.get(entry.id);
    if (!storage || !file) {
      entry.contentOmitted = storage ? 'NOT_AVAILABLE' : 'STORAGE_NOT_CONFIGURED';
      continue;
    }
    if (used + file.size_bytes > limitBytes) {
      entry.contentOmitted = 'EXPORT_SIZE_LIMIT';
      continue;
    }
    try {
      if (file.storage_driver !== storage.driver) throw new Error('stored with another driver');
      const bytes = await readAll(await storage.get(file.storage_key));
      used += bytes.length;
      entry.content = { encoding: 'base64', data: bytes.toString('base64') };
    } catch (err) {
      log.warn({ err, fileId: file.id }, 'export: file not readable');
      entry.contentOmitted = 'NOT_AVAILABLE';
    }
  }
}
