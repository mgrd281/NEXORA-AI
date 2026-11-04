import { describe, expect, it } from 'vitest';
import { approvalSentence } from '@/components/approvals/sentence';
import { createFormatters } from '@/i18n/format';
import { FSI, PDI } from '@/i18n/icu';
import { catalogs } from '@/i18n/messages';
import { createTranslator, stripIsolates, templateWithSlot } from '@/i18n/translate';

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * German speaks "du" across the product; headings, pills and buttons are impersonal. The formal
 * "Sie" form must not come back: no Ihr…/Ihnen, and a capitalised "Sie" only where it starts a
 * sentence (then it is the third person: "Sie erscheinen …" = "they appear …").
 */
describe('German form of address', () => {
  const de = leaves(catalogs.de);

  it('never uses the formal possessive or dative (Ihr…, Ihnen)', () => {
    const offenders = de.filter(([, value]) => /\b(Ihr\w*|Ihnen)\b/.test(value));
    expect(offenders.map(([key, value]) => `${key}: ${value}`)).toEqual([]);
  });

  it('uses a capitalised "Sie" only at the start of a sentence', () => {
    const offenders: string[] = [];
    for (const [key, value] of de) {
      for (const match of value.matchAll(/\bSie\b/g)) {
        const before = value.slice(0, match.index).trimEnd();
        // Start of the string or of an ICU branch, or after sentence-ending punctuation, a colon
        // (German capitalises a full sentence after it) or an opening quote.
        const sentenceStart = before === '' || /[.!?…:{„“"»(]$/.test(before);
        if (!sentenceStart) offenders.push(`${key}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('direction isolation in translated sentences', () => {
  const en = createTranslator('en', catalogs.en);
  const ar = createTranslator('ar', catalogs.ar);

  it('wraps interpolated strings in FSI…PDI so they keep their own direction', () => {
    const title = 'تذكّر: عيد ميلاد أختي';
    const message = en('notifications.kinds.task_completed', { taskTitle: title });
    expect(message).toBe(`“${FSI}${title}${PDI}” is done`);
    expect(stripIsolates(message)).toBe(`“${title}” is done`);
  });

  it('leaves numbers and plural selectors alone', () => {
    expect(en('shell.tasksBadge', { count: 2 })).toBe('2 approvals waiting');
    expect(ar('shell.tasksBadge', { count: 2 })).not.toContain(FSI);
  });

  it('finds a template slot so it can be selected', () => {
    const raw = en('composer.offline.templates.remember', {
      slot: en('composer.offline.slots.something'),
    });
    const { text, start, end } = templateWithSlot(raw);
    expect(text).toBe('Remember that something');
    expect(text.slice(start, end)).toBe('something');
  });

  it('builds the consent sentence in the interface language from the email details', () => {
    const approval = {
      summary: 'Sende die E-Mail „Zusammenfassung“ an owner@example.com.',
      details: {
        kind: 'email' as const,
        from: 'Layla <owner@example.com>',
        to: ['owner@example.com'],
        subject: 'Summary: Riverside Library',
        body: '…',
      },
    };
    const sentence = approvalSentence(approval, { t: ar, f: createFormatters('ar') });
    expect(sentence.localized).toBe(true);
    expect(stripIsolates(sentence.text)).toBe(
      'إرسال «Summary: Riverside Library» إلى owner@example.com',
    );
    const generic = approvalSentence(
      { summary: 'Do the thing.', details: { kind: 'generic', toolId: 'memory.save', fields: [] } },
      { t: en, f: createFormatters('en') },
    );
    expect(generic).toEqual({ text: 'Do the thing.', localized: false });
  });
});

describe('durations', () => {
  it('reads as words in Arabic prose and as LTR symbols in compact places', () => {
    const ar = createFormatters('ar');
    expect(ar.duration(107)).toBe('107 ملّي ثانية');
    expect(stripIsolates(ar.duration(107, 'compact'))).toBe('107\u00a0ms');
    expect(createFormatters('en').duration(65_000)).toBe('1 min 5 sec');
  });

  it('uses the international symbols in compact places, one decimal below 10 s', () => {
    const de = createFormatters('de');
    const ar = createFormatters('ar');
    const nb = (s: string) => s.replace(/ /g, '\u00a0');
    expect(de.duration(412, 'compact')).toBe(nb('412 ms'));
    expect(de.duration(1_890, 'compact')).toBe(nb('1,9 s'));
    expect(de.duration(999.7, 'compact')).toBe(nb('1 s'));
    expect(de.duration(9_960, 'compact')).toBe(nb('10 s'));
    expect(de.duration(65_000, 'compact')).toBe(`${nb('1 min')} ${nb('5 s')}`);
    expect(de.duration(3_900_000, 'compact')).toBe(`${nb('1 h')} ${nb('5 min')}`);
    // Arabic: Western digits, the same symbols, one LTR-isolated run; never "sec".
    expect(ar.duration(1_890, 'compact')).toBe(`\u2066${nb('1.9 s')}\u2069`);
    expect(stripIsolates(ar.duration(3_105, 'compact'))).toBe(nb('3.1 s'));
    expect(ar.duration(65_000, 'compact')).not.toMatch(/sec|min\b.*sec/);
  });
});
