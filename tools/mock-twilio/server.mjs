#!/usr/bin/env node
/**
 * Starts the mock Twilio REST API + call simulator for local development and the e2e harness
 * (a test double — never a real telephony provider; apps/api refuses
 * TWILIO_BASE_URL_OVERRIDE in production):
 *
 *   node tools/mock-twilio/server.mjs [--port 4630] [--control-port 4631]
 *     [--account-sid AC…] [--auth-token mock-twilio-auth-token] [--from +4930…]
 *
 * Then run the API (development only) with
 *   TWILIO_ACCOUNT_SID=<the account sid printed below> TWILIO_AUTH_TOKEN=<the token>
 *   TWILIO_FROM_NUMBER=<--from> TWILIO_BASE_URL_OVERRIDE=http://127.0.0.1:4630
 *   PUBLIC_WEBHOOK_BASE_URL=http://127.0.0.1:4000   (where the simulator reaches the API)
 *
 * Every call is answered by a simulated callee (default: says "Yes, we have 9:30 or 14:00."
 * and then hangs up). The JSON control channel (127.0.0.1 only) changes that:
 *   POST /scenario         { number, scenario }   a MockScenario for calls to that number
 *   POST /default-scenario { scenario }
 *   POST /fail-next-create { status, code?, message?, afterCreate?, delayMs? }
 *   GET  /calls            every call with what JARVIS said (heard), gathers and the callee's turns
 *   GET  /requests         recorded REST requests (method, path, form, status)
 *   GET  /webhooks         recorded webhooks (kind, url, status)
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { startMockTwilio } from './index.mjs';

const { values: a } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.MOCK_TWILIO_PORT ?? '4630' },
    'control-port': { type: 'string', default: process.env.MOCK_TWILIO_CONTROL_PORT ?? '4631' },
    'account-sid': {
      type: 'string',
      default: process.env.MOCK_TWILIO_ACCOUNT_SID ?? `AC${'0'.repeat(31)}1`,
    },
    'auth-token': {
      type: 'string',
      default: process.env.MOCK_TWILIO_AUTH_TOKEN ?? 'mock-twilio-auth-token',
    },
    from: { type: 'string', default: process.env.MOCK_TWILIO_FROM ?? '+4930901820' },
  },
});

const mock = await startMockTwilio({
  port: Number(a.port),
  accountSid: a['account-sid'],
  authToken: a['auth-token'],
  numbers: [a.from],
  stepMs: 150,
  defaultScenario: {
    outcome: 'answer',
    turns: ['Yes, we have 9:30 or 14:00.'],
  },
});

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};
const view = (c) => ({
  sid: c.sid,
  to: c.to,
  status: c.status,
  answeredBy: c.answeredBy,
  duration: c.duration,
  heard: c.heard,
  gathers: c.gathers,
  said: c.said,
  dials: c.dials,
  errors: c.errors,
});

const control = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && path === '/scenario') {
      const b = await readJson(req);
      mock.setScenario(b.number, b.scenario);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/default-scenario') {
      mock.setDefaultScenario((await readJson(req)).scenario);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/fail-next-create') {
      mock.failNextCreate(await readJson(req));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/calls')
      return json(res, 200, [...mock.calls.values()].map(view));
    if (req.method === 'GET' && path === '/requests') return json(res, 200, mock.requests);
    if (req.method === 'GET' && path === '/webhooks')
      return json(
        res,
        200,
        mock.webhooks.map((w) => ({
          kind: w.kind,
          url: w.url,
          status: w.status,
          callSid: w.callSid,
        })),
      );
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 400, { error: String(err?.message ?? err) });
  }
});
await new Promise((r) => control.listen(Number(a['control-port']), '127.0.0.1', r));

console.log(`mock twilio  ${mock.url}  account ${mock.accountSid}  from ${a.from}`);
console.log(`control      http://127.0.0.1:${a['control-port']}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    control.close();
    await mock.close();
    process.exit(0);
  });
}
