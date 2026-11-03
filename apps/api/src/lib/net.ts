/**
 * SSRF protection. Any outbound connection to a user- or model-supplied host
 * (web pages, SMTP servers) must resolve to a public address. We validate the
 * address we actually connect to (via a custom `lookup`), which also defeats
 * DNS rebinding between check and connect.
 */
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AppError } from './errors';

const blocked = new BlockList();
// IPv4 special-purpose ranges (RFC 6890 and friends)
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
// IPv6: unspecified, loopback, IPv4-mapped, NAT64, discard, docs, ULA, link-local, multicast
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP → treat as unsafe
}

/**
 * A `lookup` for http/https/net that refuses private addresses unless
 * `host:port` is explicitly allow-listed (development/test only).
 */
export function safeLookup(allowPrivate: Set<string>, port: number): LookupFunction {
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
      const usable = allowed ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (usable.length === 0) {
        const e = new AppError(
          'FETCH_BLOCKED',
          `Refusing to connect to a private or reserved address for ${hostname}`,
        );
        return callback(e as unknown as NodeJS.ErrnoException, '', 4);
      }
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (e: null, a: typeof usable) => void)(null, usable);
      return callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

/** Resolve once and assert public (for libraries that cannot take a custom lookup). */
export async function assertPublicHost(
  hostname: string,
  port: number,
  allowPrivate: Set<string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    safeLookup(allowPrivate, port)(hostname, { all: false }, (err, address) =>
      err ? reject(err) : resolve(address as string),
    );
  });
}
