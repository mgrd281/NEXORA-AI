/**
 * Phase D shared libraries and configuration (docs/architecture/phase-d.md §5, §8): phone
 * numbers (E.164 normalisation, literal extraction, blocked destinations, masking, keyed
 * hashes), Twilio request signatures (the documented algorithm, Twilio's own test vector),
 * the telephony configuration with its production guards, and the voice preference merge.
 */
import { DEFAULT_PREFERENCES } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { BROWSER_WORKER_FORBIDDEN_ENV, loadConfig, TWILIO_API_BASE } from '../../../src/config';
import { localTimeOfDay } from '../../../src/lib/period';
import {
  checkDestination,
  maskPhoneNumber,
  parsePhoneNumber,
  phoneHashKey,
  phoneNumberHash,
  phoneNumbersInText,
} from '../../../src/lib/phone';
import {
  formParams,
  twilioSignature,
  verifyTwilioSignature,
} from '../../../src/lib/twilio-signature';
import { mergePreferences, profilePhoneNumber } from '../../../src/modules/account/routes';

describe('phone numbers', () => {
  it('normalise to E.164 only when the country is written or explicitly given', () => {
    expect(parsePhoneNumber('+49 30 1234567')?.e164).toBe('+49301234567');
    expect(parsePhoneNumber('0049 30 1234567')?.e164).toBe('+49301234567');
    expect(parsePhoneNumber('030 1234567')).toBeNull();
    expect(parsePhoneNumber('030 1234567', 'DE')?.e164).toBe('+49301234567');
    expect(parsePhoneNumber('112', 'DE')).toBeNull(); // emergency and short codes are not numbers
    expect(parsePhoneNumber('+49 30')).toBeNull();
  });

  it('finds the numbers a request contains (en / de / ar, Arabic-Indic digits too)', () => {
    expect(phoneNumbersInText('Call my dentist on +49 30 1234567 tomorrow at 10:30')).toEqual([
      '+49301234567',
    ]);
    expect(phoneNumbersInText('Ruf 0049 151 12345678 an, Termin am 10.11.2026')).toEqual([
      '+4915112345678',
    ]);
    expect(phoneNumbersInText('اتصل بالرقم +٩٦٦١١٢٣٤٥٦٧٨ غدًا')).toEqual(['+966112345678']);
    expect(phoneNumbersInText('ruf 030 7654321 an')).toEqual([]);
    expect(phoneNumbersInText('ruf 030 7654321 an', 'DE')).toEqual(['+49307654321']);
  });

  it('never dials premium-rate / shared-cost numbers or countries this server does not call', () => {
    const de = new Set(['DE']);
    expect(checkDestination('+49301234567', de)).toEqual({ ok: true });
    expect(checkDestination('+499001234567', de)).toMatchObject({ ok: false, reason: 'type' });
    expect(checkDestination('+19005550123', new Set(['US']))).toMatchObject({
      ok: false,
      reason: 'type',
    });
    expect(checkDestination('+442079460958', de)).toMatchObject({ ok: false, reason: 'country' });
    expect(checkDestination('+49 30 1234567', de)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('masks for display and hashes with a key derived for this purpose only', () => {
    const masked = maskPhoneNumber('+493012345678');
    expect(masked.startsWith('+49 30 ')).toBe(true);
    expect(masked.endsWith(' 78')).toBe(true);
    expect(masked).not.toMatch(/123456/);
    const key = phoneHashKey(Buffer.alloc(32, 9).toString('base64'));
    const other = phoneHashKey(Buffer.alloc(32, 8).toString('base64'));
    expect(phoneNumberHash(key, '+493012345678')).toHaveLength(32);
    expect(
      phoneNumberHash(key, '+493012345678').equals(phoneNumberHash(key, '+493012345678')),
    ).toBe(true);
    expect(
      phoneNumberHash(key, '+493012345678').equals(phoneNumberHash(other, '+493012345678')),
    ).toBe(false);
    // Not the secret key itself.
    expect(key.equals(Buffer.alloc(32, 9))).toBe(false);
  });

  it('the profile number must be a real number of a type JARVIS would put a callee through to', () => {
    expect(profilePhoneNumber('+4915112345678')).toBe('+4915112345678');
    expect(() => profilePhoneNumber('+491')).toThrow();
    expect(() => profilePhoneNumber('+499001234567')).toThrow(/does not use numbers/);
  });
});

describe('Twilio request signatures', () => {
  // twilio-node's own test vector (webhooks.spec): token 12345, this URL and these parameters.
  const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const PARAMS = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675309',
    Digits: '1234',
    From: '+14158675309',
    To: '+18005551212',
  };

  it('match Twilio’s documented algorithm', () => {
    expect(twilioSignature('12345', URL_, PARAMS)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
    expect(verifyTwilioSignature('12345', URL_, PARAMS, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=')).toBe(true);
  });

  it('reject another token, URL, parameter, a missing or malformed signature', () => {
    const sig = twilioSignature('12345', URL_, PARAMS);
    expect(verifyTwilioSignature('54321', URL_, PARAMS, sig)).toBe(false);
    expect(verifyTwilioSignature('12345', `${URL_}&x=1`, PARAMS, sig)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, { ...PARAMS, Digits: '9' }, sig)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, { ...PARAMS, Extra: '' }, sig)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, PARAMS, undefined)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, PARAMS, ['a', 'b'])).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, PARAMS, 'x'.repeat(500))).toBe(false);
  });

  it('accept the URL with the default port written or omitted, as Twilio’s validator does', () => {
    const withPort = 'https://mycompany.com:443/myapp.php?foo=1&bar=2';
    expect(
      verifyTwilioSignature('12345', withPort, PARAMS, twilioSignature('12345', URL_, PARAMS)),
    ).toBe(true);
    expect(
      verifyTwilioSignature('12345', URL_, PARAMS, twilioSignature('12345', withPort, PARAMS)),
    ).toBe(true);
    const other = 'https://mycompany.com:8443/myapp.php?foo=1&bar=2';
    expect(
      verifyTwilioSignature('12345', other, PARAMS, twilioSignature('12345', URL_, PARAMS)),
    ).toBe(false);
  });

  it('sign repeated parameters with every value, sorted, and keep form order irrelevant', () => {
    const body = new URLSearchParams('b=2&a=1&a=0');
    const params = formParams(body);
    expect(params).toEqual({ b: '2', a: ['1', '0'] });
    expect(twilioSignature('t', 'https://x.example/h', params)).toBe(
      twilioSignature('t', 'https://x.example/h', { a: ['0', '1'], b: '2' }),
    );
  });
});

const BASE = {
  DATABASE_URL: 'postgresql://jarvis_app:x@localhost:5432/jarvis',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const TWILIO = {
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  TWILIO_FROM_NUMBER: '+493012345678',
  PUBLIC_WEBHOOK_BASE_URL: 'http://127.0.0.1:4000',
};
const PROD = { ...BASE, NODE_ENV: 'production', WEB_ORIGIN: 'https://jarvis.example' };

describe('telephony configuration', () => {
  it('is not configured without the three Twilio settings, and refuses a partial set', () => {
    expect(loadConfig(BASE).telephony).toBeNull();
    expect(() => loadConfig({ ...BASE, TWILIO_ACCOUNT_SID: TWILIO.TWILIO_ACCOUNT_SID })).toThrow(
      /must be set together/,
    );
    expect(() => loadConfig({ ...BASE, ...TWILIO, TWILIO_ACCOUNT_SID: 'AC123' })).toThrow();
  });

  it('defaults: the real API, the caller id’s country only, 08:00–20:00, 300 s, 10 a day', () => {
    const t = loadConfig({ ...BASE, ...TWILIO }).telephony!;
    expect(t.apiBase).toBe(TWILIO_API_BASE);
    expect([...t.allowedCountries]).toEqual(['DE']);
    expect(t.allowedHours).toEqual({ start: '08:00', end: '20:00' });
    expect(t.maxCallSeconds).toBe(300);
    expect(t.maxCallsPerDay).toBe(10);
    expect(t.pricePerMinuteMicroUsd).toBeNull();
    expect(t.webhookBase).toBe('http://127.0.0.1:4000');
    const custom = loadConfig({
      ...BASE,
      ...TWILIO,
      CALL_ALLOWED_COUNTRIES: 'de, at,CH',
      CALL_ALLOWED_HOURS: '09:00-18:30',
      CALL_PRICE_PER_MINUTE_USD: '0.05',
      TWILIO_BASE_URL_OVERRIDE: 'http://127.0.0.1:4620/',
    }).telephony!;
    expect([...custom.allowedCountries]).toEqual(['DE', 'AT', 'CH']);
    expect(custom.allowedHours).toEqual({ start: '09:00', end: '18:30' });
    expect(custom.pricePerMinuteMicroUsd).toBe(50_000);
    expect(custom.apiBase).toBe('http://127.0.0.1:4620');
  });

  it('refuses unsafe or inconsistent settings', () => {
    const bad: Record<string, string>[] = [
      { PUBLIC_WEBHOOK_BASE_URL: '' },
      { PUBLIC_WEBHOOK_BASE_URL: 'http://127.0.0.1:4000/api' },
      { PUBLIC_WEBHOOK_BASE_URL: 'https://u:p@api.example' },
      { CALL_ALLOWED_HOURS: '20:00-08:00' },
      { CALL_ALLOWED_COUNTRIES: 'Germany' },
      { TWILIO_FROM_NUMBER: '+4930' },
      { CALL_MAX_SECONDS: '5' },
    ];
    for (const over of bad) {
      const env: Record<string, string> = { ...BASE, ...TWILIO, ...over };
      if (over.PUBLIC_WEBHOOK_BASE_URL === '') delete env.PUBLIC_WEBHOOK_BASE_URL;
      expect(() => loadConfig(env), JSON.stringify(over)).toThrow();
    }
  });

  it('in production: no mock Twilio, webhooks over https only', () => {
    const prodTwilio = {
      ...PROD,
      ...TWILIO,
      PUBLIC_WEBHOOK_BASE_URL: 'https://api.jarvis.example',
    };
    expect(loadConfig(prodTwilio).telephony?.webhookBase).toBe('https://api.jarvis.example');
    expect(() =>
      loadConfig({ ...prodTwilio, TWILIO_BASE_URL_OVERRIDE: 'http://127.0.0.1:4620' }),
    ).toThrow(/not allowed in production/);
    expect(() =>
      loadConfig({ ...prodTwilio, PUBLIC_WEBHOOK_BASE_URL: 'http://api.jarvis.example' }),
    ).toThrow(/must be https/);
  });

  it('keeps the auth token away from the browser worker', () => {
    expect(BROWSER_WORKER_FORBIDDEN_ENV).toContain('TWILIO_AUTH_TOKEN');
  });
});

describe('calling-hours clock and voice preferences', () => {
  it('reads the wall-clock time in a zone', () => {
    expect(localTimeOfDay(new Date('2026-11-04T19:59:00Z'), 'Europe/Berlin')).toBe('20:59');
    expect(localTimeOfDay(new Date('2026-07-04T06:00:00Z'), 'Europe/Berlin')).toBe('08:00');
    expect(localTimeOfDay(new Date('2026-11-04T00:30:00Z'), 'Asia/Riyadh')).toBe('03:30');
    expect(localTimeOfDay(new Date(), 'Not/AZone')).toBeNull();
  });

  it('a voice patch keeps the other voice settings and languages', () => {
    const current = structuredClone(DEFAULT_PREFERENCES);
    current.voice.voiceNames = { en: 'Samantha', de: null, ar: 'Maged' };
    current.voice.speakingRate = 1.2;
    const next = mergePreferences(current, { voice: { voiceNames: { de: 'Anna' } } });
    expect(next.voice).toMatchObject({
      speakingRate: 1.2,
      voiceNames: { en: 'Samantha', de: 'Anna', ar: 'Maged' },
    });
    const reset = mergePreferences(next, {
      voice: { voiceNames: { ar: null }, conversationMode: true },
    });
    expect(reset.voice.voiceNames).toEqual({ en: 'Samantha', de: 'Anna', ar: null });
    expect(reset.voice.conversationMode).toBe(true);
  });
});
