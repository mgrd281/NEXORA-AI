/** Scopes → capabilities, Gmail query / message building, header rules, provider error mapping. */
import { OAUTH_SCOPES } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildRawMessage,
  encodeHeader,
  gmailOperand,
  gmailQuery,
} from '../../../src/modules/integrations/google/gmail';
import { googleEventId } from '../../../src/modules/integrations/google/calendar';
import { isScopeError, retryAfterSeconds } from '../../../src/modules/integrations/http';
import {
  isAutomated,
  needsReply,
  parseAddressList,
  replySubject,
  replyTarget,
} from '../../../src/modules/integrations/mail';
import {
  capabilitiesFromScopes,
  normalizeScope,
  scopesFor,
} from '../../../src/modules/integrations/oauth-client';
import { codeChallenge } from '../../../src/modules/integrations/oauth';
import { parseRfc822 } from '../../../../../tools/mock-providers/index.mjs';

describe('scopes', () => {
  it('requests identity + exactly the capabilities’ scopes, never broad ones', () => {
    const g = scopesFor('google', ['mail.read', 'calendar.write']);
    expect(g).toEqual([
      'openid',
      'email',
      ...OAUTH_SCOPES.google['mail.read'],
      ...OAUTH_SCOPES.google['calendar.write'],
    ]);
    for (const s of [
      ...g,
      ...scopesFor('microsoft', [
        'mail.read',
        'mail.compose',
        'mail.send',
        'calendar.read',
        'calendar.write',
      ]),
    ]) {
      expect(s).not.toMatch(/mail\.google\.com|gmail\.modify|auth\/calendar$|\.default$/);
    }
  });

  it('grants a capability only when all its scopes were granted; Graph scopes compared without prefix and case', () => {
    expect(
      capabilitiesFromScopes('google', [
        'openid',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ]),
    ).toEqual([]);
    expect(
      capabilitiesFromScopes('google', [
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.freebusy',
        'https://www.googleapis.com/auth/gmail.send',
      ]),
    ).toEqual(['mail.send', 'calendar.read']);
    expect(
      capabilitiesFromScopes('microsoft', [
        'mail.read',
        'MAIL.SEND',
        'User.Read',
        'offline_access',
      ]),
    ).toEqual(['mail.read', 'mail.send']);
    expect(normalizeScope('microsoft', 'https://graph.microsoft.com/Calendars.ReadWrite')).toBe(
      'calendars.readwrite',
    );
  });

  it('PKCE S256 is BASE64URL(SHA-256(verifier)) (RFC 7636 appendix B)', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('Gmail', () => {
  it('builds queries from fields; user text never becomes an operator', () => {
    expect(gmailQuery({ unreadOnly: true, inboxOnly: true, limit: 5 })).toBe('in:inbox is:unread');
    expect(gmailQuery({ from: 'anna@example.org', limit: 5 })).toBe('from:anna@example.org');
    expect(gmailQuery({ from: 'Anna Berg', limit: 5 })).toBe('from:"Anna Berg"');
    expect(gmailOperand('x OR from:(boss) in:trash')).toBe('"x OR from boss in trash"');
    expect(gmailQuery({ query: 'invoice" OR label:secret', limit: 5 })).toBe(
      '"invoice OR label secret"',
    );
    expect(gmailQuery({ newerThanDays: 7, limit: 5 })).toBe('newer_than:7d');
  });

  it('builds a plain-text message with the derived Message-ID; CR/LF cannot inject headers', () => {
    const raw = buildRawMessage({
      from: 'me@x.test',
      to: ['a@x.test'],
      cc: [],
      subject: 'Hi\r\nBcc: evil@x.test',
      body: 'Grüße — مرحبا',
      messageIdHeader: '<jarvis.abc@x.test>',
      inReplyTo: '<orig@x.test>',
      references: '<root@x.test>',
    });
    const parsed = parseRfc822(Buffer.from(raw, 'base64url').toString('utf8'));
    expect(parsed.headers.bcc).toBeUndefined();
    expect(parsed.subject).toBe('Hi Bcc: evil@x.test');
    expect(parsed.headers['message-id']).toBe('<jarvis.abc@x.test>');
    expect(parsed.headers['in-reply-to']).toBe('<orig@x.test>');
    expect(parsed.headers.references).toBe('<root@x.test> <orig@x.test>');
    expect(parsed.body).toBe('Grüße — مرحبا');
    expect(encodeHeader('Grüße')).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('derives a valid, deterministic Google event id (base32hex) from the idempotency key', () => {
    const id = googleEventId('step-1');
    expect(id).toMatch(/^[a-v0-9]{32}$/);
    expect(googleEventId('step-1')).toBe(id);
    expect(googleEventId('step-2')).not.toBe(id);
  });
});

describe('needs-reply rule and reply targets', () => {
  const msg = (
    from: string,
    extra: Partial<Parameters<typeof needsReply>[0]['messages'][number]> = {},
  ) => ({
    id: Math.random().toString(36),
    threadId: 't',
    from: parseAddressList(from)[0]!,
    to: [],
    cc: [],
    replyTo: [],
    date: new Date().toISOString(),
    subject: 'S',
    snippet: '',
    unread: true,
    hasAttachments: false,
    inInbox: true,
    automated: false,
    internetMessageId: null,
    references: null,
    ...extra,
  });
  it('needs a reply: newest from someone else, in the inbox, not automated', () => {
    const t = (messages: ReturnType<typeof msg>[]) => ({
      id: 't',
      subject: 'S',
      messages,
      webLink: null,
    });
    expect(needsReply(t([msg('Anna <anna@x.test>')]), 'me@x.test')).toBe(true);
    expect(needsReply(t([msg('Anna <anna@x.test>'), msg('me@x.test')]), 'me@x.test')).toBe(false);
    expect(needsReply(t([msg('Shop <news@x.test>', { automated: true })]), 'me@x.test')).toBe(
      false,
    );
    expect(needsReply(t([msg('Anna <anna@x.test>', { inInbox: false })]), 'me@x.test')).toBe(false);
    expect(
      replyTarget(
        t([msg('Anna <anna@x.test>', { replyTo: [{ name: null, address: 'desk@x.test' }] })]),
        'me@x.test',
      ),
    ).toEqual({
      name: null,
      address: 'desk@x.test',
    });
  });
  it('recognises automated mail from headers only', () => {
    expect(isAutomated({ 'List-Unsubscribe': '<mailto:u@x>' }, 'a@x.test')).toBe(true);
    expect(isAutomated({ 'Auto-Submitted': 'auto-replied' }, 'a@x.test')).toBe(true);
    expect(isAutomated({ 'Auto-Submitted': 'no' }, 'a@x.test')).toBe(false);
    expect(isAutomated({ Precedence: 'bulk' }, 'a@x.test')).toBe(true);
    expect(isAutomated({}, 'no-reply@x.test')).toBe(true);
    expect(isAutomated({}, 'anna@x.test')).toBe(false);
    expect(parseAddressList('"Berg, Anna" <Anna@X.test>, bob@x.test')).toEqual([
      { name: 'Berg, Anna', address: 'anna@x.test' },
      { name: null, address: 'bob@x.test' },
    ]);
    expect(replySubject('Contract')).toBe('Re: Contract');
    expect(replySubject('AW: Vertrag')).toBe('AW: Vertrag');
  });
});

describe('provider error mapping', () => {
  it('reads Retry-After as seconds or an HTTP date, capped at an hour', () => {
    expect(retryAfterSeconds(new Headers({ 'retry-after': '42' }))).toBe(42);
    expect(retryAfterSeconds(new Headers({ 'retry-after': '999999' }))).toBe(3600);
    const now = Date.parse('2026-11-04T10:00:00Z');
    expect(
      retryAfterSeconds(new Headers({ 'retry-after': 'Wed, 04 Nov 2026 10:01:00 GMT' }), now),
    ).toBe(60);
    expect(retryAfterSeconds(new Headers())).toBe(30);
  });
  it('tells insufficient scope apart from other 403s (Google and Graph shapes)', () => {
    const none = new Headers();
    expect(
      isScopeError(
        'google',
        403,
        { error: { errors: [{ reason: 'insufficientPermissions' }] } },
        none,
      ),
    ).toBe(true);
    expect(
      isScopeError(
        'google',
        403,
        { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
        none,
      ),
    ).toBe(true);
    expect(
      isScopeError('google', 403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, none),
    ).toBe(false);
    expect(
      isScopeError(
        'google',
        403,
        {},
        new Headers({ 'www-authenticate': 'Bearer error="insufficient_scope"' }),
      ),
    ).toBe(true);
    expect(isScopeError('microsoft', 403, { error: { code: 'ErrorAccessDenied' } }, none)).toBe(
      true,
    );
    expect(isScopeError('microsoft', 403, { error: { code: 'ErrorQuotaExceeded' } }, none)).toBe(
      false,
    );
    expect(isScopeError('microsoft', 401, { error: { code: 'ErrorAccessDenied' } }, none)).toBe(
      false,
    );
  });
});
