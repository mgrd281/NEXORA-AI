import {
  ApiErrorReason,
  MissingInfo,
  NotificationKind,
  PolicyReason,
  ScheduleFrequency,
  SchedulePauseReason,
  ScheduleRunReason,
  ScheduleRunStatus,
  ScheduleStatus,
  SkillId,
  SkillUnavailableReason,
  WebhookDeliveryStatus,
  WebhookDisabledReason,
  WebhookEndpointStatus,
  WebhookFailureReason,
} from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/config';
import { argumentNames } from '@/i18n/icu';
import { catalogs } from '@/i18n/messages';
import { lookup } from '@/i18n/translate';

/** Reasons that only ever deny a step: they appear in the plan, never on an approval. */
const DENY_ONLY = new Set([
  'CONNECTION_MISSING',
  'MEMORY_DISABLED',
  'BUDGET_ZERO',
  'BUDGET_EXHAUSTED',
  'EXTERNAL_MODELS_DISABLED',
  'MODEL_UNAVAILABLE',
  // Phase C
  'CONNECTION_EXPIRED',
  'CONNECTION_SCOPE_MISSING',
  'PURCHASES_DISABLED',
  'PURCHASE_LIMIT',
  'PURCHASE_CURRENCY',
  // Phase D
  'DO_NOT_CALL',
  'CALL_OUTSIDE_HOURS',
  'CALL_LIMIT',
  'CALL_DESTINATION_BLOCKED',
  'TELEPHONY_NOT_CONFIGURED',
]);

const KEYS: Array<[string, readonly string[], (value: string) => string]> = [
  ['ApiErrorReason', ApiErrorReason.options, (r) => `errors.api.${r}`],
  ['SkillId (name)', SkillId.options, (id) => `skills.names.${id}`],
  ['SkillId (description)', SkillId.options, (id) => `skills.descriptions.${id}`],
  ['SkillUnavailableReason', SkillUnavailableReason.options, (r) => `skills.reasons.${r}`],
  ['MissingInfo', MissingInfo.options, (m) => `conversations.question.missing.${m}`],
  [
    'PolicyReason (approvals)',
    PolicyReason.options.filter((r) => !DENY_ONLY.has(r)),
    (r) => `approvals.reasons.${r}`,
  ],
  ['PolicyReason (plan)', PolicyReason.options, (r) => `tasks.policy.reasons.${r}`],
  ['NotificationKind', NotificationKind.options, (k) => `notifications.kinds.${k}`],
  [
    'NotificationKind (untitled)',
    NotificationKind.options,
    (k) => `notifications.kindsUntitled.${k}`,
  ],
  ['ScheduleStatus', ScheduleStatus.options, (s) => `schedules.status.${s}`],
  ['SchedulePauseReason', SchedulePauseReason.options, (r) => `schedules.pausedReason.${r}`],
  ['ScheduleRunStatus', ScheduleRunStatus.options, (s) => `schedules.history.run.${s}`],
  ['ScheduleRunReason', ScheduleRunReason.options, (r) => `schedules.history.reasons.${r}`],
  ['ScheduleFrequency', ScheduleFrequency.options, (f) => `schedules.editor.frequency.${f}`],
  [
    'ScheduleFrequency (interval)',
    ScheduleFrequency.options,
    (f) => `schedules.editor.intervalOption.${f}`,
  ],
  ['WebhookEndpointStatus', WebhookEndpointStatus.options, (s) => `webhooks.status.${s}`],
  ['WebhookDisabledReason', WebhookDisabledReason.options, (r) => `webhooks.disabledReason.${r}`],
  [
    'WebhookDeliveryStatus',
    WebhookDeliveryStatus.options,
    (s) => `webhooks.deliveries.status.${s}`,
  ],
  ['WebhookFailureReason', WebhookFailureReason.options, (r) => `webhooks.deliveries.reasons.${r}`],
];

/**
 * Every Phase B enum value the interface shows has copy in every language, with the same
 * parameters as the English sentence. The lists come from the Zod enums in packages/contracts,
 * so a value added there fails here until it is written (en/de/ar).
 */
describe('Phase B enum copy', () => {
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
});
