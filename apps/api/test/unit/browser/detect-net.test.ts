import { describe, expect, it } from 'vitest';
import { classifyPage, type PageSnapshot } from '../../../src/modules/browser/detect';
import {
  chromiumNetwork,
  isAllowedUrl,
  onOrigins,
  resolveOrigins,
} from '../../../src/modules/browser/net-guard';

const page = (s: Partial<PageSnapshot>): PageSnapshot => ({
  url: 'https://shop.example/p',
  status: 200,
  title: 'Product',
  frames: [],
  scripts: [],
  widgets: [],
  passwordFields: 0,
  text: 'An ordinary product page. '.repeat(200),
  ...s,
});

describe('detection: what JARVIS must hand over', () => {
  it('finds CAPTCHAs by widget, frame or script', () => {
    expect(classifyPage(page({ widgets: ['g-recaptcha'] }))).toEqual({
      kind: 'handover',
      reason: 'CAPTCHA_DETECTED',
    });
    expect(
      classifyPage(page({ frames: ['https://www.google.com/recaptcha/api2/anchor?k=x'] })),
    ).toMatchObject({ reason: 'CAPTCHA_DETECTED' });
    expect(classifyPage(page({ scripts: ['https://js.hcaptcha.com/1/api.js'] }))).toMatchObject({
      reason: 'CAPTCHA_DETECTED',
    });
    expect(
      classifyPage(page({ frames: ['https://challenges.cloudflare.com/turnstile/v0/x'] })),
    ).toMatchObject({ reason: 'CAPTCHA_DETECTED' });
  });

  it('a challenge page (blocked status + wording) is a CAPTCHA; an article that mentions robots is not', () => {
    expect(
      classifyPage(
        page({
          status: 503,
          title: 'Just a moment...',
          text: 'Checking your browser before accessing',
        }),
      ),
    ).toMatchObject({ reason: 'CAPTCHA_DETECTED' });
    expect(
      classifyPage(
        page({ text: `${'Long article. '.repeat(400)} Are you a robot? asked the author.` }),
      ),
    ).toEqual({ kind: 'ok' });
  });

  it('bot walls, login walls and error pages', () => {
    expect(
      classifyPage(page({ status: 403, text: 'Access denied: automated traffic is blocked' })),
    ).toEqual({ kind: 'handover', reason: 'BOT_PROTECTION' });
    expect(classifyPage(page({ passwordFields: 1 }))).toEqual({
      kind: 'handover',
      reason: 'LOGIN_REQUIRED',
    });
    expect(classifyPage(page({ passwordFields: 1 }), { expectLogin: true })).toEqual({
      kind: 'ok',
    });
    expect(classifyPage(page({ status: 404, text: 'Not found' }))).toEqual({
      kind: 'error',
      reason: 'SITE_ERROR',
      status: 404,
    });
    expect(classifyPage(page({ status: 403, text: 'Forbidden' }))).toEqual({
      kind: 'error',
      reason: 'SITE_ERROR',
      status: 403,
    });
    expect(classifyPage(page({}))).toEqual({ kind: 'ok' });
  });
});

describe('network allow-list', () => {
  const lookup = (answers: Record<string, string[]>) => async (host: string) => {
    if (!answers[host]) throw new Error('ENOTFOUND');
    return answers[host]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  it('pins public hosts to the validated address; refuses private, rebinding and odd origins', async () => {
    const ok = await resolveOrigins(
      ['https://shop.example'],
      new Set(),
      lookup({ 'shop.example': ['93.184.216.34'] }),
    );
    expect(ok).toEqual({
      ok: true,
      allowed: [
        {
          origin: 'https://shop.example',
          protocol: 'https:',
          hostname: 'shop.example',
          port: 443,
          address: '93.184.216.34',
        },
      ],
    });
    expect(
      await resolveOrigins(
        ['https://intranet.example'],
        new Set(),
        lookup({ 'intranet.example': ['10.0.0.5'] }),
      ),
    ).toEqual({
      ok: false,
      host: 'intranet.example',
      why: 'private',
    });
    // A name answering with a public AND a private address (rebinding attempt): refused.
    expect(
      await resolveOrigins(
        ['https://mixed.example'],
        new Set(),
        lookup({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }),
      ),
    ).toMatchObject({ ok: false, why: 'private' });
    expect(await resolveOrigins(['http://169.254.169.254'], new Set())).toMatchObject({
      ok: false,
      why: 'private',
    });
    expect(await resolveOrigins(['ftp://shop.example'], new Set())).toMatchObject({
      ok: false,
      why: 'invalid',
    });
    expect(await resolveOrigins(['https://u:p@shop.example'], new Set())).toMatchObject({
      ok: false,
      why: 'invalid',
    });
    expect(await resolveOrigins(['https://gone.example'], new Set(), lookup({}))).toMatchObject({
      ok: false,
      why: 'unresolvable',
    });
  });

  it('a private dev fixture only with its exact host:port allow-listed', async () => {
    expect(await resolveOrigins(['http://127.0.0.1:4601'], new Set())).toMatchObject({
      ok: false,
      why: 'private',
    });
    expect(
      await resolveOrigins(['http://127.0.0.1:4601'], new Set(['127.0.0.1:4602'])),
    ).toMatchObject({ ok: false });
    expect(
      await resolveOrigins(['http://127.0.0.1:4601'], new Set(['127.0.0.1:4601'])),
    ).toMatchObject({ ok: true });
  });

  it('Chromium switches: pinned hosts, everything else unresolvable, exact proxy bypass', () => {
    const net = chromiumNetwork([
      {
        origin: 'https://shop.example',
        protocol: 'https:',
        hostname: 'shop.example',
        port: 443,
        address: '93.184.216.34',
      },
      {
        origin: 'http://127.0.0.1:4601',
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: 4601,
        address: null,
      },
    ]);
    expect(net.hostResolverRules).toBe(
      'MAP shop.example 93.184.216.34, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    );
    expect(net.proxyBypass).toBe('<-loopback>,shop.example:443,127.0.0.1:4601');
  });

  it('URLs are allowed only on the exact origins', () => {
    const allowed = [
      {
        origin: 'http://127.0.0.1:4601',
        protocol: 'http:' as const,
        hostname: '127.0.0.1',
        port: 4601,
        address: null,
      },
    ];
    expect(isAllowedUrl('http://127.0.0.1:4601/shop', allowed)).toBe(true);
    expect(isAllowedUrl('http://127.0.0.1:4602/shop', allowed)).toBe(false);
    expect(isAllowedUrl('https://127.0.0.1:4601/shop', allowed)).toBe(false);
    expect(isAllowedUrl('http://user:pw@127.0.0.1:4601/', allowed)).toBe(false);
    expect(onOrigins('http://127.0.0.1:4601/x', ['http://127.0.0.1:4601'])).toBe(true);
    expect(onOrigins('javascript:alert(1)', ['http://127.0.0.1:4601'])).toBe(false);
    expect(onOrigins('http://evil.example/', ['http://127.0.0.1:4601'])).toBe(false);
  });
});
