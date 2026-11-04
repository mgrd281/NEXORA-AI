/**
 * The Twilio adapter (modules/telephony/twilio/client.ts) against the mock Twilio REST API, the
 * mock's webhook signing against the API's validator (both implement Twilio's documented
 * algorithm independently; Twilio's published test vector), TwiML escaping, and how provider
 * failures are classified for exactly-once calls: unreachable / 429 / 4xx before any call,
 * "unknown" after a create request was sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseTwiml,
  startMockTwilio,
  twilioSignature as mockSignature,
  textOf,
  elements,
  type MockTwilio,
} from '../../../../../tools/mock-twilio/index.mjs';
import type { TelephonyConfig } from '../../../src/config';
import { twilioSignature, verifyTwilioSignature } from '../../../src/lib/twilio-signature';
import { createTwilioClient, parsePrice } from '../../../src/modules/telephony/twilio/client';
import { providerStepError, TelephonyError } from '../../../src/modules/telephony/twilio/errors';
import * as twiml from '../../../src/modules/telephony/twilio/twiml';

const ACCOUNT = `AC${'b'.repeat(32)}`;
const TOKEN = 'gateway-test-auth-token-0123456789';
const FROM = '+4930901820';

let mock: MockTwilio;
let config: TelephonyConfig;
beforeAll(async () => {
  mock = await startMockTwilio({
    accountSid: ACCOUNT,
    authToken: TOKEN,
    numbers: [FROM],
    stepMs: 1,
  });
  config = {
    provider: 'twilio',
    accountSid: ACCOUNT,
    authToken: TOKEN,
    fromNumber: FROM,
    apiBase: mock.url,
    // Nobody listens here: the simulator's webhooks fail, which these tests do not need.
    webhookBase: 'http://127.0.0.1:9',
    allowedCountries: new Set(['DE']),
    allowedHours: { start: '08:00', end: '20:00' },
    maxCallSeconds: 300,
    maxCallsPerDay: 10,
    pricePerMinuteMicroUsd: null,
  };
});
afterAll(() => mock.close());

/** A local port nothing listens on (connection refused). */
async function closedPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const req = (to: string) => ({
  to,
  from: FROM,
  voiceUrl: 'http://127.0.0.1:9/voice?t=x',
  statusUrl: 'http://127.0.0.1:9/status?t=x',
  amdUrl: 'http://127.0.0.1:9/amd?t=x',
  ringTimeoutSeconds: 30,
  timeLimitSeconds: 330,
});

describe('signatures', () => {
  it("the mock signs exactly like the API validates (and like Twilio's published vector)", () => {
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675309',
      Digits: '1234',
      From: '+14158675309',
      To: '+18005551212',
    };
    expect(mockSignature('12345', url, params)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
    expect(twilioSignature('12345', url, params)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
    const multi = { A: ['2', '1'], B: 'x' };
    expect(mockSignature(TOKEN, url, multi)).toBe(twilioSignature(TOKEN, url, multi));
    expect(verifyTwilioSignature(TOKEN, url, params, mockSignature(TOKEN, url, params))).toBe(true);
    expect(verifyTwilioSignature(TOKEN, url, params, mockSignature('wrong', url, params))).toBe(
      false,
    );
    expect(
      verifyTwilioSignature(TOKEN, `${url}&x=1`, params, mockSignature(TOKEN, url, params)),
    ).toBe(false);
  });
});

describe('the Calls resource', () => {
  it('creates (Basic auth, form body), fetches, lists, updates', async () => {
    const client = createTwilioClient(config);
    mock.setScenario('+4930777001', { outcome: 'busy' });
    const created = await client.createCall(req('+4930777001'));
    expect(created.sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(created.status).toBe('queued');
    const r = mock.createRequests('+4930777001')[0]!;
    expect(r.authorised).toBe(true);
    expect(r.form).toMatchObject({
      To: '+4930777001',
      From: FROM,
      Url: 'http://127.0.0.1:9/voice?t=x',
      MachineDetection: 'Enable',
      AsyncAmd: 'true',
    });
    await mock.waitForEnded(created.sid);
    const fetched = await client.fetchCall(created.sid);
    expect(fetched).toMatchObject({
      sid: created.sid,
      status: 'busy',
      to: '+4930777001',
      from: FROM,
    });
    const listed = await client.findCalls({
      to: '+4930777001',
      from: FROM,
      since: new Date(Date.now() - 60_000),
    });
    expect(listed.map((c) => c.sid)).toEqual([created.sid]);
    const listReq = mock.requests.find(
      (x) => x.method === 'GET' && x.path.endsWith('/Calls.json'),
    )!;
    expect(Object.keys(listReq.query)).toEqual(
      expect.arrayContaining(['To', 'From', 'StartTime>=']),
    );
    // An ended call cannot be redirected (Twilio 21220): a rejected request.
    await expect(
      client.updateCall(created.sid, { twiml: twiml.response(twiml.hangup()) }),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('classifies failures: refused (4xx), rate limited (429), unknown (5xx / timeout after sending), unreachable', async () => {
    const client = createTwilioClient(config);
    mock.setScenario('+4930777002', { outcome: 'reject', rejectCode: 21215 });
    const refused = await client.createCall(req('+4930777002')).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TelephonyError);
    expect(refused).toMatchObject({ kind: 'rejected', details: { status: 400, code: 21215 } });
    expect(providerStepError(refused as TelephonyError).toTaskError()).toMatchObject({
      reason: 'PROVIDER_REJECTED',
      retryable: true,
    });

    mock.failNextCreate({ status: 429, code: 20429, message: 'Too Many Requests' });
    const limited = await client.createCall(req('+4930777003')).catch((e: unknown) => e);
    expect(limited).toMatchObject({ kind: 'rate_limited' });
    expect(providerStepError(limited as TelephonyError).toTaskError()).toMatchObject({
      reason: 'PROVIDER_RATE_LIMITED',
    });

    mock.setScenario('+4930777004', { outcome: 'error500' });
    expect(await client.createCall(req('+4930777004')).catch((e: unknown) => e)).toMatchObject({
      kind: 'unknown',
    });
    expect(mock.callsTo('+4930777004')).toHaveLength(1); // …and the call did exist

    const impatient = createTwilioClient(config, { timeoutMs: 150 });
    mock.setScenario('+4930777005', { outcome: 'timeout', responseDelayMs: 1_000 });
    expect(await impatient.createCall(req('+4930777005')).catch((e: unknown) => e)).toMatchObject({
      kind: 'unknown',
    });

    const nowhere = createTwilioClient({
      ...config,
      apiBase: `http://127.0.0.1:${await closedPort()}`,
    });
    const down = await nowhere.createCall(req('+4930777006')).catch((e: unknown) => e);
    expect(down).toMatchObject({ kind: 'unavailable' });
    expect(providerStepError(down as TelephonyError).toTaskError()).toMatchObject({
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });

    const wrongToken = createTwilioClient({ ...config, authToken: 'wrong-token-0123456789' });
    expect(
      await wrongToken.fetchCall(`CA${'0'.repeat(32)}`).catch((e: unknown) => e),
    ).toMatchObject({ kind: 'auth' });
  });

  it('parses prices as absolute micro-units', () => {
    expect(parsePrice('-0.01300', 'USD')).toEqual({ micro: 13_000, currency: 'USD' });
    expect(parsePrice(null, 'USD')).toBeNull();
    expect(parsePrice('x', 'USD')).toBeNull();
  });
});

describe('TwiML', () => {
  it('escapes text and attributes; the simulator parses what JARVIS sends', () => {
    const xml = twiml.response(
      twiml.say('Tom & Jerry <script>"x"</script>', 'de'),
      twiml.gather({
        action: 'https://x.test/g?t=a&n=2',
        language: 'ar',
        prompt: ['هل لديكم موعد؟'],
      }),
      twiml.dial({
        number: '+4915112345678',
        callerId: FROM,
        timeoutSeconds: 25,
        timeLimitSeconds: 120,
        action: 'https://x.test/d?t=a',
      }),
      twiml.hangup(),
    );
    const doc = parseTwiml(xml);
    const [say, gather, dial, hang] = elements(doc);
    expect(textOf(say!)).toBe('Tom & Jerry <script>"x"</script>');
    expect(say!.attrs).toEqual({ language: 'de-DE', voice: 'Polly.Vicki-Neural' });
    expect(gather!.attrs).toMatchObject({
      input: 'speech',
      language: 'ar-SA',
      speechTimeout: 'auto',
      actionOnEmptyResult: 'true',
      action: 'https://x.test/g?t=a&n=2',
    });
    expect(textOf(elements(gather!)[0]!)).toBe('هل لديكم موعد؟');
    expect(elements(gather!)[0]!.attrs.language).toBe('arb');
    expect(dial!.attrs).toMatchObject({ callerId: FROM, timeout: '25' });
    expect(textOf(elements(dial!)[0]!)).toBe('+4915112345678');
    expect(hang!.name).toBe('Hangup');
    expect(() => parseTwiml('<Response><Say>x</Response>')).toThrow();
  });
});
