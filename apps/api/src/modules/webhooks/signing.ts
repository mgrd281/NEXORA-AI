/**
 * Standard Webhooks signing (https://www.standardwebhooks.com) — the wire
 * protocol of JARVIS's outbound webhooks. FROZEN in Phase B stage 1
 * (docs/architecture/phase-b.md §3.8): receivers verify exactly this.
 *
 *   webhook-id         msg_<delivery id>      (identical on every attempt)
 *   webhook-timestamp  Unix seconds of the attempt
 *   webhook-signature  v1,<base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`))>
 *   key                base64-decoded secret after the whsec_ prefix (32 random bytes)
 *
 * Receivers reject a timestamp further than WEBHOOK_LIMITS.toleranceSeconds
 * from their clock (replay window) and dedupe on webhook-id. The secret is
 * shown to the user once (create / rotate) and stored only as a SecretBox
 * envelope (AAD webhookSecretAad).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_ID_PREFIX, WEBHOOK_LIMITS, WEBHOOK_SECRET_PREFIX } from '@jarvis/contracts';

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/** A new endpoint secret: whsec_ + base64 of 32 random bytes. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
}

/** "whsec_…x7Qa": enough to recognise a secret, never enough to use it. */
export function webhookSecretHint(secret: string): string {
  return `${WEBHOOK_SECRET_PREFIX}…${secret.slice(-4)}`;
}

/** SecretBox AAD of an endpoint's secret: binds the envelope to its owner and endpoint. */
export function webhookSecretAad(userId: string, endpointId: string): string {
  return `webhook:${userId}:${endpointId}`;
}

/** The webhook-id of a delivery (stable across retries, so receivers can dedupe). */
export function webhookMessageId(deliveryId: string): string {
  return `${WEBHOOK_ID_PREFIX}${deliveryId}`;
}

function secretKey(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new Error('Not a webhook secret');
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (key.length < 24) throw new Error('Webhook secret is too short');
  return key;
}

/** The webhook-signature value for one attempt. `body` must be the exact bytes sent. */
export function signWebhook(
  secret: string,
  messageId: string,
  timestampSeconds: number,
  body: string,
): string {
  const mac = createHmac('sha256', secretKey(secret))
    .update(`${messageId}.${timestampSeconds}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

/** The three headers of one attempt. */
export function webhookHeaders(
  secret: string,
  messageId: string,
  timestampSeconds: number,
  body: string,
): WebhookHeaders {
  return {
    'webhook-id': messageId,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': signWebhook(secret, messageId, timestampSeconds, body),
  };
}

/**
 * Receiver-side check (tests, the eval harness, and documentation for users):
 * a valid v1 signature among the space-separated signatures, and a timestamp
 * within the tolerance.
 */
export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const ts = Number(headers['webhook-timestamp']);
  if (!Number.isInteger(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? WEBHOOK_LIMITS.toleranceSeconds)) return false;
  const expected = Buffer.from(signWebhook(secret, headers['webhook-id'], ts, body));
  return headers['webhook-signature'].split(' ').some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
