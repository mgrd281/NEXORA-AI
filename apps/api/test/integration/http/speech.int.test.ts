import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, newClient, ownerQuery, type Harness } from './support';

let off: Harness;
let on: Harness;
beforeAll(async () => {
  off = await createHarness();
  on = await createHarness({ env: { OPENAI_API_KEY: 'sk-test-natural-voice' } });
});
afterAll(async () => {
  await off.close();
  await on.close();
});
afterEach(() => vi.restoreAllMocks());

const MP3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x00]);

describe('natural voice (POST /v1/voice/speech)', () => {
  it('is unavailable without a speech provider', async () => {
    const c = await newClient(off);
    const res = await c.request('POST', '/v1/voice/speech', { text: 'Hallo', language: 'de' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('returns the provider audio, sends only text and meters the cost', async () => {
    const real = globalThis.fetch;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith('https://api.openai.com/')) {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      return real(url, init);
    });
    const c = await newClient(on);

    const res = await c.request('POST', '/v1/voice/speech', {
      text: 'Hallo Mgrdegh! Wie kann ich helfen?',
      language: 'de',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload.equals(MP3)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: 'Hallo Mgrdegh! Wie kann ich helfen?',
      response_format: 'mp3',
    });
    const costs = await ownerQuery<{ category: string; amount_micro: number }>(
      `select category, amount_micro from cost_records where user_id = $1`,
      [c.user.userId],
    );
    expect(costs).toEqual([{ category: 'model', amount_micro: 35 * 17 }]);
  });

  it('respects the user turning external models off', async () => {
    const c = await newClient(on);
    await c.request('PATCH', '/v1/me', { preferences: { ai: { allowExternalModels: false } } });
    const res = await c.request('POST', '/v1/voice/speech', { text: 'Hallo', language: 'de' });
    expect(res.statusCode).toBe(503);
  });

  it('maps a provider failure to SERVICE_UNAVAILABLE without leaking its message', async () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      String(url).startsWith('https://api.openai.com/')
        ? new Response('{"error":{"message":"insufficient_quota secret detail"}}', { status: 429 })
        : real(url, init),
    );
    const c = await newClient(on);
    const res = await c.request('POST', '/v1/voice/speech', { text: 'Hallo', language: 'de' });
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).not.toContain('secret detail');
  });
});
