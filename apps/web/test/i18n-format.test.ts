import { describe, expect, it } from 'vitest';
import { dirFor, negotiateLocale, parseTheme } from '@/i18n/config';
import { createFormatters } from '@/i18n/format';
import { formatIcu } from '@/i18n/icu';
import { catalogs } from '@/i18n/messages';
import { createTranslator } from '@/i18n/translate';

const ctx = (tag: string) => {
  const nf = new Intl.NumberFormat(tag);
  return { plural: new Intl.PluralRules(tag), number: (n: number) => nf.format(n) };
};

describe('formatIcu', () => {
  it('interpolates and localizes numbers', () => {
    expect(formatIcu('Hello {name}, {n} new', { name: 'Layla', n: 1200 }, ctx('en-US'))).toBe(
      'Hello Layla, 1,200 new',
    );
    expect(formatIcu('{n}', { n: 1200 }, ctx('de-DE'))).toBe('1.200');
  });

  it('selects English plural forms and exact matches', () => {
    const msg = '{count, plural, =0 {none} one {# task} other {# tasks}}';
    expect(formatIcu(msg, { count: 0 }, ctx('en'))).toBe('none');
    expect(formatIcu(msg, { count: 1 }, ctx('en'))).toBe('1 task');
    expect(formatIcu(msg, { count: 5 }, ctx('en'))).toBe('5 tasks');
  });

  it('handles all six Arabic plural categories', () => {
    const msg = '{count, plural, zero {z} one {o} two {t} few {f #} many {m #} other {x #}}';
    const c = ctx('ar-u-nu-latn');
    expect(formatIcu(msg, { count: 0 }, c)).toBe('z');
    expect(formatIcu(msg, { count: 1 }, c)).toBe('o');
    expect(formatIcu(msg, { count: 2 }, c)).toBe('t');
    expect(formatIcu(msg, { count: 3 }, c)).toBe('f 3');
    expect(formatIcu(msg, { count: 11 }, c)).toBe('m 11');
    expect(formatIcu(msg, { count: 100 }, c)).toBe('x 100');
  });

  it('supports select and nesting', () => {
    const msg = '{kind, select, email {{n, plural, one {# email} other {# emails}}} other {item}}';
    expect(formatIcu(msg, { kind: 'email', n: 2 }, ctx('en'))).toBe('2 emails');
    expect(formatIcu(msg, { kind: 'web', n: 2 }, ctx('en'))).toBe('item');
  });

  it('leaves apostrophes alone', () => {
    expect(formatIcu("You’re all set, don't worry", {}, ctx('en'))).toBe(
      "You’re all set, don't worry",
    );
  });
});

describe('createTranslator', () => {
  it('translates nested keys with params in each locale', () => {
    expect(createTranslator('en', catalogs.en)('shell.tasksBadge', { count: 2 })).toBe(
      '2 approvals waiting',
    );
    expect(createTranslator('de', catalogs.de)('shell.tasksBadge', { count: 1 })).toBe(
      '1 Freigabe ausstehend',
    );
    expect(createTranslator('ar', catalogs.ar)('shell.tasksBadge', { count: 2 })).toBe(
      'موافقتان بانتظارك',
    );
    expect(createTranslator('ar', catalogs.ar)('shell.tasksBadge', { count: 5 })).toBe(
      '5 موافقات بانتظارك',
    );
  });

  it('returns the key for a missing message', () => {
    const t = createTranslator('en', catalogs.en);
    // @ts-expect-error — deliberately unknown key
    expect(t('nope.missing')).toBe('nope.missing');
  });
});

describe('formatters', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');

  it('formats relative time per locale', () => {
    expect(createFormatters('en', 'UTC').relative('2026-11-03T11:55:00Z', now)).toBe(
      '5 minutes ago',
    );
    expect(createFormatters('de', 'UTC').relative('2026-11-03T14:00:00Z', now)).toBe(
      'in 2 Stunden',
    );
    expect(createFormatters('en', 'UTC').relative('2026-11-03T11:59:40Z', now)).toBe('now');
    expect(createFormatters('en', 'UTC').relative('2026-11-02T12:00:00Z', now)).toBe('yesterday');
  });

  it('uses Western digits for Arabic', () => {
    expect(createFormatters('ar', 'UTC').number(1234)).toMatch(/1.?234/);
    expect(createFormatters('ar', 'UTC').relative('2026-11-03T11:55:00Z', now)).toMatch(/5/);
  });

  it('formats micro-dollars as USD, keeping sub-cent precision', () => {
    const f = createFormatters('en', 'UTC');
    expect(f.currency(0)).toBe('$0.00');
    expect(f.currency(1_250_000)).toBe('$1.25');
    expect(f.currency(4_200)).toBe('$0.0042');
    expect(createFormatters('de', 'UTC').currency(1_250_000)).toMatch(/^1,25\s\$$/u);
  });

  it('formats dates in the account time zone', () => {
    const berlin = createFormatters('en', 'Europe/Berlin').time('2026-11-03T12:00:00Z');
    const tokyo = createFormatters('en', 'Asia/Tokyo').time('2026-11-03T12:00:00Z');
    // ICU versions differ in the space before AM/PM (U+0020 or U+202F).
    expect(berlin).toMatch(/^1:00\sPM$/u);
    expect(tokyo).toMatch(/^9:00\sPM$/u);
  });

  it('ignores an invalid time zone instead of throwing', () => {
    expect(() => createFormatters('en', 'Not/AZone').date(now)).not.toThrow();
  });
});

describe('locale config', () => {
  it('negotiates from Accept-Language', () => {
    expect(negotiateLocale('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(negotiateLocale('fr-FR,ar;q=0.5')).toBe('ar');
    expect(negotiateLocale('fr-FR')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
    expect(negotiateLocale('en;q=0.2,de;q=0.9')).toBe('de');
  });

  it('maps direction and theme', () => {
    expect(dirFor('ar')).toBe('rtl');
    expect(dirFor('de')).toBe('ltr');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('neon')).toBe('system');
  });
});
