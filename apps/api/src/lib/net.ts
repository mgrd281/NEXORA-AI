/**
 * SSRF protection. Any outbound connection to a user- or model-supplied host
 * (web pages, SMTP servers) must resolve to a public address. We validate the
 * address we actually connect to (via a custom `lookup`), which also defeats
 * DNS rebinding between check and connect.
 */
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AppError } from './errors';

// Special-purpose ranges (RFC 6890 and friends). IPv4 and IPv6 live in separate
// BlockLists: a single list would apply an IPv4-mapped IPv6 rule (::ffff:0:0/96)
// to every plain IPv4 address. Mapped/compatible IPv6 is checked via its embedded
// IPv4 address instead; 6to4 and Teredo are blocked because they can embed one.
const v4 = new BlockList();
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
  v4.addSubnet(net, prefix, 'ipv4');

const v6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  v6.addSubnet(net, prefix, 'ipv6');

/** Expands an IPv6 address to 8 numeric groups (handles :: and a trailing dotted quad). */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    s = `${s.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => Number.isNaN(n) || n > 0xffff) ? null : nums;
}

/** True for private, loopback, link-local, reserved, multicast and non-IP input. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4.check(ip, 'ipv4');
  if (family !== 6) return true;
  const g = expandIpv6(ip);
  if (!g) return true;
  const embeddedV4 =
    g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0) // ::ffff:a.b.c.d or ::a.b.c.d
      ? `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`
      : null;
  if (embeddedV4 && !(g[5] === 0 && g[6] === 0 && g[7]! <= 1)) return v4.check(embeddedV4, 'ipv4');
  return v6.check(ip, 'ipv6');
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
