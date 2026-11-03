import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../../../src/lib/net';
import type { AgentError } from '../../../src/modules/agent/errors';
import { isBlockedAddress } from '../../../src/modules/agent/tools/ssrf';
import { checkTarget } from '../../../src/modules/agent/tools/web-fetch';

const PRIVATE = [
  '127.0.0.1',
  '10.1.2.3',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254', // cloud metadata
  '100.64.0.1', // CGNAT
  '0.0.0.0',
  '224.0.0.1',
  '255.255.255.255',
  '::1',
  '::',
  'fe80::1',
  'fc00::1',
  'fd12:3456::1',
  '::ffff:127.0.0.1', // IPv4-mapped loopback
  '::ffff:169.254.169.254',
  '::FFFF:10.0.0.1',
  '64:ff9b::7f00:1', // NAT64
  'not-an-ip',
];

const PUBLIC = [
  '8.8.8.8',
  '1.1.1.1',
  '100.128.0.1',
  '172.32.0.1',
  '2606:4700:4700::1111',
  '::ffff:8.8.8.8',
];

describe('isBlockedAddress (web.fetch SSRF guard)', () => {
  it.each([
    ...PRIVATE,
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '2002:7f00:1::',
    '2001:0:1::1',
  ])('%s is private/reserved', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each([...PUBLIC, '::ffff:808:808'])('%s is public', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('lib/net isPrivateAddress (shared foundation)', () => {
  it.each(PRIVATE)('%s is private/reserved', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  // Known foundation bug (reported to the integrator): the ::ffff:0:0/96 entry in
  // lib/net's BlockList makes node:net match every IPv4 address, so public IPv4
  // hosts are classified as private. web.fetch uses tools/ssrf.ts instead. This
  // test starts failing once lib/net is fixed — then delete it and delegate.
  it.fails('classifies public IPv4 addresses as public (fails until lib/net is fixed)', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('web.fetch target checks', () => {
  const none = new Set<string>();
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as AgentError).code;
    }
    return null;
  };

  it('blocks private IP literals unless allow-listed with the exact port', () => {
    expect(code(() => checkTarget('http://127.0.0.1:8080/x', none))).toBe('FETCH_BLOCKED');
    expect(code(() => checkTarget('http://169.254.169.254/latest/meta-data', none))).toBe(
      'FETCH_BLOCKED',
    );
    expect(code(() => checkTarget('http://[::1]:80/', none))).toBe('FETCH_BLOCKED');
    expect(code(() => checkTarget('http://[::ffff:127.0.0.1]/', none))).toBe('FETCH_BLOCKED');
    expect(code(() => checkTarget('http://0x7f000001/', none))).toBe('FETCH_BLOCKED'); // URL normalises to 127.0.0.1
    expect(
      code(() => checkTarget('http://127.0.0.1:8080/x', new Set(['127.0.0.1:8080']))),
    ).toBeNull();
    expect(code(() => checkTarget('http://127.0.0.1:8081/x', new Set(['127.0.0.1:8080'])))).toBe(
      'FETCH_BLOCKED',
    );
  });

  it('allows public IP literals', () => {
    expect(code(() => checkTarget('http://8.8.8.8/', none))).toBeNull();
  });

  it('allows only http(s) without credentials', () => {
    expect(code(() => checkTarget('file:///etc/passwd', none))).toBe('FETCH_BLOCKED');
    expect(code(() => checkTarget('ftp://example.com/x', none))).toBe('FETCH_BLOCKED');
    expect(code(() => checkTarget('https://user:pw@example.com/', none))).toBe('FETCH_BLOCKED');
    expect(code(() => checkTarget('not a url', none))).toBe('VALIDATION_FAILED');
    expect(code(() => checkTarget('https://example.com/a?b=1', none))).toBeNull();
  });
});
