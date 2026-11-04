/**
 * SSRF guard for webhook endpoints (docs/architecture/phase-b.md §3.8, §5).
 * Checked when an endpoint is saved and again before every delivery attempt;
 * the delivery itself connects through webhookLookup, which re-checks the
 * address it actually connects to (DNS rebinding between check and connect).
 *
 *   https only — http only for WEBHOOK_ALLOW_INSECURE_HOSTS (development/test)
 *   no credentials, no fragment
 *   every resolved address public (lib/net isPrivateAddress) — allow-listed
 *   insecure hosts excepted (a local receiver in development)
 *
 * Failures throw AppError FETCH_BLOCKED with details.reason
 * WEBHOOK_URL_INVALID | WEBHOOK_URL_INSECURE | WEBHOOK_URL_BLOCKED { host }.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { ApiErrorReason } from '@jarvis/contracts';
import type { Config } from '../../config';
import { AppError } from '../../lib/errors';
import { isPrivateAddress, safeLookup } from '../../lib/net';

export type ResolveHost = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolve: ResolveHost = (host) => dnsLookup(host, { all: true, verbatim: true });

const blocked = (reason: ApiErrorReason, message: string, extra: Record<string, unknown> = {}) =>
  new AppError('FETCH_BLOCKED', message, { reason, ...extra });

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Hostname without IPv6 brackets. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/** Whether `host:port` is allow-listed for plain http and private addresses (never in production). */
export function isInsecureHostAllowed(url: URL, config: Pick<Config, 'webhookAllowInsecureHosts'>) {
  return config.webhookAllowInsecureHosts.has(`${bareHost(url)}:${portOf(url)}`);
}

/** Validates a webhook URL and resolves its host; returns the parsed URL. */
export async function checkWebhookUrl(
  raw: string,
  config: Pick<Config, 'webhookAllowInsecureHosts'>,
  opts: { resolve?: ResolveHost } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw blocked('WEBHOOK_URL_INVALID', 'Not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw blocked('WEBHOOK_URL_INVALID', 'Only https URLs are accepted');
  if (url.username || url.password)
    throw blocked('WEBHOOK_URL_INVALID', 'The URL must not contain credentials');
  if (raw.includes('#'))
    throw blocked('WEBHOOK_URL_INVALID', 'The URL must not contain a fragment');
  const host = bareHost(url);
  if (!host) throw blocked('WEBHOOK_URL_INVALID', 'The URL has no host');

  const allowed = isInsecureHostAllowed(url, config);
  if (url.protocol === 'http:' && !allowed)
    throw blocked('WEBHOOK_URL_INSECURE', 'Webhook URLs must use https');
  if (allowed) return url;

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await (opts.resolve ?? defaultResolve)(host)).map((a) => a.address);
    } catch {
      throw blocked('WEBHOOK_URL_INVALID', 'The host name could not be resolved', {
        host,
        cause: 'HOST_NOT_FOUND',
      });
    }
    if (addresses.length === 0)
      throw blocked('WEBHOOK_URL_INVALID', 'The host name could not be resolved', {
        host,
        cause: 'HOST_NOT_FOUND',
      });
  }
  // Any private or reserved address refuses the host (stricter than "some address is public").
  if (addresses.some((a) => isPrivateAddress(a)))
    throw blocked(
      'WEBHOOK_URL_BLOCKED',
      'Webhooks cannot be sent to private or reserved addresses',
      {
        host,
      },
    );
  return url;
}

/**
 * The `lookup` for the delivery connection: refuses private addresses at
 * connect time unless the host is allow-listed (DNS-rebinding safe).
 */
export function webhookLookup(
  url: URL,
  config: Pick<Config, 'webhookAllowInsecureHosts'>,
): LookupFunction {
  return safeLookup(config.webhookAllowInsecureHosts, portOf(url));
}

/** The host shown in audit records and notifications (never the path or query). */
export function webhookHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}
