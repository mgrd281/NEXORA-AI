import { describe, expect, it } from 'vitest';
import { ServerMessageKey, TaskErrorReason, type ServerMessage } from '@jarvis/contracts';
import { LOCALES } from '@/i18n/config';
import { argumentNames } from '@/i18n/icu';
import { catalogs } from '@/i18n/messages';
import {
  errorLine,
  errorReason,
  errorReasonCatalogKey,
  renderServerMessage,
  serverMessageCatalogKey,
  serverText,
} from '@/i18n/server-message';
import { createTranslator, lookup, stripIsolates } from '@/i18n/translate';
import { FSI, PDI } from '@/i18n/icu';
import {
  isUntrustedApproval,
  untrustedSourceFacts,
  untrustedSourceSentences,
} from '@/components/approvals/untrustedSource';

const i18n = (locale: (typeof LOCALES)[number]) => ({
  t: createTranslator(locale, catalogs[locale]),
  messages: catalogs[locale],
});

/** A sample value per parameter name (numbers where the copy uses a plural). */
const sample = (name: string): string | number =>
  ['count', 'seconds', 'max', 'limitMb', 'status', 'responseCode'].includes(name) ? 3 : `«${name}»`;

/**
 * Every key the server can send must have copy in every locale. The lists come from the Zod
 * enums in packages/contracts, so a key added there fails here until it is translated.
 */
describe('server message copy', () => {
  for (const locale of LOCALES) {
    it(`${locale} has every ServerMessageKey`, () => {
      const missing = ServerMessageKey.options.filter(
        (key) => lookup(catalogs[locale], serverMessageCatalogKey(key)) === undefined,
      );
      expect(missing).toEqual([]);
    });

    it(`${locale} has every TaskErrorReason`, () => {
      const missing = TaskErrorReason.options.filter(
        (reason) => lookup(catalogs[locale], errorReasonCatalogKey(reason)) === undefined,
      );
      expect(missing).toEqual([]);
    });

    it(`${locale} renders every key with its parameters filled in`, () => {
      const l = i18n(locale);
      for (const key of ServerMessageKey.options) {
        const template = lookup(catalogs[locale], serverMessageCatalogKey(key))!;
        const params = Object.fromEntries(argumentNames(template).map((n) => [n, sample(n)]));
        const text = renderServerMessage(l, { key, params });
        expect(text, `${locale}:${key}`).toBeTruthy();
        expect(text, `${locale}:${key}`).not.toMatch(/[{}]/);
      }
      for (const reason of TaskErrorReason.options) {
        const template = lookup(catalogs[locale], errorReasonCatalogKey(reason))!;
        const params = Object.fromEntries(argumentNames(template).map((n) => [n, sample(n)]));
        const text = errorReason(l, { reason, params });
        expect(text, `${locale}:${reason}`).toBeTruthy();
        expect(text, `${locale}:${reason}`).not.toMatch(/[{}]/);
      }
    });
  }
});

describe('renderServerMessage', () => {
  const de = i18n('de');
  const ar = i18n('ar');
  const en = i18n('en');

  it('renders in the viewer’s locale and isolates interpolated values', () => {
    const text = renderServerMessage(de, {
      key: 'plan.summarize',
      params: { host: 'example.com' },
    });
    expect(text).toBe(`${FSI}example.com${PDI} zusammenfassen`);
  });

  it('renders nested messages (recipients, declined actions) recursively', () => {
    const approval: ServerMessage = {
      key: 'approval.email',
      params: {
        subject: 'Summary: Q3',
        recipients: { key: 'approval.recipientsMany', params: { count: 4 } },
      },
    };
    const declined: ServerMessage = { key: 'result.declined', params: { action: approval } };
    expect(stripIsolates(renderServerMessage(ar, approval)!)).toBe(
      'إرسال البريد «Summary: Q3» إلى 4 مستلمين.',
    );
    const text = renderServerMessage(en, declined)!;
    expect(stripIsolates(text)).toBe(
      'You declined this, so nothing was sent or changed: Send the email “Summary: Q3” to 4 recipients.',
    );
    // The nested sentence is one isolate inside the outer one.
    expect(text).toContain(`${FSI}Send the email`);
  });

  it('names tools in the interface language', () => {
    expect(
      stripIsolates(
        renderServerMessage(de, {
          key: 'approval.generic',
          params: { title: { key: 'step.remember', params: {} }, tool: 'memory.save' },
        })!,
      ),
    ).toBe('„Im Gedächtnis speichern“ ausführen (Im Gedächtnis speichern).');
  });

  it('falls back to the stored text when there is no usable message', () => {
    expect(serverText(de, null, 'Stored')).toBe('Stored');
    expect(serverText(de, undefined, 'Stored')).toBe('Stored');
    expect(
      serverText(de, { key: 'plan.fromTheFuture' as ServerMessage['key'], params: {} }, 'Stored'),
    ).toBe('Stored');
    // A nested message that can't be rendered makes the whole sentence fall back.
    expect(
      serverText(
        de,
        {
          key: 'result.declined',
          params: { action: { key: 'nope' as ServerMessage['key'], params: {} } },
        },
        'Stored',
      ),
    ).toBe('Stored');
  });
});

describe('task errors', () => {
  const de = i18n('de');

  it('says the reason with its params, never the English message', () => {
    const error = {
      code: 'FETCH_BLOCKED' as const,
      message: 'Private address',
      retryable: false,
      reason: 'PRIVATE_ADDRESS' as const,
      params: { host: 'intranet.example' },
    };
    const line = stripIsolates(errorLine(de, error));
    expect(line).toBe(
      'intranet.example liegt in einem privaten oder lokalen Netzwerk, daher öffnet JARVIS es nicht.',
    );
    expect(line).not.toContain('Private address');
  });

  it('names the step in the viewer’s locale', () => {
    const line = errorReason(
      de,
      { reason: 'STEP_TIMEOUT', params: { step: 'Read example.com' } },
      { step: 'example.com lesen' },
    );
    expect(stripIsolates(line!)).toBe(
      '„example.com lesen“ hat zu lange gedauert und wurde gestoppt.',
    );
  });

  it('falls back to the code’s title without a reason', () => {
    expect(errorLine(de, { code: 'TOOL_TIMEOUT' })).toBe(catalogs.de.errors.codes.TOOL_TIMEOUT);
    expect(errorLine(de, { code: 'TOOL_TIMEOUT', reason: undefined, params: {} })).toBe(
      catalogs.de.errors.codes.TOOL_TIMEOUT,
    );
  });
});

describe('untrusted source facts', () => {
  const en = i18n('en');
  const approval = (untrusted?: {
    host: string | null;
    excludedSentences: number | null;
    signals: string[];
  }) => ({
    details: {
      kind: 'email' as const,
      from: 'a@example.com',
      to: ['a@example.com'],
      subject: 'S',
      body: 'B',
      ...(untrusted ? { untrusted } : {}),
    },
  });

  it('uses the approval’s own facts: the host and how many sentences were left out', () => {
    const facts = untrustedSourceFacts(
      undefined,
      approval({ host: 'example.com', excludedSentences: 2, signals: [] }),
    );
    expect(facts).toEqual({ host: 'example.com', leftOut: true, excludedSentences: 2 });
    const { title, outcome } = untrustedSourceSentences(en.t, facts);
    expect(stripIsolates(title)).toBe(
      'Text on example.com tried to give instructions to AI assistants.',
    );
    expect(outcome).toBe('JARVIS left those 2 sentences out of the summary.');
  });

  it('says only what is known without facts', () => {
    const facts = untrustedSourceFacts(undefined, approval());
    expect(facts).toEqual({ host: null, leftOut: null, excludedSentences: null });
    expect(untrustedSourceSentences(en.t, facts).outcome).toBeNull();
    expect(
      isUntrustedApproval({
        reasons: [],
        ...approval({ host: null, excludedSentences: null, signals: [] }),
      }),
    ).toBe(true);
    expect(isUntrustedApproval({ reasons: ['RISK_MEDIUM'], ...approval() })).toBe(false);
  });
});
