/**
 * Phone numbers (Phase D, docs/architecture/phase-d.md §5): parsing and E.164
 * normalisation with libphonenumber's full metadata, the destinations JARVIS never
 * calls (toll fraud), masking for display, and the keyed hash the do-not-call list
 * stores instead of the number.
 *
 * Literalness: a number JARVIS dials must be written in the user's own request. A
 * number with its country code ("+49 30 1234567", "0049 30 …") is normalised as
 * written; a national number ("030 1234567") only with an explicit default region
 * (the country of the account's own phone number) — never guessed from the locale
 * or the time zone, which do not determine a country.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import {
  findPhoneNumbersInText,
  parsePhoneNumberFromString,
  type CountryCode,
  type NumberType,
} from 'libphonenumber-js/max';

export interface ParsedPhoneNumber {
  /** E.164, e.g. +493012345678. */
  e164: string;
  /** ISO 3166-1 alpha-2, or null for non-geographic numbers. */
  country: string | null;
  /** libphonenumber's number type; null when the metadata cannot tell. */
  type: NumberType | null;
  /** International format for reading, e.g. "+49 30 12345678". */
  international: string;
}

const REGION = /^[A-Z]{2}$/;
const asRegion = (r: string | null | undefined): CountryCode | undefined =>
  r && REGION.test(r) ? (r as CountryCode) : undefined;

/**
 * A valid number, or null. `defaultRegion` (ISO alpha-2) is used only for numbers
 * written without a country code.
 */
export function parsePhoneNumber(
  raw: string,
  defaultRegion?: string | null,
): ParsedPhoneNumber | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const text = raw.trim();
  const international = text.startsWith('+') || /^00[1-9]/.test(text);
  const region = asRegion(defaultRegion);
  if (!international && !region) return null;
  const p = parsePhoneNumberFromString(
    international ? text.replace(/^00/, '+') : text,
    international ? undefined : region,
  );
  if (!p || !p.isValid()) return null;
  return {
    e164: p.number,
    country: p.country ?? null,
    type: p.getType() ?? null,
    international: p.formatInternational(),
  };
}

/** The region (ISO alpha-2) of an E.164 number, or null. */
export function regionOfNumber(e164: string): string | null {
  return parsePhoneNumber(e164)?.country ?? null;
}

/**
 * Every valid number written in `text`, as E.164, in order of appearance, without
 * duplicates. National numbers count only with `defaultRegion`.
 */
export function phoneNumbersInText(text: string, defaultRegion?: string | null): string[] {
  const region = asRegion(defaultRegion);
  const found = new Set<string>();
  // "0049 30 …" is "+49 30 …" written with the international prefix 00 (ITU E.164 §6.2.1).
  const normalised = text.replace(/(^|[^\d+])00(?=[1-9]\d)/g, '$1+');
  for (const m of findPhoneNumbersInText(normalised, region ? { defaultCountry: region } : {})) {
    const p = m.number;
    if (!p.isValid()) continue;
    // Without a region only numbers written with their country code are literal.
    const written = normalised.slice(m.startsAt, m.endsAt).trim();
    if (!region && !written.startsWith('+') && !written.startsWith('00')) continue;
    found.add(p.number);
  }
  return [...found];
}

/**
 * Number types JARVIS never dials: they cost the caller (premium rate, shared cost),
 * forward to unknown parties (personal numbers, UAN), or are not people (pagers,
 * voicemail access). Emergency and other short codes are not valid E.164 numbers at all.
 */
export const BLOCKED_NUMBER_TYPES: ReadonlySet<NumberType> = new Set<NumberType>([
  'PREMIUM_RATE',
  'SHARED_COST',
  'PERSONAL_NUMBER',
  'PAGER',
  'UAN',
  'VOICEMAIL',
]);

export type DestinationCheck =
  { ok: true } | { ok: false; reason: 'invalid' | 'type' | 'country'; country: string | null };

/** Whether this server may call the number: a valid, non-blocked type in an allowed country. */
export function checkDestination(
  e164: string,
  allowedCountries: ReadonlySet<string>,
): DestinationCheck {
  const p = parsePhoneNumber(e164);
  if (!p || p.e164 !== e164) return { ok: false, reason: 'invalid', country: null };
  if (p.type && BLOCKED_NUMBER_TYPES.has(p.type))
    return { ok: false, reason: 'type', country: p.country };
  if (!p.country || !allowedCountries.has(p.country))
    return { ok: false, reason: 'country', country: p.country };
  return { ok: true };
}

/**
 * For display where the full number must not appear (do-not-call list, logs):
 * the country code, the first two national digits and the last two, e.g.
 * "+49 30 ••••• 78". Unparseable input is masked entirely but its last two digits.
 */
export function maskPhoneNumber(e164: string): string {
  const p = parsePhoneNumberFromString(e164);
  const digits = e164.replace(/\D/g, '');
  if (!p) return `+${'•'.repeat(Math.max(digits.length - 2, 1))}${digits.slice(-2)}`;
  const national = String(p.nationalNumber);
  const head = national.slice(0, Math.min(2, Math.max(national.length - 4, 0)));
  const hidden = '•'.repeat(Math.max(national.length - head.length - 2, 1));
  return `+${p.countryCallingCode} ${head ? `${head} ` : ''}${hidden} ${national.slice(-2)}`;
}

/**
 * The key of phone-number hashes, derived from SECRET_ENCRYPTION_KEY (HKDF-SHA256,
 * its own info string, so it is useless for anything else). Rotating the secret
 * key re-hashes the do-not-call list from its sealed numbers (runbook).
 */
export function phoneHashKey(secretKeyBase64: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secretKeyBase64, 'base64'),
      Buffer.alloc(0),
      'jarvis/phone-number-hash/v1',
      32,
    ),
  );
}

/** HMAC-SHA256 of an E.164 number: what do_not_call and call_sessions store for checks. */
export function phoneNumberHash(key: Buffer, e164: string): Buffer {
  return createHmac('sha256', key).update(`e164:${e164}`).digest();
}
