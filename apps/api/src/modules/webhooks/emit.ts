/**
 * Webhook emission (docs/architecture/phase-b.md §3.8). Called by the runtime
 * inside the transaction of the state change it reports, so a delivery exists
 * exactly when the change committed:
 *
 *   one pending delivery per active endpoint subscribed to the event type,
 *   deduplicated by (endpoint, event_key) — emitting the same occurrence
 *   twice (a retried job, two workers) never creates a second delivery —
 *   plus one webhook.deliver job each.
 *
 * Payloads are contracts WebhookPayload: ids, enums and timestamps only.
 * Parsing with the contract strips any other field, so a caller can never
 * leak titles, requests, answers, email content, memory or file names.
 * Cost for a user without endpoints: one indexed query.
 */
import { sql } from 'kysely';
import type { z } from 'zod';
import {
  WEBHOOK_LIMITS,
  WebhookPayload,
  type WebhookApprovalData,
  type WebhookEventType,
  type WebhookScheduleData,
  type WebhookTaskData,
} from '@jarvis/contracts';
import type { DbContext, Trx } from '../../db/pool';
import { enqueue } from '../jobs/queue';

export interface WebhookEventInput {
  type: WebhookEventType;
  /** Unique per occurrence of the event: with `type` it is the dedupe key (event_key). */
  occurrenceKey: string; // task events: `${taskId}:${attempt}`; approvals: approvalId; schedules: `${scheduleId}:${occurrenceISO}`
  data:
    | z.infer<typeof WebhookTaskData>
    | z.infer<typeof WebhookApprovalData>
    | z.infer<typeof WebhookScheduleData>;
  at?: Date;
}

/** Job attempts per delivery attempt: the queue's own retries cover worker crashes only. */
export const DELIVER_JOB_MAX_ATTEMPTS = 3;

/** Dedupe key of the job that performs delivery attempt `attempt` (1-based). */
export function deliveryJobKey(deliveryId: string, attempt: number): string {
  return `webhook:${deliveryId}:${attempt}`;
}

/** Queues the job for one delivery attempt (inside the caller's transaction). */
export async function enqueueWebhookDelivery(
  trx: Trx,
  ctx: DbContext,
  deliveryId: string,
  opts: { attempt?: number; runAt?: Date } = {},
): Promise<boolean> {
  return enqueue(trx, {
    kind: 'webhook.deliver',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    payload: { deliveryId },
    dedupeKey: deliveryJobKey(deliveryId, opts.attempt ?? 1),
    maxAttempts: DELIVER_JOB_MAX_ATTEMPTS,
    ...(opts.runAt ? { runAt: opts.runAt } : {}),
  });
}

/** The stored body of a delivery: contract-checked and stripped to the contract's fields. */
export function buildWebhookPayload(event: {
  type: WebhookPayload['type'];
  data: unknown;
  at?: Date;
}): WebhookPayload {
  return WebhookPayload.parse({
    type: event.type,
    timestamp: (event.at ?? new Date()).toISOString(),
    data: event.data,
  });
}

/** One pending delivery (+ job) per active, subscribed endpoint. Returns how many were created. */
export async function emitWebhookEvent(
  trx: Trx,
  ctx: DbContext,
  event: WebhookEventInput,
): Promise<number> {
  const endpoints = await trx
    .selectFrom('webhook_endpoints')
    .select('id')
    .where('user_id', '=', ctx.userId)
    .where('status', '=', 'active')
    .where(sql<boolean>`event_types @> ARRAY[${event.type}]::text[]`)
    .orderBy('created_at')
    .execute();
  if (endpoints.length === 0) return 0;

  const eventKey = `${event.type}:${event.occurrenceKey}`;
  if (eventKey.length > 200) throw new Error('Webhook event key too long');
  const payload = JSON.stringify(buildWebhookPayload(event));
  let created = 0;
  for (const endpoint of endpoints) {
    const row = await trx
      .insertInto('webhook_deliveries')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        endpoint_id: endpoint.id,
        event_type: event.type,
        event_key: eventKey,
        payload,
        max_attempts: WEBHOOK_LIMITS.maxAttempts,
      })
      .onConflict((oc) => oc.columns(['endpoint_id', 'event_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) continue;
    await enqueueWebhookDelivery(trx, ctx, row.id);
    created++;
  }
  return created;
}
