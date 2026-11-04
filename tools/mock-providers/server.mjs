#!/usr/bin/env node
/**
 * Starts the mock providers for local development and the e2e harness:
 *
 *   node tools/mock-providers/server.mjs [--google-port 4610] [--microsoft-port 4611]
 *     [--client-id mock-client] [--client-secret mock-secret]
 *     [--google-account owner@gmail.test] [--microsoft-account owner@outlook.test]
 *     [--control-port 4622] [--no-seed]
 *
 * Then run the API (development only) with
 *   GOOGLE_CLIENT_ID=mock-client GOOGLE_CLIENT_SECRET=mock-secret
 *   GOOGLE_BASE_URL_OVERRIDE=http://127.0.0.1:4610
 *   MICROSOFT_CLIENT_ID=mock-client MICROSOFT_CLIENT_SECRET=mock-secret
 *   MICROSOFT_BASE_URL_OVERRIDE=http://127.0.0.1:4611
 * The consent screens approve automatically; the seeded mailboxes and
 * calendars hold a few fictional messages and events.
 *
 * --control-port starts a JSON control channel for the e2e harness (127.0.0.1
 * only; a test double — never part of a real provider):
 *   POST /:provider/messages {email, message}   → { id }   (MockMessageInput)
 *   POST /:provider/events   {email, event}     → { id }   (MockEventInput)
 *   POST /:provider/revoke   {email}            every token of the account stops working
 *   POST /:provider/expire   {email}            access tokens stop working (refresh still works)
 *   POST /:provider/consent  {deny?, grantOnly?} consent behaviour of the next authorizations
 *   POST /:provider/fail     {path, method?, status, times?}  inject errors
 *   POST /:provider/clear-failures
 *   GET  /:provider/sent?email=  /messages?email=  /drafts?email=  /events?email=
 *   GET  /:provider/invitations
 *   GET  /:provider/requests?path=<substring>   recorded requests (method, path, query, body, status)
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { startGoogleMock } from './google.mjs';
import { startMicrosoftMock } from './microsoft.mjs';

const { values: a } = parseArgs({
  options: {
    'google-port': { type: 'string', default: process.env.MOCK_GOOGLE_PORT ?? '4610' },
    'microsoft-port': { type: 'string', default: process.env.MOCK_MICROSOFT_PORT ?? '4611' },
    'client-id': { type: 'string', default: process.env.MOCK_CLIENT_ID ?? 'mock-client' },
    'client-secret': { type: 'string', default: process.env.MOCK_CLIENT_SECRET ?? 'mock-secret' },
    'google-account': { type: 'string', default: 'owner@gmail.test' },
    'microsoft-account': { type: 'string', default: 'owner@outlook.test' },
    'control-port': { type: 'string', default: process.env.MOCK_CONTROL_PORT },
    'no-seed': { type: 'boolean', default: false },
  },
});

const client = { clientId: a['client-id'], clientSecret: a['client-secret'] };
const google = await startGoogleMock({
  ...client,
  port: Number(a['google-port']),
  accounts: [{ email: a['google-account'], name: 'Owner', timeZone: 'Europe/Berlin' }],
});
const microsoft = await startMicrosoftMock({
  ...client,
  port: Number(a['microsoft-port']),
  accounts: [{ email: a['microsoft-account'], name: 'Owner', timeZone: 'Europe/Berlin' }],
});

// A little fictional content so the UI has something to show.
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
if (!a['no-seed']) seed();
function seed() {
  google.addMessage(a['google-account'], {
    from: 'Anna Berg <anna@example.org>',
    subject: 'Quarterly report draft',
    body: 'Hi! The quarterly report draft is attached in the shared folder. Could you review section 3 by Thursday? Thanks, Anna',
  });
  google.addMessage(a['google-account'], {
    from: 'Newsletter <news@shop.example>',
    subject: 'This week only: 20% off',
    body: 'Our autumn sale has started.',
    headers: { 'List-Unsubscribe': '<mailto:unsubscribe@shop.example>' },
  });
  google.addEvent(a['google-account'], {
    title: 'Team sync',
    start: inHours(26),
    end: inHours(27),
  });
  microsoft.addMessage(a['microsoft-account'], {
    from: 'Omar Haddad <omar@example.net>',
    subject: 'Contract renewal',
    body: 'Hello, the contract renewal needs your signature before the end of the month. Best regards, Omar',
  });
  microsoft.addEvent(a['microsoft-account'], {
    title: 'Dentist',
    start: inHours(50),
    end: inHours(51),
  });
}

/* ---------------------------------------------------------------- */
/* e2e control channel (loopback only)                               */
/* ---------------------------------------------------------------- */

const mocks = { google, microsoft };
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const control = a['control-port']
  ? createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const [, provider, action] = url.pathname.split('/');
        const m = mocks[provider];
        if (!m) return json(res, 404, { error: 'unknown provider' });
        const q = url.searchParams;
        if (req.method === 'GET') {
          const email = q.get('email') ?? '';
          switch (action) {
            case 'sent':
              return json(res, 200, { items: m.sent(email) });
            case 'messages':
              return json(res, 200, { items: m.messages(email) });
            case 'drafts':
              return json(res, 200, { items: m.drafts(email) });
            case 'events':
              return json(res, 200, { items: m.events(email) });
            case 'invitations':
              return json(res, 200, { items: m.invitations });
            case 'requests': {
              const part = q.get('path') ?? '';
              return json(res, 200, {
                items: m.requests
                  .filter((r) => r.path.includes(part))
                  .map((r) => ({
                    method: r.method,
                    path: r.path,
                    query: r.query,
                    body: r.body,
                    status: r.status,
                  })),
              });
            }
            default:
              return json(res, 404, { error: 'unknown action' });
          }
        }
        const body = await readJson(req);
        switch (action) {
          case 'messages':
            return json(res, 200, { id: m.addMessage(body.email, body.message) });
          case 'events':
            return json(res, 200, { id: m.addEvent(body.email, body.event) });
          case 'revoke':
            m.revokeGrants(body.email);
            return json(res, 200, { ok: true });
          case 'expire':
            m.expireAccessTokens(body.email);
            return json(res, 200, { ok: true });
          case 'consent':
            m.consent.deny = body.deny === true;
            m.consent.grantOnly = Array.isArray(body.grantOnly) ? body.grantOnly : null;
            return json(res, 200, { ok: true });
          case 'fail':
            m.failNext(
              { method: body.method, path: body.path },
              { status: body.status, ...(body.body ? { body: body.body } : {}) },
              body.times ?? 1,
            );
            return json(res, 200, { ok: true });
          case 'clear-failures':
            m.clearFailures();
            return json(res, 200, { ok: true });
          default:
            return json(res, 404, { error: 'unknown action' });
        }
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) });
      }
    })
  : null;
if (control) {
  await new Promise((resolve) => control.listen(Number(a['control-port']), '127.0.0.1', resolve));
  console.log(`mock control   http://127.0.0.1:${control.address().port}`);
}

console.log(`mock google    ${google.url}`);
console.log(`mock microsoft ${microsoft.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    control?.close();
    await Promise.all([google.close(), microsoft.close()]);
    process.exit(0);
  });
}
