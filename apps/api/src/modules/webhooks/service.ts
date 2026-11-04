/**
 * Webhook endpoint management (docs/architecture/phase-b.md §3.8). All inside
 * the caller's RLS-scoped transaction.
 *
 * Secrets: generated server-side (generateWebhookSecret, 256 bits), sealed
 * with SecretBox bound to user and endpoint (webhookSecretAad), returned in
 * plaintext exactly once — by create or rotate, neither of which is
 * idempotent, so the secret is never stored in idempotency_keys. Reads only
 * ever show the hint. Audit records carry the URL host only.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  WEBHOOK_LIMITS,
  type CreateWebhookRequest,
  type UpdateWebhookRequest,
  type WebhookEndpointWithSecret,
} from '@jarvis/contracts';
import type { Config } from '../../config';
import type { DbContext, Trx } from '../../db/pool';
import type { SecretBox } from '../../lib/crypto';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { buildWebhookPayload, enqueueWebhookDelivery } from './emit';
import {
  DELIVERY_COLUMNS,
  ENDPOINT_COLUMNS,
  toWebhookDelivery,
  toWebhookEndpoint,
  type EndpointView,
} from './mappers';
import { generateWebhookSecret, webhookSecretAad, webhookSecretHint } from './signing';
import { checkWebhookUrl, webhookHost, type ResolveHost } from './url';

export interface WebhookDeps {
  config: Pick<Config, 'webhookAllowInsecureHosts'>;
  secrets: SecretBox;
  /** DNS resolution override (tests). */
  resolve?: ResolveHost;
}

const endpointChanged = async (
  trx: Trx,
  ctx: DbContext,
  row: Pick<EndpointView, 'id' | 'status' | 'disabled_reason'> | null,
  endpointId: string,
  change: 'created' | 'updated' | 'secret_rotated' | 'deleted',
) =>
  appendEvent(trx, ctx, {
    taskId: null,
    type: 'webhook.endpoint_changed',
    data: {
      endpointId,
      change,
      status: row?.status ?? null,
      disabledReason: row?.disabled_reason ?? null,
    },
  });

/**
 * The SSRF check of an endpoint URL (DNS included). Routes run it before
 * opening the transaction, so no database connection waits on DNS.
 */
export function checkEndpointUrl(deps: WebhookDeps, raw: string): Promise<URL> {
  return checkWebhookUrl(raw, deps.config, { resolve: deps.resolve });
}

function sealSecret(deps: WebhookDeps, userId: string, endpointId: string) {
  const secret = generateWebhookSecret();
  return {
    secret,
    columns: {
      secret_ciphertext: deps.secrets.seal(secret, webhookSecretAad(userId, endpointId)),
      secret_key_id: deps.secrets.keyId,
      secret_hint: webhookSecretHint(secret),
    },
  };
}

async function loadEndpoint(trx: Trx, id: string, lock = false): Promise<EndpointView> {
  let q = trx.selectFrom('webhook_endpoints').select(ENDPOINT_COLUMNS).where('id', '=', id);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Webhook endpoint');
  return row;
}

export async function listWebhookEndpoints(trx: Trx, userId: string) {
  const rows = await trx
    .selectFrom('webhook_endpoints')
    .select(ENDPOINT_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toWebhookEndpoint);
}

export async function createWebhookEndpoint(
  trx: Trx,
  ctx: DbContext,
  deps: WebhookDeps,
  body: CreateWebhookRequest,
  /** body.url already checked (checkEndpointUrl) outside the transaction; checked here otherwise. */
  checked?: URL,
): Promise<WebhookEndpointWithSecret> {
  const url = checked ?? (await checkEndpointUrl(deps, body.url));
  // Per-user cap, serialised without row locks.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`webhooks:${ctx.userId}`}, 0))`.execute(
    trx,
  );
  const { n } = await trx
    .selectFrom('webhook_endpoints')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', ctx.userId)
    .executeTakeFirstOrThrow();
  if (Number(n) >= WEBHOOK_LIMITS.maxEndpointsPerUser) {
    throw new AppError('CONFLICT', 'Webhook endpoint limit reached', {
      reason: 'WEBHOOK_LIMIT_REACHED',
      max: WEBHOOK_LIMITS.maxEndpointsPerUser,
    });
  }
  const id = randomUUID();
  const { secret, columns } = sealSecret(deps, ctx.userId, id);
  const row = await trx
    .insertInto('webhook_endpoints')
    .values({
      id,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      url: url.toString(),
      description: body.description?.length ? body.description : null,
      event_types: body.eventTypes,
      ...columns,
    })
    .returning(ENDPOINT_COLUMNS)
    .executeTakeFirstOrThrow();
  await endpointChanged(trx, ctx, row, id, 'created');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'webhook.created',
    targetType: 'webhook_endpoint',
    targetId: id,
    metadata: { host: url.host, eventTypes: body.eventTypes },
  });
  return { endpoint: toWebhookEndpoint(row), secret };
}

export async function updateWebhookEndpoint(
  trx: Trx,
  ctx: DbContext,
  deps: WebhookDeps,
  id: string,
  body: UpdateWebhookRequest,
  /** body.url already checked outside the transaction; checked here otherwise. */
  checked?: URL,
) {
  const current = await loadEndpoint(trx, id, true);
  const set: {
    url?: string;
    description?: string | null;
    event_types?: CreateWebhookRequest['eventTypes'];
    status?: 'active' | 'disabled';
    disabled_reason?: 'user' | null;
    consecutive_failures?: number;
  } = {};
  const fields: string[] = [];
  if (body.url !== undefined) {
    const url = checked ?? (await checkEndpointUrl(deps, body.url));
    set.url = url.toString();
    fields.push('url');
  }
  if (body.description !== undefined) {
    set.description = body.description?.length ? body.description : null;
    fields.push('description');
  }
  if (body.eventTypes !== undefined) {
    set.event_types = body.eventTypes;
    fields.push('eventTypes');
  }
  if (body.enabled === false && current.status === 'active') {
    set.status = 'disabled';
    set.disabled_reason = 'user';
    fields.push('enabled');
  } else if (body.enabled === true && current.status === 'disabled') {
    set.status = 'active';
    set.disabled_reason = null;
    set.consecutive_failures = 0;
    fields.push('enabled');
  }
  if (fields.length === 0) return toWebhookEndpoint(current);
  const row = await trx
    .updateTable('webhook_endpoints')
    .set(set)
    .where('id', '=', id)
    .returning(ENDPOINT_COLUMNS)
    .executeTakeFirstOrThrow();
  await endpointChanged(trx, ctx, row, id, 'updated');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'webhook.updated',
    targetType: 'webhook_endpoint',
    targetId: id,
    metadata: { host: webhookHost(row.url), fields, status: row.status },
  });
  return toWebhookEndpoint(row);
}

export async function deleteWebhookEndpoint(trx: Trx, ctx: DbContext, id: string): Promise<void> {
  const row = await trx
    .deleteFrom('webhook_endpoints')
    .where('id', '=', id)
    .returning(['id', 'url'])
    .executeTakeFirst();
  if (!row) throw notFound('Webhook endpoint');
  await endpointChanged(trx, ctx, null, id, 'deleted');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'webhook.deleted',
    targetType: 'webhook_endpoint',
    targetId: id,
    metadata: { host: webhookHost(row.url) },
  });
}

/** A new secret replaces the old one immediately; returned once. */
export async function rotateWebhookSecret(
  trx: Trx,
  ctx: DbContext,
  deps: WebhookDeps,
  id: string,
): Promise<WebhookEndpointWithSecret> {
  await loadEndpoint(trx, id, true);
  const { secret, columns } = sealSecret(deps, ctx.userId, id);
  const row = await trx
    .updateTable('webhook_endpoints')
    .set(columns)
    .where('id', '=', id)
    .returning(ENDPOINT_COLUMNS)
    .executeTakeFirstOrThrow();
  await endpointChanged(trx, ctx, row, id, 'secret_rotated');
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'webhook.secret_rotated',
    targetType: 'webhook_endpoint',
    targetId: id,
    metadata: { host: webhookHost(row.url) },
  });
  return { endpoint: toWebhookEndpoint(row), secret };
}

/** Queues a signed webhook.test delivery to this endpoint only. */
export async function sendTestWebhook(trx: Trx, ctx: DbContext, id: string) {
  const endpoint = await loadEndpoint(trx, id);
  if (endpoint.status !== 'active') {
    throw new AppError('INVALID_STATE', 'The endpoint is disabled', { reason: 'WEBHOOK_DISABLED' });
  }
  const payload = buildWebhookPayload({
    type: 'webhook.test',
    data: { endpointId: id, test: true },
  });
  const row = await trx
    .insertInto('webhook_deliveries')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      endpoint_id: id,
      event_type: 'webhook.test',
      event_key: `webhook.test:${randomUUID()}`,
      payload: JSON.stringify(payload),
      max_attempts: WEBHOOK_LIMITS.maxAttempts,
    })
    .returning(DELIVERY_COLUMNS)
    .executeTakeFirstOrThrow();
  await enqueueWebhookDelivery(trx, ctx, row.id);
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'webhook.test_sent',
    targetType: 'webhook_endpoint',
    targetId: id,
    metadata: { host: webhookHost(endpoint.url), deliveryId: row.id },
  });
  return toWebhookDelivery(row);
}

export { DELIVERY_COLUMNS };
