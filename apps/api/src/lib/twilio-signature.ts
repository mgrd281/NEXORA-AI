/**
 * Twilio request signatures (X-Twilio-Signature), as Twilio documents them for
 * webhooks with an application/x-www-form-urlencoded body: base64 of
 * HMAC-SHA1(authToken, url + concat(sorted(name) → name + value)), where `url`
 * is the full URL Twilio requested (scheme, host, path and query string) and the
 * parameters are sorted by name in case-sensitive byte order. A parameter that
 * occurs several times contributes each of its values, sorted.
 *
 * Phase D (docs/architecture/phase-d.md §3.3): every telephony webhook is
 * checked with verifyTwilioSignature before anything else happens. The URL is
 * rebuilt from PUBLIC_WEBHOOK_BASE_URL (never from the Host header, which a
 * proxy or an attacker controls). Like Twilio's own validator, the URL is also
 * accepted with the scheme's default port added or removed (some proxies
 * normalise it).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignedParams = Readonly<Record<string, string | readonly string[]>>;

/** The signature Twilio sends for this URL and these form parameters. */
export function twilioSignature(authToken: string, url: string, params: SignedParams): string {
  let data = url;
  for (const name of Object.keys(params).sort(byCodeUnit)) {
    const value = params[name]!;
    const values = typeof value === 'string' ? [value] : [...value].sort(byCodeUnit);
    for (const v of values) data += name + v;
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The URL with the scheme's default port written out, and without it. */
function portVariants(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [url];
  }
  const defaultPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : null;
  if (!defaultPort || (u.port && u.port !== defaultPort)) return [url];
  const rest = `${u.pathname}${u.search}`;
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
  return [
    `${u.protocol}//${auth}${u.hostname}${rest}`,
    `${u.protocol}//${auth}${u.hostname}:${defaultPort}${rest}`,
  ];
}

/** Constant-time check of an X-Twilio-Signature header against the expected signature. */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: SignedParams,
  signature: string | string[] | undefined,
): boolean {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 128)
    return false;
  const given = Buffer.from(signature);
  let ok = false;
  for (const candidate of portVariants(url)) {
    const expected = Buffer.from(twilioSignature(authToken, candidate, params));
    // Every variant is compared (no early exit), each in constant time.
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

/**
 * A form body as Twilio signs it: every parameter with all its values, in the
 * order received (the signature sorts them itself).
 */
export function formParams(body: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of body) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}
