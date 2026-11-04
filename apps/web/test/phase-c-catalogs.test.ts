import {
  ApprovalDetails,
  BookingStatus,
  BrowserSessionStatus,
  BrowserStopReason,
  ConnectionCapability,
  EmailWatchStatus,
  OrderStatus,
  ReliabilitySignalCode,
  VerificationCheckKey,
} from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/config';
import { argumentNames } from '@/i18n/icu';
import { catalogs } from '@/i18n/messages';
import { lookup } from '@/i18n/translate';
import { PHASE_C_EVIDENCE } from '@/features/tasks/model';
import { NextStep, hasNextStep } from '@/features/tasks/phase-c/NextStep';

const camel = (c: string) => c.replace(/\.(\w)/g, (_, x: string) => x.toUpperCase());
const KINDS = ApprovalDetails.options.map((o) => o.shape.kind.value);
const NEXT_STEPS = [
  'reconnect',
  'allow',
  'handover',
  'unsupported',
  'limit',
  'currency',
  'cart',
  'unknownOrder',
  'unconfirmedBooking',
] as const;

const KEYS: Array<[string, readonly string[], (value: string) => string]> = [
  [
    'ConnectionCapability (hint)',
    ConnectionCapability.options,
    (c) => `connections.oauth.hints.${camel(c)}`,
  ],
  [
    'ConnectionCapability (label)',
    ConnectionCapability.options,
    (c) => `common.capabilities.${camel(c)}`,
  ],
  ['ApprovalDetails kind (title)', [...KINDS, 'emailDraft'], (k) => `approvals.title.${k}`],
  ['ApprovalDetails kind (approve)', [...KINDS, 'emailDraft'], (k) => `approvals.approve.${k}`],
  [
    'ApprovalDetails kind (approve label)',
    [...KINDS, 'emailDraft'],
    (k) => `approvals.approveLabel.${k}`,
  ],
  [
    'ApprovalDetails kind (decline label)',
    [...KINDS, 'emailDraft'],
    (k) => `approvals.declineLabel.${k}`,
  ],
  ['EmailWatchStatus', EmailWatchStatus.options, (s) => `settings.replies.status.${s}`],
  ['BrowserSessionStatus', BrowserSessionStatus.options, (s) => `tasks.phaseC.sessionStatus.${s}`],
  ['BrowserStopReason', BrowserStopReason.options, (r) => `tasks.phaseC.stopReasons.${r}`],
  ['OrderStatus', OrderStatus.options, (s) => `tasks.phaseC.orderStatus.${s}`],
  ['BookingStatus', BookingStatus.options, (s) => `tasks.phaseC.bookingStatus.${s}`],
  ['ReliabilitySignalCode', ReliabilitySignalCode.options, (c) => `tasks.phaseC.signals.${c}`],
  ['VerificationCheckKey', VerificationCheckKey.options, (k) => `tasks.checks.${k}`],
  ['EvidenceCode (Phase C)', PHASE_C_EVIDENCE, (c) => `tasks.evidence.codes.${c}`],
  ['Next step titles', NEXT_STEPS, (k) => `tasks.nextStep.titles.${k}`],
];

/**
 * Every Phase C value the interface shows has copy in every language, with the same parameters
 * as the English sentence. The lists come from the contracts, so a value added there fails here
 * until it is written (en/de/ar).
 */
describe('Phase C enum copy', () => {
  for (const [name, values, keyOf] of KEYS) {
    it(`${name}: every value in every language, same parameters`, () => {
      const problems: string[] = [];
      for (const value of values) {
        const key = keyOf(value);
        const source = lookup(catalogs.en, key);
        if (source === undefined) {
          problems.push(`en: missing ${key}`);
          continue;
        }
        const params = argumentNames(source).sort();
        for (const locale of LOCALES) {
          const text = lookup(catalogs[locale], key);
          if (text === undefined) problems.push(`${locale}: missing ${key}`);
          else if (JSON.stringify(argumentNames(text).sort()) !== JSON.stringify(params))
            problems.push(`${locale}: ${key} has other parameters`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('the next-step component knows every kind it can return', () => {
    expect(typeof NextStep).toBe('function');
    expect(hasNextStep({ reason: 'CHECKOUT_UNSUPPORTED' })).toBe('cart');
    expect(hasNextStep({ reason: 'ORDER_UNKNOWN' })).toBe('unknownOrder');
    expect(hasNextStep({ reason: 'BOOKING_UNCONFIRMED' })).toBe('unconfirmedBooking');
    expect(hasNextStep({ reason: 'PURCHASE_CURRENCY' })).toBe('currency');
  });

  it('never calls an approval of an email draft “send”', () => {
    for (const locale of LOCALES) {
      const label = lookup(catalogs[locale], 'approvals.approve.emailDraft') ?? '';
      const send = lookup(catalogs[locale], 'approvals.approve.email') ?? '';
      expect(label).not.toEqual(send);
    }
  });
});
