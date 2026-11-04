/**
 * Mock Twilio — the Programmable Voice REST API (2010-04-01) and a call simulator, for
 * development and tests only (apps/api refuses TWILIO_BASE_URL_OVERRIDE in production and
 * never imports this module from src/). Dependency-free Node.
 *
 * REST resources (Twilio's documented shapes: JSON resources with sid, status, price,
 * price_unit, uri …; errors as { code, message, more_info, status }), HTTP Basic auth
 * AccountSid:AuthToken, application/x-www-form-urlencoded bodies:
 *   POST   /2010-04-01/Accounts/{AC}/Calls.json                    create (To, From, Url, Method,
 *          StatusCallback, StatusCallbackEvent, StatusCallbackMethod, Timeout, TimeLimit,
 *          MachineDetection, AsyncAmd, AsyncAmdStatusCallback, AsyncAmdStatusCallbackMethod)
 *   GET    /2010-04-01/Accounts/{AC}/Calls.json?To&From&StartTime>=  list (one page)
 *   GET    /2010-04-01/Accounts/{AC}/Calls/{CA}.json                fetch
 *   POST   /2010-04-01/Accounts/{AC}/Calls/{CA}.json                update (Twiml | Url | Status)
 *   POST   /2010-04-01/Accounts/{AC}/Calls/{CA}/Recordings.json     start a recording
 *   GET    /2010-04-01/Accounts/{AC}/Recordings/{RE}.json | .mp3    fetch metadata | media
 *   DELETE /2010-04-01/Accounts/{AC}/Recordings/{RE}.json           delete
 *
 * The call simulator drives every created call the way Twilio does: status callbacks
 * (initiated, ringing, answered, completed — form-encoded, with SequenceNumber, Timestamp
 * (RFC 2822), CallbackSource, CallDuration), the voice URL on answer, asynchronous
 * answering-machine detection, and executes the TwiML it gets back: <Say>, <Pause>,
 * <Gather input="speech"> (answered with the scenario's next utterance and a Confidence),
 * <Redirect>, <Dial><Number>, <Hangup>, <Reject>. Every webhook is signed exactly like
 * Twilio signs it (X-Twilio-Signature: base64 HMAC-SHA1 with the auth token over the full
 * URL followed by the sorted POST parameters, name + value) — implemented here on its own,
 * not shared with the API.
 *
 * Scenarios are chosen per callee number (setScenario) or by default; see index.d.mts for the
 * switches (answer / busy / no-answer / failed / reject / machine / timeout / error500,
 * scripted speech turns, silence, low confidence, hang-up mid-call, duplicated and
 * out-of-order callbacks, stale timestamps, tampered signatures, wrong account, transfers,
 * recordings). Every REST request and every webhook is recorded, so tests can prove that a
 * call was placed exactly once and that nothing was recorded without consent.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { elements, parseTwiml, textOf } from './twiml.mjs';

export { parseTwiml, textOf, elements } from './twiml.mjs';

const API = '/2010-04-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => randomBytes(n).toString('hex');
export const newSid = (prefix) => `${prefix}${hex(16)}`;

/** Twilio's request signature, implemented independently of apps/api (same documented algorithm). */
export function twilioSignature(authToken, url, params) {
  let data = url;
  for (const name of Object.keys(params).sort()) {
    const v = params[name];
    for (const value of Array.isArray(v) ? [...v].sort() : [v]) data += name + value;
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** RFC 2822 dates as Twilio writes them ("Tue, 04 Nov 2026 10:00:00 +0000"). */
export function rfc2822(d = new Date()) {
  return d.toUTCString().replace('GMT', '+0000');
}

const E164 = /^\+[1-9]\d{7,14}$/;

function twilioError(status, code, message) {
  return { status, code, message, more_info: `https://www.twilio.com/docs/errors/${code}` };
}

async function readForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const form = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    if (k in form) form[k] = Array.isArray(form[k]) ? [...form[k], v] : [form[k], v];
    else form[k] = v;
  }
  return { raw, form };
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const words = (t) => String(t).split(/\s+/).filter(Boolean).length;

/** A tiny fake MP3 (ID3 header + MPEG frames): a test double, not audio anyone recorded. */
function fakeMp3(seconds) {
  const frame = Buffer.alloc(417, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  const frames = Math.max(1, Math.round(seconds * 38));
  return Buffer.concat([
    Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'),
    ...Array(frames).fill(frame),
  ]);
}

function normaliseUtterance(u) {
  if (u === undefined || u === null) return null;
  if (typeof u === 'string') return { say: u, confidence: 0.92 };
  return u;
}

/**
 * Starts the mock. Options: accountSid, authToken (required for signing), numbers (caller ids
 * the account owns), port, host, stepMs (simulated pacing), defaultScenario.
 */
export async function startMockTwilio(opts = {}) {
  const accountSid = opts.accountSid ?? `AC${'0'.repeat(31)}1`;
  const authToken = opts.authToken;
  if (!authToken) throw new Error('mock twilio: authToken is required');
  const owned = new Set(opts.numbers ?? []);
  const stepMs = opts.stepMs ?? 5;
  let defaultScenario = opts.defaultScenario ?? { outcome: 'answer', turns: [] };
  const scenarios = new Map();
  const calls = new Map();
  const recordings = new Map();
  const requests = [];
  const webhooks = [];
  const createFailures = [];
  const listeners = new Set();
  let baseUrl = '';

  const notify = () => {
    for (const l of [...listeners]) l();
  };

  /* --------------------------------- resources --------------------------------- */

  const callUri = (sid) => `${API}/Accounts/${accountSid}/Calls/${sid}.json`;
  function callResource(c) {
    return {
      account_sid: accountSid,
      annotation: null,
      answered_by: c.answeredBy,
      api_version: '2010-04-01',
      caller_name: null,
      date_created: rfc2822(c.dateCreated),
      date_updated: rfc2822(c.dateUpdated),
      direction: 'outbound-api',
      duration: c.endTime ? String(c.duration) : null,
      end_time: c.endTime ? rfc2822(c.endTime) : null,
      forwarded_from: null,
      from: c.from,
      from_formatted: c.from,
      group_sid: null,
      parent_call_sid: null,
      phone_number_sid: `PN${'0'.repeat(32)}`,
      price: c.price,
      price_unit: 'USD',
      queue_time: '0',
      sid: c.sid,
      start_time: c.startTime ? rfc2822(c.startTime) : null,
      status: c.status,
      subresource_uris: {
        recordings: `${API}/Accounts/${accountSid}/Calls/${c.sid}/Recordings.json`,
      },
      to: c.to,
      to_formatted: c.to,
      trunk_sid: null,
      uri: callUri(c.sid),
    };
  }
  function recordingResource(r) {
    return {
      account_sid: accountSid,
      api_version: '2010-04-01',
      call_sid: r.callSid,
      conference_sid: null,
      channels: 1,
      date_created: rfc2822(r.dateCreated),
      date_updated: rfc2822(r.dateUpdated),
      start_time: rfc2822(r.dateCreated),
      duration: r.status === 'completed' ? String(r.duration) : '-1',
      encryption_details: null,
      error_code: null,
      price: r.status === 'completed' ? '-0.00250' : null,
      price_unit: 'USD',
      sid: r.sid,
      source: 'StartCallRecordingAPI',
      status: r.status,
      track: 'both',
      uri: `${API}/Accounts/${accountSid}/Recordings/${r.sid}.json`,
    };
  }

  /* --------------------------------- webhooks ---------------------------------- */

  async function postWebhook(call, kind, url, params, extra = {}) {
    const sc = call?.scenario ?? {};
    const signed = { ...params };
    if (sc.wrongAccount) signed.AccountSid = `AC${'f'.repeat(32)}`;
    const token = sc.tamperSignature ? `${authToken}-tampered` : authToken;
    const signature = twilioSignature(token, url, signed);
    const record = {
      kind,
      url,
      params: signed,
      status: 0,
      body: '',
      callSid: call?.sid ?? null,
      signature,
    };
    webhooks.push(record);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          'x-twilio-signature': signature,
          'user-agent': 'TwilioProxy/1.1',
          'i-twilio-idempotency-token': `${call?.sid ?? 'x'}-${webhooks.length}`,
          ...extra.headers,
        },
        body: new URLSearchParams(
          Object.entries(signed).flatMap(([k, v]) =>
            Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
          ),
        ),
        signal: AbortSignal.timeout(15_000),
      });
      record.status = res.status;
      record.body = await res.text();
    } catch (err) {
      record.status = -1;
      record.body = String(err?.message ?? err);
    }
    notify();
    return record;
  }

  function baseParams(c) {
    return {
      AccountSid: accountSid,
      ApiVersion: '2010-04-01',
      CallSid: c.sid,
      CallStatus: c.status,
      Called: c.to,
      Caller: c.from,
      Direction: 'outbound-api',
      From: c.from,
      To: c.to,
    };
  }

  async function statusCallback(c, event, extra = {}) {
    if (!c.statusCallback) return;
    const wanted = c.statusEvents;
    if (event !== 'completed' && !wanted.has(event)) return;
    const seq = c.sequence++;
    const sc = c.scenario;
    const at = sc.staleTimestamps ? new Date(Date.now() - 3_600_000) : new Date();
    const params = {
      ...baseParams(c),
      CallbackSource: 'call-progress-events',
      SequenceNumber: String(seq),
      Timestamp: rfc2822(at),
      ...extra,
    };
    const send = () => postWebhook(c, `status:${event}`, c.statusCallback, params);
    if (sc.outOfOrder && event === 'ringing') {
      // Delivered late: after the answered callback (with its own, lower sequence number).
      c.delayed.push(send);
      return;
    }
    await send();
    if (sc.duplicateCallbacks) await send();
    if (sc.outOfOrder && event === 'answered') for (const d of c.delayed.splice(0)) await d();
  }

  /* --------------------------------- simulator --------------------------------- */

  async function fetchTwiml(c, kind, url, params) {
    const r = await postWebhook(c, kind, url, { ...baseParams(c), ...params });
    if (r.status !== 200) return null;
    return r.body;
  }

  function nextUtterance(c, ctx) {
    const sc = c.scenario;
    if (c.answeredBy && c.answeredBy.startsWith('machine')) return { silence: true };
    let u = c.utterances.shift();
    if (typeof u === 'function') u = u(ctx);
    u = normaliseUtterance(u);
    if (u) return u;
    return sc.whenDone === 'silence' ? { silence: true } : { hangup: true };
  }

  async function endCall(c, status = 'completed', extra = {}) {
    if (c.ended) return;
    c.ended = true;
    c.generation++;
    c.status = status;
    c.endTime = status === 'completed' ? new Date() : null;
    if (status === 'completed') c.endTime = new Date();
    c.duration = status === 'completed' ? Math.max(1, Math.round(c.seconds)) : 0;
    c.price = status === 'completed' ? (-(Math.ceil(c.duration / 60) * 0.013)).toFixed(5) : null;
    c.dateUpdated = new Date();
    for (const r of recordings.values()) {
      if (r.callSid === c.sid && r.status === 'in-progress') {
        r.status = 'completed';
        r.duration = Math.max(1, Math.round(c.seconds - r.startedAtSeconds));
        r.media = fakeMp3(r.duration);
        r.dateUpdated = new Date();
        if (r.callback)
          await postWebhook(c, 'recording', r.callback, {
            AccountSid: accountSid,
            CallSid: c.sid,
            RecordingSid: r.sid,
            RecordingUrl: `${baseUrl}${API}/Accounts/${accountSid}/Recordings/${r.sid}`,
            RecordingStatus: 'completed',
            RecordingDuration: String(r.duration),
            RecordingChannels: '1',
            RecordingSource: 'StartCallRecordingAPI',
            RecordingStartTime: rfc2822(r.dateCreated),
          });
      }
    }
    await statusCallback(c, 'completed', {
      CallStatus: status,
      ...(status === 'completed'
        ? { CallDuration: String(c.duration), Duration: String(Math.ceil(c.duration / 60)) }
        : {}),
      ...extra,
    });
    notify();
  }

  async function dial(c, verb, gen) {
    const sc = c.scenario;
    const numberEl = elements(verb).find((e) => e.name === 'Number');
    const target = numberEl ? textOf(numberEl) : textOf(verb);
    const d = { outcome: 'answered', seconds: 20, ...(sc.dial ?? {}) };
    c.dials.push({
      to: target,
      callerId: verb.attrs.callerId ?? null,
      timeout: verb.attrs.timeout ?? null,
      // What the dialled party heard before being bridged (<Number url> whisper TwiML).
      whisper: [],
    });
    await sleep(stepMs);
    if (c.generation !== gen || c.ended) return null;
    const childSid = newSid('CA');
    let status = d.outcome;
    let bridged = false;
    if (status === 'answered') {
      bridged = true;
      // <Number url>: the dialled party's leg (a child call, Direction outbound-dial) requests
      // the whisper TwiML after answering and before the parties are bridged; the TwiML runs on
      // that leg only. A <Hangup/> there (or an error) ends that leg: nobody is put through.
      if (numberEl?.attrs.url) {
        const r = await postWebhook(c, 'dial:whisper', new URL(numberEl.attrs.url, baseUrl).href, {
          ...baseParams({ ...c, sid: childSid, to: target, status: 'in-progress' }),
          Direction: 'outbound-dial',
          ParentCallSid: c.sid,
        });
        const dial = c.dials.at(-1);
        if (r.status !== 200) bridged = false;
        else {
          try {
            const doc = parseTwiml(r.body);
            for (const v of elements(doc)) {
              if (v.name === 'Say')
                dial.whisper.push({
                  text: textOf(v),
                  language: v.attrs.language ?? null,
                  voice: v.attrs.voice ?? null,
                });
              if (v.name === 'Hangup' || v.name === 'Reject') bridged = false;
            }
          } catch {
            bridged = false;
          }
        }
      }
      if (bridged) c.seconds += d.seconds;
      status = 'completed';
    }
    if (!verb.attrs.action) return bridged ? '<Response><Hangup/></Response>' : '';
    return fetchTwiml(c, 'dial', new URL(verb.attrs.action, baseUrl).href, {
      DialCallStatus: status,
      DialCallSid: childSid,
      ...(status === 'completed'
        ? bridged
          ? { DialCallDuration: String(d.seconds), DialBridged: 'true' }
          : { DialCallDuration: '0', DialBridged: 'false' }
        : {}),
    });
  }

  /** Executes a TwiML document for the call (one "generation"; an update starts another). */
  async function execute(c, xml, gen) {
    let doc;
    try {
      doc = parseTwiml(xml);
    } catch (err) {
      c.errors.push(String(err.message));
      return endCall(c, 'completed');
    }
    for (const verb of elements(doc)) {
      if (c.generation !== gen || c.ended) return;
      switch (verb.name) {
        case 'Say': {
          const text = textOf(verb);
          c.heard.push({
            text,
            language: verb.attrs.language ?? null,
            voice: verb.attrs.voice ?? null,
          });
          c.seconds += Math.max(1, words(text) / 2.5);
          await sleep(stepMs);
          break;
        }
        case 'Pause':
          c.seconds += Number(verb.attrs.length ?? 1);
          await sleep(stepMs);
          break;
        case 'Gather': {
          for (const child of elements(verb))
            if (child.name === 'Say') {
              const text = textOf(child);
              c.heard.push({
                text,
                language: child.attrs.language ?? null,
                voice: child.attrs.voice ?? null,
              });
              c.seconds += Math.max(1, words(text) / 2.5);
            }
          const gather = {
            input: verb.attrs.input ?? 'dtmf',
            language: verb.attrs.language ?? 'en-US',
            action: verb.attrs.action ?? null,
            speechTimeout: verb.attrs.speechTimeout ?? null,
            prompt: elements(verb)
              .filter((e) => e.name === 'Say')
              .map(textOf),
          };
          c.gathers.push(gather);
          // The callee takes a moment to answer (a live call the UI can watch); default: none.
          await sleep(stepMs + (c.scenario.turnDelayMs ?? 0));
          if (c.generation !== gen || c.ended) return;
          const u = nextUtterance(c, { heard: c.heard, gather, call: callResource(c) });
          if (u.hangup) return endCall(c, 'completed');
          c.seconds += u.say ? Math.max(2, words(u.say) / 2.5) : 5;
          if (!u.say && verb.attrs.actionOnEmptyResult !== 'true') break;
          if (!gather.action) return endCall(c, 'completed');
          c.said.push(u.say ?? null);
          const next = await fetchTwiml(c, 'gather', new URL(gather.action, baseUrl).href, {
            ...(u.say ? { SpeechResult: u.say, Confidence: String(u.confidence ?? 0.92) } : {}),
          });
          if (c.generation !== gen || c.ended) return;
          if (next === null) return endCall(c, 'completed');
          return execute(c, next, gen);
        }
        case 'Redirect': {
          const next = await fetchTwiml(c, 'redirect', new URL(textOf(verb), baseUrl).href, {});
          if (c.generation !== gen || c.ended) return;
          if (next === null) return endCall(c, 'completed');
          return execute(c, next, gen);
        }
        case 'Dial': {
          const next = await dial(c, verb, gen);
          if (c.generation !== gen || c.ended) return;
          if (next) return execute(c, next, gen);
          break;
        }
        case 'Hangup':
        case 'Reject':
          return endCall(c, 'completed');
        default:
          c.errors.push(`unsupported verb <${verb.name}>`);
      }
    }
    if (c.generation === gen && !c.ended) return endCall(c, 'completed');
  }

  async function simulate(c) {
    const sc = c.scenario;
    await sleep(stepMs);
    c.status = 'initiated';
    await statusCallback(c, 'initiated');
    if (sc.outcome === 'failed') {
      await sleep(stepMs);
      return endCall(c, 'failed', { SipResponseCode: String(sc.sipResponseCode ?? 503) });
    }
    await sleep(sc.ringMs ?? stepMs * 2);
    if (c.ended) return;
    c.status = 'ringing';
    await statusCallback(c, 'ringing');
    await sleep(sc.ringMs ?? stepMs * 2);
    if (c.ended) return;
    if (sc.outcome === 'busy') return endCall(c, 'busy', { SipResponseCode: '486' });
    if (sc.outcome === 'no-answer') return endCall(c, 'no-answer', { SipResponseCode: '487' });
    // Answered (by a person or a machine).
    c.status = 'in-progress';
    c.startTime = new Date();
    c.dateUpdated = new Date();
    await statusCallback(c, 'answered');
    const machine = sc.outcome === 'machine';
    const amd = first(c.params.MachineDetection);
    const asyncAmd = String(first(c.params.AsyncAmd)) === 'true';
    if (amd && !asyncAmd) c.answeredBy = machine ? 'machine_end_beep' : 'human';
    const gen = c.generation;
    const voice = fetchTwiml(
      c,
      'voice',
      c.url,
      amd && !asyncAmd ? { AnsweredBy: c.answeredBy } : {},
    );
    if (amd && asyncAmd && first(c.params.AsyncAmdStatusCallback)) {
      // The detection result arrives while the TwiML is already running.
      (async () => {
        await sleep(sc.amdDelayMs ?? stepMs * 3);
        if (c.ended) return;
        c.answeredBy = machine ? (sc.answeredBy ?? 'machine_end_beep') : (sc.answeredBy ?? 'human');
        await postWebhook(c, 'amd', first(c.params.AsyncAmdStatusCallback), {
          AccountSid: accountSid,
          CallSid: c.sid,
          AnsweredBy: c.answeredBy,
          MachineDetectionDuration: '2350',
        });
      })();
    }
    const xml = await voice;
    if (c.generation !== gen || c.ended) return;
    if (xml === null) return endCall(c, 'completed');
    await execute(c, xml, gen);
  }

  /* --------------------------------- REST API ---------------------------------- */

  function authorised(req) {
    const h = String(req.headers.authorization ?? '');
    if (!h.startsWith('Basic ')) return false;
    const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    return user === accountSid && rest.join(':') === authToken;
  }

  async function createCall(form, res) {
    const to = first(form.To);
    const from = first(form.From);
    const url = first(form.Url);
    if (!to || !E164.test(to))
      return [
        400,
        twilioError(400, 21211, `The 'To' number ${to ?? ''} is not a valid phone number.`),
      ];
    if (!from || (owned.size > 0 && !owned.has(from)))
      return [
        400,
        twilioError(
          400,
          21210,
          `The source phone number provided, ${from ?? ''}, is not yet verified for your account.`,
        ),
      ];
    if (!url && !first(form.Twiml))
      return [400, twilioError(400, 21205, 'Url or Twiml is required.')];
    const sc = { ...defaultScenario, ...(scenarios.get(to) ?? {}) };
    const injected = createFailures.shift();
    if (sc.outcome === 'reject')
      return [
        sc.rejectStatus ?? 400,
        twilioError(
          sc.rejectStatus ?? 400,
          sc.rejectCode ?? 21215,
          sc.rejectMessage ?? `Account not authorized to call ${to}.`,
        ),
      ];
    if (injected && !injected.afterCreate)
      return [
        injected.status,
        injected.body ??
          twilioError(
            injected.status,
            injected.code ?? 20500,
            injected.message ?? 'Internal Server Error',
          ),
      ];
    const events = [form.StatusCallbackEvent ?? []]
      .flat()
      .flatMap((e) => String(e).split(/\s+/))
      .filter(Boolean);
    const now = new Date();
    const c = {
      sid: newSid('CA'),
      to,
      from,
      url,
      params: form,
      status: 'queued',
      dateCreated: now,
      dateUpdated: now,
      startTime: null,
      endTime: null,
      duration: 0,
      seconds: 0,
      price: null,
      answeredBy: null,
      statusCallback: first(form.StatusCallback) ?? null,
      statusEvents: new Set(events),
      scenario: sc,
      utterances: [...(sc.turns ?? [])],
      sequence: 0,
      generation: 0,
      ended: false,
      heard: [],
      gathers: [],
      said: [],
      dials: [],
      updates: [],
      errors: [],
      delayed: [],
    };
    calls.set(c.sid, c);
    notify();
    simulate(c).catch((err) => c.errors.push(String(err?.message ?? err)));
    if (sc.outcome === 'timeout' || injected?.delayMs) {
      // Accepted, but the answer comes too late for the client: its outcome is unknown there.
      await sleep(sc.responseDelayMs ?? injected?.delayMs ?? 15_000);
    }
    if (sc.outcome === 'error500' || injected?.afterCreate) {
      res.writeHead(500);
      res.end();
      return null;
    }
    return [201, callResource(c)];
  }

  async function updateCall(c, form) {
    c.updates.push({ ...form });
    const status = first(form.Status);
    const twiml = first(form.Twiml);
    const url = first(form.Url);
    if (status === 'completed' || status === 'canceled') {
      if (!c.ended) {
        if (c.status === 'in-progress') await endCall(c, 'completed');
        else await endCall(c, status === 'canceled' ? 'canceled' : 'completed');
      }
      return [200, callResource(c)];
    }
    if (c.ended) return [400, twilioError(400, 21220, 'Call is not in-progress. Cannot redirect.')];
    if (twiml || url) {
      c.generation++;
      const gen = c.generation;
      (async () => {
        const xml = twiml ?? (await fetchTwiml(c, 'redirect', url, {}));
        if (xml) await execute(c, xml, gen);
      })().catch((err) => c.errors.push(String(err?.message ?? err)));
      return [200, callResource(c)];
    }
    return [400, twilioError(400, 21218, 'Invalid update.')];
  }

  async function route(req, res, url, form) {
    const path = url.pathname;
    const m = new RegExp(`^${API}/Accounts/([^/]+)/(.+)$`).exec(path);
    if (!m) return [404, twilioError(404, 20404, 'The requested resource was not found')];
    if (m[1] !== accountSid)
      return [404, twilioError(404, 20404, `The requested resource ${path} was not found`)];
    const rest = m[2];
    let r;
    if (rest === 'Calls.json' && req.method === 'POST') return createCall(form, res);
    if (rest === 'Calls.json' && req.method === 'GET') {
      const q = url.searchParams;
      const after = q.get('StartTime>=') ?? q.get('StartTime>');
      const list = [...calls.values()].filter(
        (c) =>
          (!q.get('To') || c.to === q.get('To')) &&
          (!q.get('From') || c.from === q.get('From')) &&
          (!after || c.dateCreated.toISOString().slice(0, 10) >= after.slice(0, 10)),
      );
      const size = Number(q.get('PageSize') ?? 50);
      return [
        200,
        {
          calls: list.slice(0, size).map(callResource),
          end: Math.min(list.length, size) - 1,
          first_page_uri: `${API}/Accounts/${accountSid}/Calls.json?PageSize=${size}&Page=0`,
          next_page_uri: null,
          page: 0,
          page_size: size,
          previous_page_uri: null,
          start: 0,
          uri: `${API}/Accounts/${accountSid}/Calls.json?PageSize=${size}&Page=0`,
        },
      ];
    }
    if ((r = /^Calls\/(CA[0-9a-f]{32})\.json$/.exec(rest))) {
      const c = calls.get(r[1]);
      if (!c) return [404, twilioError(404, 20404, `The requested resource ${path} was not found`)];
      if (req.method === 'GET') return [200, callResource(c)];
      if (req.method === 'POST') return updateCall(c, form);
    }
    if ((r = /^Calls\/(CA[0-9a-f]{32})\/Recordings\.json$/.exec(rest)) && req.method === 'POST') {
      const c = calls.get(r[1]);
      if (!c) return [404, twilioError(404, 20404, `The requested resource ${path} was not found`)];
      if (c.ended || c.status !== 'in-progress')
        return [400, twilioError(400, 21220, 'Requested resource is not eligible for recording')];
      const now = new Date();
      const rec = {
        sid: newSid('RE'),
        callSid: c.sid,
        status: 'in-progress',
        dateCreated: now,
        dateUpdated: now,
        startedAtSeconds: c.seconds,
        duration: 0,
        media: null,
        callback: first(form.RecordingStatusCallback) ?? null,
        deleted: false,
        params: { ...form },
      };
      recordings.set(rec.sid, rec);
      notify();
      return [201, recordingResource(rec)];
    }
    if ((r = /^Recordings\/(RE[0-9a-f]{32})\.(json|mp3)$/.exec(rest))) {
      const rec = recordings.get(r[1]);
      if (!rec || rec.deleted)
        return [404, twilioError(404, 20404, `The requested resource ${path} was not found`)];
      if (req.method === 'DELETE' && r[2] === 'json') {
        rec.deleted = true;
        notify();
        return [204, null];
      }
      if (req.method === 'GET' && r[2] === 'json') return [200, recordingResource(rec)];
      if (req.method === 'GET' && r[2] === 'mp3') {
        if (!rec.media) return [404, twilioError(404, 20404, 'The recording is not available yet')];
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': rec.media.length });
        res.end(rec.media);
        return null;
      }
    }
    return [404, twilioError(404, 20404, `The requested resource ${path} was not found`)];
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { form } = await readForm(req);
    const record = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form,
      authorised: authorised(req),
      status: 0,
      at: new Date(),
    };
    requests.push(record);
    try {
      let out;
      if (!record.authorised) out = [401, twilioError(401, 20003, 'Authenticate')];
      else out = await route(req, res, url, form);
      if (out === null) {
        record.status = res.statusCode;
        return;
      }
      const [status, body] = out;
      record.status = status;
      if (body === null) {
        res.writeHead(status);
        res.end();
      } else {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      }
    } catch (err) {
      record.status = 500;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(twilioError(500, 20500, String(err?.message ?? err))));
    } finally {
      notify();
    }
  });

  await new Promise((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://${opts.host ?? '127.0.0.1'}:${port}`;

  /** Resolves when `predicate()` is truthy (re-checked on every request / webhook / state change). */
  function waitFor(predicate, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let v;
        try {
          v = predicate();
        } catch (err) {
          listeners.delete(check);
          clearTimeout(timer);
          reject(err);
          return;
        }
        if (v) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error('mock twilio: timed out waiting'));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  }

  return {
    url: baseUrl,
    port,
    accountSid,
    authToken,
    calls,
    recordings,
    requests,
    webhooks,
    setScenario(number, scenario) {
      scenarios.set(number, scenario);
    },
    clearScenarios() {
      scenarios.clear();
    },
    setDefaultScenario(scenario) {
      defaultScenario = scenario;
    },
    /** The next create-call request fails like this (status, code, message; afterCreate: 500 after creating it; delayMs: answer late). */
    failNextCreate(f) {
      createFailures.push(f);
    },
    callsTo(number) {
      return [...calls.values()].filter((c) => c.to === number);
    },
    /** POST …/Calls.json requests (dial attempts), optionally to one number. */
    createRequests(number) {
      return requests.filter(
        (r) =>
          r.method === 'POST' &&
          /\/Calls\.json$/.test(r.path) &&
          (!number || first(r.form.To) === number),
      );
    },
    recordingRequests() {
      return requests.filter((r) => r.method === 'POST' && /\/Recordings\.json$/.test(r.path));
    },
    waitFor,
    waitForEnded(sid, timeoutMs) {
      return waitFor(() => calls.get(sid)?.ended && calls.get(sid), timeoutMs);
    },
    /** Sends a recorded webhook again, byte for byte (same URL, parameters and signature). */
    replay(record) {
      return postWebhook(null, `replay:${record.kind}`, record.url, record.params, {
        headers: { 'x-twilio-signature': record.signature },
      });
    },
    /** Sends an arbitrary webhook, signed with `signWith` (default: the account's token). */
    async sendWebhook(url, params, { signWith = authToken, signature } = {}) {
      const sig = signature ?? twilioSignature(signWith, url, params);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sig,
        },
        body: new URLSearchParams(params),
      });
      return { status: res.status, body: await res.text() };
    },
    async close() {
      for (const c of calls.values()) {
        c.ended = true;
        c.generation++;
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
