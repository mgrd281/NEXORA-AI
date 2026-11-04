/** Webhook rows → contract. The secret (envelope or plaintext) never leaves the server here. */
import type { WebhookDelivery, WebhookEndpoint } from '@jarvis/contracts';
import type { WebhookDeliveryRow, WebhookEndpointRow } from '../../db/types';
import { webhookMessageId } from './signing';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Columns of an endpoint safe to read for display (no secret_ciphertext). */
export const ENDPOINT_COLUMNS = [
  'id',
  'url',
  'description',
  'event_types',
  'status',
  'disabled_reason',
  'secret_hint',
  'consecutive_failures',
  'last_delivery_at',
  'last_success_at',
  'last_failure_at',
  'created_at',
  'updated_at',
] as const;

export type EndpointView = Pick<WebhookEndpointRow, (typeof ENDPOINT_COLUMNS)[number]>;

export function toWebhookEndpoint(row: EndpointView): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types,
    status: row.status,
    disabledReason: row.disabled_reason,
    secretHint: row.secret_hint,
    consecutiveFailures: row.consecutive_failures,
    lastDeliveryAt: iso(row.last_delivery_at),
    lastSuccessAt: iso(row.last_success_at),
    lastFailureAt: iso(row.last_failure_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Delivery log columns (the payload is not part of the log view). */
export const DELIVERY_COLUMNS = [
  'id',
  'endpoint_id',
  'event_type',
  'status',
  'attempts',
  'max_attempts',
  'next_attempt_at',
  'last_attempt_at',
  'response_status',
  'failure_reason',
  'duration_ms',
  'created_at',
  'completed_at',
] as const;

export type DeliveryView = Pick<WebhookDeliveryRow, (typeof DELIVERY_COLUMNS)[number]>;

export function toWebhookDelivery(row: DeliveryView): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    webhookId: webhookMessageId(row.id),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: iso(row.next_attempt_at),
    lastAttemptAt: iso(row.last_attempt_at),
    responseStatus: row.response_status,
    failureReason: row.failure_reason,
    durationMs: row.duration_ms,
    createdAt: row.created_at.toISOString(),
    completedAt: iso(row.completed_at),
  };
}
