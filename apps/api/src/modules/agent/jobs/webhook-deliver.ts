/**
 * webhook.deliver — one delivery attempt (docs/architecture/phase-b.md §3.8).
 *
 *   1. (tx) lock the delivery; not pending → done; endpoint gone/disabled →
 *      failed ENDPOINT_DELETED / ENDPOINT_DISABLED; open the secret (SecretBox,
 *      AAD bound to user and endpoint).
 *   2. (no tx) POST the stored payload — the same bytes on every attempt —
 *      signed per Standard Webhooks (webhook-id stable across retries,
 *      webhook-timestamp of this attempt, webhook-signature v1 HMAC-SHA256).
 *      SSRF: checkWebhookUrl again, then a pinned lookup that re-validates the
 *      address actually connected to (DNS rebinding); no redirects (3xx is a
 *      failure); no user headers; WEBHOOK_LIMITS.timeoutSeconds; the response
 *      body is read up to maxResponseBytes and discarded, never stored.
 *   3. (tx) record: 2xx → succeeded, endpoint healthy. Otherwise, with
 *      attempts left (and a retryable reason) → next attempt after
 *      retryDelaysSeconds[n−1] (a new job, dedupe webhook:<id>:<n+1>);
 *      the last one → failed, endpoint consecutive_failures + 1, and at
 *      disableAfterFailedDeliveries the endpoint is disabled ('failures'),
 *      the user notified (webhook_disabled { endpointHost }).
 * Delivery is at least once (a crash between sending and recording repeats
 * the attempt); receivers dedupe on webhook-id. The job's own retries
 * (max 3) only cover worker crashes.
 */
import http from 'node:http';
import https from 'node:https';
import { WEBHOOK_LIMITS, type WebhookFailureReason } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../../db/pool';
import type { JobRow, WebhookDeliveryRow } from '../../../db/types';
import { AppError } from '../../../lib/errors';
import { metrics } from '../../../observability/metrics';
import { withSpan } from '../../../observability/tracing';
import { audit } from '../../audit/audit';
import { appendEvent } from '../../events/events';
import { createNotification } from '../../notifications/create';
import { enqueueWebhookDelivery } from '../../webhooks/emit';
import { webhookHeaders, webhookMessageId, webhookSecretAad } from '../../webhooks/signing';
import { checkWebhookUrl, webhookHost, webhookLookup } from '../../webhooks/url';
import { nowOf, type RuntimeDeps } from '../runtime';

const ctxOf = (job: JobRow): DbContext => ({ tenantId: job.tenant_id, userId: job.user_id });

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  reason: WebhookFailureReason | null;
  /** Worth another attempt (a private address or an invalid URL is not). */
  retryable: boolean;
  durationMs: number;
}

const fail = (
  reason: WebhookFailureReason,
  retryable: boolean,
  started: number,
  status: number | null = null,
): AttemptResult => ({ ok: false, status, reason, retryable, durationMs: Date.now() - started });

function classify(err: unknown, started: number): AttemptResult {
  if (err instanceof AppError) {
    const reason = (err.details as { reason?: string; cause?: string } | undefined) ?? {};
    if (err.code === 'FETCH_BLOCKED' && reason.cause === 'HOST_NOT_FOUND')
      return fail('HOST_NOT_FOUND', true, started);
    if (err.code === 'FETCH_BLOCKED' && reason.reason === 'WEBHOOK_URL_BLOCKED')
      return fail('PRIVATE_ADDRESS', false, started);
    // The lookup refused a private address at connect time (no details: lib/net).
    if (err.code === 'FETCH_BLOCKED' && !reason.reason)
      return fail('PRIVATE_ADDRESS', false, started);
    return fail('INTERNAL', false, started);
  }
  const e = err as { code?: string; name?: string };
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.code === 'ABORT_ERR')
    return fail('TIMEOUT', true, started);
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN')
    return fail('HOST_NOT_FOUND', true, started);
  if (e.code?.startsWith('ERR_TLS') || e.code?.includes('CERT') || e.code === 'EPROTO')
    return fail('TLS_CERTIFICATE', true, started);
  return fail('CONNECT_FAILED', true, started);
}

/** One POST. Never throws: every outcome is an AttemptResult. */
export async function postWebhook(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  opts: {
    config: RuntimeDeps['config'];
    signal?: AbortSignal;
  },
): Promise<AttemptResult> {
  const started = Date.now();
  let url: URL;
  try {
    url = await checkWebhookUrl(rawUrl, opts.config);
  } catch (err) {
    return classify(err, started);
  }
  const timeout = AbortSignal.timeout(WEBHOOK_LIMITS.timeoutSeconds * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise<AttemptResult>((resolve) => {
    let settled = false;
    const done = (r: AttemptResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = mod.request(
      url,
      {
        method: 'POST',
        agent: false,
        signal,
        lookup: webhookLookup(url, opts.config),
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          // Discarded either way; stop reading what nobody needs.
          if (read > WEBHOOK_LIMITS.maxResponseBytes) res.destroy();
        });
        const finish = () => {
          if (status >= 200 && status < 300)
            done({
              ok: true,
              status,
              reason: null,
              retryable: false,
              durationMs: Date.now() - started,
            });
          else if (status >= 300 && status < 400) done(fail('REDIRECT', true, started, status));
          else done(fail('HTTP_ERROR', true, started, status || null));
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    req.on('error', (err) => done(classify(err, started)));
    req.end(body);
  });
}

type Prepared = {
  delivery: WebhookDeliveryRow;
  url: string;
  secret: string;
};

async function finalize(
  trx: Parameters<Parameters<typeof withContext>[2]>[0],
  id: string,
  reason: WebhookFailureReason,
): Promise<void> {
  await trx
    .updateTable('webhook_deliveries')
    .set({
      status: 'failed',
      failure_reason: reason,
      completed_at: new Date(),
      next_attempt_at: null,
    })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .execute();
}

/**
 * Records an attempt's outcome on a still-pending delivery: success, the
 * next attempt, or the final failure (and the endpoint's failure count).
 */
export async function recordAttempt(
  deps: RuntimeDeps,
  ctx: DbContext,
  deliveryId: string,
  result: AttemptResult,
): Promise<'succeeded' | 'retry' | 'failed' | 'gone'> {
  const now = nowOf(deps);
  return withContext(deps.db, ctx, async (trx) => {
    const d = await trx
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .forUpdate()
      .executeTakeFirst();
    if (!d || d.status !== 'pending') return 'gone';
    const attempts = Math.min(d.attempts + 1, d.max_attempts);
    const common = {
      attempts,
      last_attempt_at: now,
      response_status: result.status,
      duration_ms: Math.max(0, Math.round(result.durationMs)),
    };
    if (result.ok) {
      await trx
        .updateTable('webhook_deliveries')
        .set({
          ...common,
          status: 'succeeded',
          failure_reason: null,
          next_attempt_at: null,
          completed_at: now,
        })
        .where('id', '=', d.id)
        .execute();
      await trx
        .updateTable('webhook_endpoints')
        .set({ last_delivery_at: now, last_success_at: now, consecutive_failures: 0 })
        .where('id', '=', d.endpoint_id)
        .execute();
      return 'succeeded';
    }
    const retry = result.retryable && attempts < d.max_attempts;
    const event = {
      endpointId: d.endpoint_id,
      deliveryId: d.id,
      eventType: d.event_type,
      reason: result.reason,
      attempts,
      final: !retry,
    };
    if (retry) {
      const delay =
        WEBHOOK_LIMITS.retryDelaysSeconds[attempts - 1] ??
        WEBHOOK_LIMITS.retryDelaysSeconds.at(-1)!;
      const next = new Date(now.getTime() + delay * 1000);
      await trx
        .updateTable('webhook_deliveries')
        .set({ ...common, failure_reason: result.reason, next_attempt_at: next })
        .where('id', '=', d.id)
        .execute();
      await trx
        .updateTable('webhook_endpoints')
        .set({ last_delivery_at: now, last_failure_at: now })
        .where('id', '=', d.endpoint_id)
        .execute();
      await enqueueWebhookDelivery(trx, ctx, d.id, { attempt: attempts + 1, runAt: next });
      await appendEvent(trx, ctx, { taskId: null, type: 'webhook.delivery_failed', data: event });
      return 'retry';
    }
    await trx
      .updateTable('webhook_deliveries')
      .set({
        ...common,
        status: 'failed',
        failure_reason: result.reason,
        next_attempt_at: null,
        completed_at: now,
      })
      .where('id', '=', d.id)
      .execute();
    const endpoint = await trx
      .updateTable('webhook_endpoints')
      .set((eb) => ({
        last_delivery_at: now,
        last_failure_at: now,
        consecutive_failures: eb('consecutive_failures', '+', 1),
      }))
      .where('id', '=', d.endpoint_id)
      .returningAll()
      .executeTakeFirst();
    await appendEvent(trx, ctx, { taskId: null, type: 'webhook.delivery_failed', data: event });
    if (
      endpoint &&
      endpoint.status === 'active' &&
      endpoint.consecutive_failures >= WEBHOOK_LIMITS.disableAfterFailedDeliveries
    ) {
      await trx
        .updateTable('webhook_endpoints')
        .set({ status: 'disabled', disabled_reason: 'failures' })
        .where('id', '=', endpoint.id)
        .execute();
      const host = webhookHost(endpoint.url);
      await createNotification(trx, ctx, 'webhook_disabled', null, { endpointHost: host });
      await appendEvent(trx, ctx, {
        taskId: null,
        type: 'webhook.endpoint_changed',
        data: {
          endpointId: endpoint.id,
          change: 'disabled',
          status: 'disabled',
          disabledReason: 'failures',
        },
      });
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'system',
        actorId: null,
        action: 'webhook.disabled',
        targetType: 'webhook_endpoint',
        targetId: endpoint.id,
        metadata: { reason: 'failures', host, consecutiveFailures: endpoint.consecutive_failures },
      });
    }
    return 'failed';
  });
}

export async function handleWebhookDeliverJob(deps: RuntimeDeps, job: JobRow): Promise<'done'> {
  const deliveryId = typeof job.payload.deliveryId === 'string' ? job.payload.deliveryId : null;
  if (!deliveryId) return 'done';
  const ctx = ctxOf(job);
  const prepared = await withContext(deps.db, ctx, async (trx): Promise<Prepared | null> => {
    const d = await trx
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .forUpdate()
      .executeTakeFirst();
    if (!d || d.status !== 'pending') return null;
    const endpoint = await trx
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', d.endpoint_id)
      .executeTakeFirst();
    if (!endpoint) {
      await finalize(trx, d.id, 'ENDPOINT_DELETED');
      return null;
    }
    if (endpoint.status !== 'active') {
      await finalize(trx, d.id, 'ENDPOINT_DISABLED');
      return null;
    }
    let secret: string;
    try {
      secret = deps.secrets.open(
        endpoint.secret_ciphertext,
        webhookSecretAad(ctx.userId, endpoint.id),
      );
    } catch {
      deps.log.error('webhook secret could not be opened', { endpointId: endpoint.id });
      await finalize(trx, d.id, 'INTERNAL');
      return null;
    }
    return { delivery: d, url: endpoint.url, secret };
  });
  if (!prepared) return 'done';

  // The stored payload, serialised the same way for every attempt.
  const body = JSON.stringify(prepared.delivery.payload);
  const nowSeconds = Math.floor(nowOf(deps).getTime() / 1000);
  const headers = {
    ...webhookHeaders(prepared.secret, webhookMessageId(prepared.delivery.id), nowSeconds, body),
    'content-type': 'application/json',
    'user-agent': `JARVIS-Webhooks/${deps.config.APP_VERSION}`,
  };
  const result = await withSpan(
    'webhook.deliver',
    {
      'jarvis.webhook.event_type': prepared.delivery.event_type,
      'jarvis.webhook.attempt': prepared.delivery.attempts + 1,
    },
    () => postWebhook(prepared.url, headers, body, { config: deps.config, signal: deps.signal }),
  );
  // Lease lost mid-request: the worker that owns the job now repeats the attempt.
  if (deps.signal?.aborted) return 'done';
  const outcome = await recordAttempt(deps, ctx, prepared.delivery.id, result);
  if (outcome !== 'gone') metrics.webhookDelivery(outcome);
  deps.log.info('webhook delivery attempt', {
    deliveryId: prepared.delivery.id,
    outcome,
    status: result.status,
    reason: result.reason,
  });
  return 'done';
}

/** A delivery job that kept crashing counts as one failed attempt (INTERNAL). */
export async function onWebhookDeliverDead(deps: RuntimeDeps, job: JobRow): Promise<void> {
  const deliveryId = typeof job.payload.deliveryId === 'string' ? job.payload.deliveryId : null;
  if (!deliveryId) return;
  await recordAttempt(deps, ctxOf(job), deliveryId, {
    ok: false,
    status: null,
    reason: 'INTERNAL',
    retryable: true,
    durationMs: 0,
  });
}
