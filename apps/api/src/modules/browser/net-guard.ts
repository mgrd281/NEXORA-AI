/**
 * Network allow-list of a browser session (docs/adr/0017, docs/adr/0015).
 *
 * Three independent layers, so no single mistake opens the network:
 *  1. Resolution pinning. Before Chromium starts, every host of the recipe's
 *     origins is resolved here and checked with the same classifier as every
 *     other outbound connection (lib/net.ts isPrivateAddress); private or
 *     reserved addresses are refused unless host:port is a configured dev
 *     fixture (BROWSER_ALLOW_PRIVATE_HOSTS, refused in production). Chromium's
 *     resolver is then given exactly those answers (`--host-resolver-rules`:
 *     MAP host → validated address, everything else ~NOTFOUND) — DNS
 *     rebinding cannot change what it connects to, and every other host
 *     (IP literals included) fails to resolve.
 *  2. A dead-end proxy. All traffic is sent to a local sinkhole that accepts
 *     and drops every connection, except exactly the allowed host:port pairs
 *     (proxy bypass list, implicit loopback bypass removed). This also covers
 *     redirect hops, which request interception does not see.
 *  3. Request interception (runner.ts): every request the page makes is
 *     checked against the allowed origins, counted, and aborted otherwise.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../../lib/net';

export interface AllowedOrigin {
  /** scheme://host[:port] as URL normalises it. */
  origin: string;
  protocol: 'http:' | 'https:';
  /** Host name or IP literal (IPv6 without brackets). */
  hostname: string;
  port: number;
  /** The validated address Chromium is pinned to (null for IP literals). */
  address: string | null;
}

export type ResolveResult =
  | { ok: true; allowed: AllowedOrigin[] }
  | { ok: false; host: string; why: 'invalid' | 'private' | 'unresolvable' };

export function defaultPort(u: URL): number {
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true });

/** Validates and pins every origin; the first refused one makes the whole session refuse. */
export async function resolveOrigins(
  origins: readonly string[],
  allowPrivate: ReadonlySet<string>,
  lookup: Lookup = systemLookup,
): Promise<ResolveResult> {
  const allowed: AllowedOrigin[] = [];
  for (const raw of origins) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, host: raw, why: 'invalid' };
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password)
      return { ok: false, host: u.host, why: 'invalid' };
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const port = defaultPort(u);
    const devAllowed = allowPrivate.has(`${hostname}:${port}`);
    if (isIP(hostname)) {
      if (isPrivateAddress(hostname) && !devAllowed)
        return { ok: false, host: u.host, why: 'private' };
      allowed.push({ origin: u.origin, protocol: u.protocol, hostname, port, address: null });
      continue;
    }
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(hostname);
    } catch {
      return { ok: false, host: u.host, why: 'unresolvable' };
    }
    const usable = addresses.filter(
      (a) => !isPrivateAddress(a.address) || devAllowed || allowPrivate.has(`${a.address}:${port}`),
    );
    // Any private answer for a public name is refused outright (a rebinding attempt).
    if (usable.length === 0 || (usable.length !== addresses.length && !devAllowed))
      return {
        ok: false,
        host: u.host,
        why: usable.length === 0 && addresses.length === 0 ? 'unresolvable' : 'private',
      };
    allowed.push({
      origin: u.origin,
      protocol: u.protocol,
      hostname,
      port,
      address: usable[0]!.address,
    });
  }
  return { ok: true, allowed };
}

const bracket = (host: string) => (host.includes(':') ? `[${host}]` : host);

/**
 * Chromium switches for layers 1 and 2: the resolver rules and the proxy bypass
 * list (Playwright's `proxy.bypass`, comma-separated).
 */
export function chromiumNetwork(allowed: readonly AllowedOrigin[]): {
  hostResolverRules: string;
  proxyBypass: string;
} {
  const rules: string[] = [];
  const excluded = new Set<string>();
  for (const a of allowed) {
    if (a.address) rules.push(`MAP ${a.hostname} ${bracket(a.address)}`);
    else excluded.add(a.hostname);
  }
  rules.push('MAP * ~NOTFOUND');
  for (const h of excluded) rules.push(`EXCLUDE ${bracket(h)}`);
  const bypass = ['<-loopback>', ...allowed.map((a) => `${bracket(a.hostname)}:${a.port}`)];
  return { hostResolverRules: rules.join(', '), proxyBypass: [...new Set(bypass)].join(',') };
}

/** Whether `raw` is an http(s) URL on one of the allowed origins (exact scheme, host and port). */
export function isAllowedUrl(raw: string, allowed: readonly AllowedOrigin[]): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  return allowed.some((a) => a.origin === u.origin);
}

/** Whether `raw` is on one of the exact origins (scheme://host:port) — no resolution. */
export function onOrigins(raw: string, origins: readonly string[]): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return origins.some((o) => {
      try {
        return new URL(o).origin === u.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* The sinkhole proxy (layer 2)                                        */
/* ------------------------------------------------------------------ */

let sinkhole: Promise<{ server: Server; port: number }> | null = null;

/**
 * A local TCP server that accepts and immediately drops every connection: the
 * "proxy" every non-allowed request is sent to. One per process, on an
 * ephemeral loopback port.
 */
export function sinkholeProxy(): Promise<{ server: Server; port: number }> {
  sinkhole ??= new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.destroy();
    });
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('sinkhole has no port'));
      resolve({ server, port: addr.port });
    });
  });
  return sinkhole;
}
