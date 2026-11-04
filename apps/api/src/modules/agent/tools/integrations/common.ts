/**
 * Shared pieces of the integrations tools (owner: integrations engineer):
 * which connected account a step uses (bind / requires / connectionOptions),
 * the connection at execution time, literal-or-reference fields, time
 * handling, and the request-language words of tool text results (content in
 * the request language, like i18n CONTENT; never server UI sentences).
 */
import type { ConnectionCapability, Evidence, Locale, OAuthProvider } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../../db/pool';
import { isValidTimeZone } from '../../../../lib/period';
import {
  connectionExpiredError,
  connectionMissingError,
  scopeMissingError,
} from '../../../integrations/tokens';
import type { ConnectionRef } from '../../../integrations/types';
import { localParts, zonedToUtc } from '../../../integrations/timezones';
import { hasTemplate } from '../../templates';
import { evidence, type BindContext, type ConnectionRequirement, type ToolRuntime } from '../types';

export const ProviderField = z
  .enum(['google', 'microsoft'])
  .optional()
  .describe('Which connected account (google or microsoft). Leave it out: JARVIS fills it in.');

/** A string that is a {{reference}} at planning time, or satisfies `check` once resolved. */
export const literalOrRef = (inner: z.ZodType<string>, what: string) =>
  z
    .string()
    .refine((s) => hasTemplate(s) || inner.safeParse(s).success, { message: `must be ${what}` });

const ISO_INSTANT = z.iso.datetime({ offset: true });
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** An instant with offset, a local "YYYY-MM-DDTHH:MM" (in the step's zone), a date, or a reference. */
export const TimeField = z
  .string()
  .max(64)
  .refine(
    (s) =>
      hasTemplate(s) || ISO_INSTANT.safeParse(s).success || LOCAL_TIME.test(s) || DATE_ONLY.test(s),
    { message: 'must be an ISO date-time (with offset), a local YYYY-MM-DDTHH:MM, or YYYY-MM-DD' },
  );

export const TimeZoneField = z
  .string()
  .max(64)
  .refine((tz) => isValidTimeZone(tz), { message: 'must be an IANA time zone' })
  .optional()
  .describe('IANA time zone, e.g. Europe/Berlin. Leave it out: the account’s zone is used.');

export const EmailField = literalOrRef(z.email().max(254), 'an email address');

/** A local time / date / instant → the instant, in `tz`. */
export function resolveTime(value: string, tz: string): Date {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return zonedToUtc(y, m, d, 0, 0, tz);
  }
  if (LOCAL_TIME.test(value)) {
    const [date, time] = value.split('T') as [string, string];
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const [hh, mm] = time.split(':').map(Number) as [number, number];
    return zonedToUtc(y, m, d, hh, mm, tz);
  }
  return new Date(value);
}

/** The ISO instant of a time field, or the field itself while it is still a reference. */
export const instantOf = (value: string, tz: string): string =>
  hasTemplate(value) ? value : resolveTime(value, tz).toISOString();

/* ------------------------------------------------------------------ */
/* Which account                                                       */
/* ------------------------------------------------------------------ */

export const optionsFor = (capability: ConnectionCapability): ConnectionRequirement[] => [
  { provider: 'google', capability },
  { provider: 'microsoft', capability },
];

export const requiresFor =
  (capability: ConnectionCapability) =>
  (input: { provider?: OAuthProvider }): ConnectionRequirement | null =>
    input.provider ? { provider: input.provider, capability } : null;

/**
 * The account a step uses, fixed at planning so the approval and its hash
 * bind it: the first active connection granting the capability (google
 * before microsoft), else an expired one that granted it (so the Policy
 * Engine explains CONNECTION_EXPIRED and a retry after reconnecting runs on
 * the same account); unchanged when there is none.
 */
export function bindProvider(
  capability: ConnectionCapability,
  ctx: BindContext,
): OAuthProvider | undefined {
  const oauth = ctx.connections.filter(
    (c) =>
      (c.provider === 'google' || c.provider === 'microsoft') &&
      c.capabilities.includes(capability),
  );
  const pick =
    oauth.find((c) => c.status === 'active') ?? oauth.find((c) => c.status === 'expired');
  return pick?.provider as OAuthProvider | undefined;
}

/** The provider an unbound step uses at execution (the same rule the approval shows). */
export function chosenProvider(
  provider: OAuthProvider | undefined,
  available: { has(p: OAuthProvider): boolean },
): OAuthProvider {
  if (provider) return provider;
  return available.has('google') ? 'google' : 'microsoft';
}

/** The connection a step runs on (active, granting `capability`), or the matching AgentError. */
export async function connectionFor(
  rt: ToolRuntime,
  provider: OAuthProvider | undefined,
  capability: ConnectionCapability,
): Promise<ConnectionRef & { capabilities: readonly ConnectionCapability[] }> {
  const chosen = chosenProvider(provider, { has: (p) => rt.connections.has(p) });
  const row = rt.connections.get(chosen);
  if (!row) {
    const state = await withContext(rt.db, rt.ctx, (trx) =>
      trx
        .selectFrom('connections')
        .select('status')
        .where('provider', '=', chosen)
        .where('status', '<>', 'revoked')
        .executeTakeFirst(),
    );
    throw state?.status === 'expired'
      ? connectionExpiredError(chosen)
      : connectionMissingError(chosen);
  }
  if (!row.capabilities.includes(capability)) throw scopeMissingError(chosen, capability);
  return {
    id: row.id,
    provider: chosen,
    accountIdentifier: row.account_identifier,
    capabilities: row.capabilities,
  };
}

/* ------------------------------------------------------------------ */
/* Text results (request language)                                     */
/* ------------------------------------------------------------------ */

const LOCALE_TAG: Record<Locale, string> = { en: 'en-GB', de: 'de-DE', ar: 'ar' };

export function formatWhen(
  start: string,
  end: string,
  tz: string,
  lang: Locale,
  allDay = false,
): string {
  const day = new Intl.DateTimeFormat(LOCALE_TAG[lang], {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  if (allDay) return day.format(new Date(start));
  const time = new Intl.DateTimeFormat(LOCALE_TAG[lang], {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const s = new Date(start);
  const e = new Date(end);
  const sameDay = localParts(s, tz).day === localParts(e, tz).day;
  return sameDay
    ? `${day.format(s)}, ${time.format(s)}–${time.format(e)}`
    : `${day.format(s)} ${time.format(s)} – ${day.format(e)} ${time.format(e)}`;
}

const WORDS = {
  noEmails: {
    en: 'No matching emails were found.',
    de: 'Es wurden keine passenden E-Mails gefunden.',
    ar: 'لم يتم العثور على رسائل مطابقة.',
  },
  emailsFound: {
    en: '{n} conversation(s):',
    de: '{n} Unterhaltung(en):',
    ar: 'عدد المحادثات: {n}',
  },
  nothingToRead: {
    en: 'There were no emails to read.',
    de: 'Es gab keine E-Mails zum Lesen.',
    ar: 'لم تكن هناك رسائل لقراءتها.',
  },
  noEvents: {
    en: 'There are no events in this period.',
    de: 'In diesem Zeitraum gibt es keine Termine.',
    ar: 'لا توجد أحداث في هذه الفترة.',
  },
  eventsFound: {
    en: '{n} event(s), times in {tz}:',
    de: '{n} Termin(e), Zeiten in {tz}:',
    ar: 'عدد الأحداث: {n}، الأوقات بتوقيت {tz}:',
  },
  freeTimes: {
    en: 'Free times for everyone ({minutes} minutes, {tz}):',
    de: 'Freie Zeiten für alle ({minutes} Minuten, {tz}):',
    ar: 'الأوقات المتاحة للجميع ({minutes} دقيقة، {tz}):',
  },
  notShared: {
    en: 'Not shared with you, so not taken into account: {who}.',
    de: 'Nicht für dich freigegeben und daher nicht berücksichtigt: {who}.',
    ar: 'غير مشارَك معك ولذلك لم يُؤخذ في الحسبان: {who}.',
  },
  allDay: { en: 'all day', de: 'ganztägig', ar: 'طوال اليوم' },
} as const satisfies Record<string, Record<Locale, string>>;

export function words(
  lang: Locale,
  key: keyof typeof WORDS,
  params: Record<string, string | number> = {},
): string {
  return WORDS[key][lang].replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? ''));
}

export function providerEvidence(
  provider: OAuthProvider,
  operation: string,
  status = 200,
): Evidence {
  return evidence(
    'provider_response',
    `${provider} ${operation}`,
    `HTTP ${status}`,
    'PROVIDER_RESPONSE',
    { provider, operation, status },
  );
}

/** The domain of an address (where flagged mail came from). */
export const domainOf = (address: string | undefined | null): string | null => {
  const d = (address ?? '').split('@')[1];
  return d ? d.toLowerCase() : null;
};
