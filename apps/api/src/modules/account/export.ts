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
 */
import { sql } from 'kysely';
import type { Trx } from '../../db/pool';
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

export const EXPORT_FORMAT = 'jarvis.account-export';
export const EXPORT_VERSION = 2;

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
    .select(['id', 'title', 'created_at', 'updated_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const messages = await trx
    .selectFrom('messages')
    .select(['id', 'conversation_id', 'task_id', 'role', 'content', 'language', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
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
    ])
    .where('user_id', '=', userId)
    .orderBy('started_at')
    .execute();
  // scheduled_tasks has no Kysely table type yet (no API writes it in this build).
  const scheduled = (
    await sql<{
      id: string;
      title: string;
      request: string;
      rrule: string;
      time_zone: string;
      enabled: boolean;
      next_run_at: Date | null;
      last_run_at: Date | null;
      created_at: Date;
    }>`select id, title, request, rrule, time_zone, enabled, next_run_at, last_run_at, created_at
         from scheduled_tasks where user_id = ${userId} order by created_at`.execute(trx)
  ).rows;
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
      createdAt: c.created_at.toISOString(),
      updatedAt: c.updated_at.toISOString(),
    })),
    messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      taskId: m.task_id,
      role: m.role,
      content: m.content,
      language: m.language,
      createdAt: m.created_at.toISOString(),
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
    })),
    scheduledTasks: scheduled.map((s) => ({
      id: s.id,
      title: s.title,
      request: s.request,
      rrule: s.rrule,
      timeZone: s.time_zone,
      enabled: s.enabled,
      nextRunAt: iso(s.next_run_at),
      lastRunAt: iso(s.last_run_at),
      createdAt: s.created_at.toISOString(),
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
