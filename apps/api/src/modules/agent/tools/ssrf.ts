/**
 * SSRF guard for web.fetch: a DNS lookup that only yields public addresses
 * (classification lives in lib/net.ts) and fails with an agent-level
 * FETCH_BLOCKED error, which the executor reports on the step.
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isPrivateAddress } from '../../../lib/net';
import { AgentError } from '../errors';

/** Shared classifier (lib/net.ts) — one source of truth for every outbound connection. */
export const isBlockedAddress = isPrivateAddress;

/** English developer fallback; clients show copy for FETCH_BLOCKED / PRIVATE_ADDRESS. */
export const privateAddressError = (host: string) =>
  new AgentError('FETCH_BLOCKED', `Blocked a private, local or reserved address (${host}).`, {
    retryable: false,
    reason: 'PRIVATE_ADDRESS',
    params: { host },
  });

/**
 * `lookup` for http/https that only returns public addresses unless
 * `host:port` (or `address:port`) is allow-listed (development/test only).
 * The connection is made to the address validated here — DNS-rebinding safe.
 */
export function guardedLookup(allowPrivate: ReadonlySet<string>, port: number): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = (Array.isArray(addresses) ? addresses : [addresses]) as {
        address: string;
        family: number;
      }[];
      const allowed =
        allowPrivate.has(`${hostname}:${port}`) ||
        list.some((a) => allowPrivate.has(`${a.address}:${port}`));
      const usable = allowed ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (usable.length === 0)
        return callback(privateAddressError(hostname) as unknown as NodeJS.ErrnoException, '', 4);
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (e: null, a: typeof usable) => void)(null, usable);
      return callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}
