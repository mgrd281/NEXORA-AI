# ADR-0015: SSRF protection for every user- or model-supplied host

- Status: Accepted
- Date: 2026-11-03

## Context

`web.fetch` fetches URLs from user requests, and SMTP connections take a user-supplied host. Without
controls, JARVIS could be used to reach cloud metadata endpoints (`169.254.169.254`), the database, or
internal services, and DNS rebinding could defeat a check-then-connect validation.

## Decision

- **Validate the address actually connected to.** Hostnames are resolved inside the socket's `lookup`
  hook; private and reserved addresses are filtered out there, and the connection uses the validated
  address. A DNS answer that changes between "check" and "connect" cannot bypass it.
  - `web.fetch`: `guardedLookup` / `isBlockedAddress` (`apps/api/src/modules/agent/tools/ssrf.ts`).
    IP-literal hosts never hit DNS and are checked directly (`checkTarget`).
  - SMTP: `assertPublicHost` (`apps/api/src/lib/net.ts`) resolves once and the transport connects to the
    vetted IP, keeping the hostname for TLS SNI and certificate validation.
- **Blocked ranges:** IPv4 `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4`;
  IPv6 `::, ::1, 64:ff9b::/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8`; IPv4-mapped
  and IPv4-compatible IPv6 are checked as their embedded IPv4 address. `web.fetch` additionally blocks
  `2001::/32` (Teredo), `2002::/16` (6to4) and `fec0::/10`. Anything that is not an IP is unsafe.
- **web.fetch extras:** `http`/`https` only; no credentials in URLs; every redirect re-validated (max
  5); 10 s timeout; 2 MB cap after decompression; content-type allow-list (HTML, XHTML, plain text,
  JSON).
- **SMTP extras:** ports 25/465/587/2525 only; TLS ≥ 1.2; plain-text SMTP refused except to localhost
  with `SMTP_ALLOW_INSECURE_LOCALHOST` in development.
- **Development allow-list:** `FETCH_ALLOW_PRIVATE_HOSTS=host:port,…` lets local fixture sites through
  (exact host _and_ port). `loadConfig` refuses to start in production if it or
  `SMTP_ALLOW_INSECURE_LOCALHOST` is set.

## Alternatives considered

- **Egress proxy with an allow/deny list** (e.g. Smokescreen). Strong defence in depth; planned for
  production deployments in addition to in-process checks, not instead of them.
- **Resolve, check, then connect by hostname.** Vulnerable to DNS rebinding. Rejected.
- **Allow-list of domains.** Incompatible with "read any public page".

## Consequences

- JARVIS cannot fetch intranet pages or use a mail server on a private network (by design for the
  hosted product).
- **Known issue at the time of writing:** `lib/net.ts` registers `::ffff:0:0/96` in the same
  `BlockList` as the IPv4 ranges; Node then matches _every_ IPv4 address, so `isPrivateAddress`
  classifies public IPv4 hosts as private. `web.fetch` is unaffected (it uses `tools/ssrf.ts`), but
  SMTP connections to a provider reachable only over IPv4 are refused until `lib/net.ts` is fixed. A
  failing-by-design test documents it (`test/unit/agent/net.test.ts`). See
  [known limitations](../known-limitations.md).
