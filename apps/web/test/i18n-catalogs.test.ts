import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@jarvis/contracts';
import { catalogs } from '@/i18n/messages';
import { LOCALES } from '@/i18n/config';
import { argumentNames, formatIcu } from '@/i18n/icu';

/** Every dotted leaf path of a nested catalog. */
function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

const en = catalogs.en;
const namespaces = Object.keys(en) as Array<keyof typeof en>;

describe('message catalogs', () => {
  it('has the agreed namespaces', () => {
    expect(namespaces.sort()).toEqual(
      [
        'admin',
        'approvals',
        'auth',
        'common',
        'composer',
        'connections',
        'errors',
        'home',
        'memory',
        'notifications',
        'settings',
        'shell',
        'tasks',
        'voice',
      ].sort(),
    );
  });

  for (const locale of LOCALES) {
    for (const ns of namespaces) {
      it(`${locale}/${ns} has exactly the same keys as en/${ns}`, () => {
        const expected = leafPaths(en[ns]).sort();
        const actual = leafPaths(catalogs[locale][ns]).sort();
        expect(actual).toEqual(expected);
      });
    }
  }

  it('has no empty strings', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(catalogs[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('uses the same placeholders in every locale', () => {
    const placeholders = argumentNames;
    const enLeaves = new Map(leaves(en));
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(catalogs[locale])) {
        expect(placeholders(value), `${locale}:${key}`).toEqual(
          placeholders(enLeaves.get(key) ?? ''),
        );
      }
    }
  });

  it('has balanced braces and parses in every locale', () => {
    const ctx = { plural: new Intl.PluralRules('en'), number: (n: number) => String(n) };
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(catalogs[locale])) {
        let depth = 0;
        for (const ch of value) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
          expect(depth, `${locale}:${key}`).toBeGreaterThanOrEqual(0);
        }
        expect(depth, `${locale}:${key}`).toBe(0);
        expect(() => formatIcu(value, { count: 3, completed: 1, total: 2 }, ctx)).not.toThrow();
      }
    }
  });

  it('has a friendly message for every API error code', () => {
    for (const locale of LOCALES) {
      for (const code of ErrorCode.options) {
        expect(catalogs[locale].errors.codes[code], `${locale}:${code}`).toBeTruthy();
      }
    }
  });

  it('gives Arabic plurals every CLDR category it needs', () => {
    const arPlurals = leaves(catalogs.ar).filter(([, v]) => /,\s*plural,/.test(v));
    expect(arPlurals.length).toBeGreaterThan(0);
    for (const [key, value] of arPlurals) {
      // =0 may stand in for zero.
      for (const category of ['one', 'two', 'few', 'many', 'other']) {
        expect(value, `ar:${key} lacks ${category}`).toMatch(new RegExp(`\\b${category}\\s*\\{`));
      }
      expect(value, `ar:${key} lacks zero`).toMatch(/(\bzero|=0)\s*\{/);
    }
  });
});
