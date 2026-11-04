/**
 * A local webhook receiver for delivery tests: records every request (headers
 * and the exact body bytes) and answers with scripted statuses (default 200).
 * Bound to 127.0.0.1; tests allow-list it with WEBHOOK_ALLOW_INSECURE_HOSTS,
 * as a developer would for a local receiver.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface WebhookReceiver {
  port: number;
  url(path?: string): string;
  hostPort: string;
  received: ReceivedWebhook[];
  /** Statuses for the next requests, in order; then `fallback`. */
  respond(statuses: number[], fallback?: number): void;
  close(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  let queue: number[] = [];
  let fallback = 200;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const status = queue.length ? queue.shift()! : fallback;
      if (status >= 300 && status < 400)
        res.writeHead(status, { location: 'https://example.com/' });
      else res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status < 300 ? 'ok' : 'nope');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hostPort: `127.0.0.1:${port}`,
    url: (path = '/hook') => `http://127.0.0.1:${port}${path}`,
    received,
    respond(statuses, fb = 200) {
      queue = [...statuses];
      fallback = fb;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Standard Webhooks verification written from the specification
 * (https://www.standardwebhooks.com), independent of src/modules/webhooks:
 * signed content = `${webhook-id}.${webhook-timestamp}.${body}`, HMAC-SHA256
 * keyed with the base64-decoded secret after "whsec_", signatures
 * "v1,<base64>" separated by spaces, timestamp within the tolerance.
 */
export function verifyStandardWebhook(
  secret: string,
  headers: IncomingHttpHeaders,
  body: string,
  toleranceSeconds = 300,
): boolean {
  const id = String(headers['webhook-id'] ?? '');
  const ts = String(headers['webhook-timestamp'] ?? '');
  const sigs = String(headers['webhook-signature'] ?? '');
  if (!id || !/^\d+$/.test(ts) || !secret.startsWith('whsec_')) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSeconds) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(' ').some((s) => {
    const [version, value] = s.split(',');
    if (version !== 'v1' || !value) return false;
    const got = Buffer.from(value, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
