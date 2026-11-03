import { describe, expect, it } from 'vitest';
import { findNul } from '../../../src/http/app';

describe('findNul', () => {
  it('finds U+0000 in values and keys at any depth and names the path', () => {
    expect(findNul({ request: 'a\u0000b' })).toBe('request');
    expect(findNul({ a: [{ b: 'ok' }, { c: 'x\u0000' }] })).toBe('a.1.c');
    expect(findNul({ prefs: { ['k\u0000']: true } })).toBe('prefs.k\\u0000');
    expect(findNul('plain\u0000text')).toBe('');
  });

  it('accepts text without NUL and non-string values', () => {
    expect(findNul({ a: 'Tea é 中 \u0001', n: 1, b: true, z: null, l: [1, 'x'] })).toBe(null);
    expect(findNul(undefined)).toBe(null);
  });

  it('does not exhaust the stack on deeply nested JSON', () => {
    const deep = JSON.parse(`${'['.repeat(100_000)}"x\\u0000"${']'.repeat(100_000)}`) as unknown;
    expect(findNul(deep)).toMatch(/^0(\.0)+$/);
  });
});
