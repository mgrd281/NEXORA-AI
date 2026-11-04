/**
 * The Twilio adapter: Twilio's documented Programmable Voice REST API (2010-04-01) over
 * fetch — application/x-www-form-urlencoded bodies, HTTP Basic AccountSid:AuthToken, JSON
 * resources — at config.telephony.apiBase (https://api.twilio.com, or the local mock outside
 * production). No SDK (ADR-0020). Every request has a timeout (10 s by default); failures are
 * TelephonyErrors classified for exactly-once calls (errors.ts).
 */
import type { TelephonyConfig } from '../../../config';
import type { CreateCallRequest, ProviderCall, ProviderRecording } from '../gateway';
import { httpError, TelephonyError, transportError, type TwilioErrorBody } from './errors';

const API_VERSION = '2010-04-01';
export const TWILIO_TIMEOUT_MS = 10_000;

interface TwilioCallResource {
  sid: string;
  status: string;
  to: string;
  from: string;
  duration: string | null;
  price: string | null;
  price_unit: string | null;
  answered_by: string | null;
  date_created: string | null;
  start_time: string | null;
  end_time: string | null;
}

interface TwilioRecordingResource {
  sid: string;
  status: string;
  duration: string | null;
}

const date = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "-0.01300" USD → { micro: 13000, currency: 'USD' } (absolute value). */
export function parsePrice(
  price: string | null | undefined,
  unit: string | null | undefined,
): ProviderCall['price'] {
  if (price === null || price === undefined || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  const currency = (unit ?? 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { micro: Math.round(Math.abs(n) * 1_000_000), currency };
}

export function toProviderCall(r: TwilioCallResource): ProviderCall {
  const seconds = r.duration === null || r.duration === undefined ? NaN : Number(r.duration);
  return {
    sid: r.sid,
    status: r.status,
    to: r.to,
    from: r.from,
    durationSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null,
    price: parsePrice(r.price, r.price_unit),
    answeredBy: r.answered_by ?? null,
    createdAt: date(r.date_created),
    startTime: date(r.start_time),
    endTime: date(r.end_time),
  };
}

function toRecording(r: TwilioRecordingResource): ProviderRecording {
  const seconds = Number(r.duration);
  return {
    sid: r.sid,
    status: r.status,
    durationSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null,
  };
}

const CALL_SID = /^CA[0-9a-f]{32}$/;
const RECORDING_SID = /^RE[0-9a-f]{32}$/;

export function createTwilioClient(t: TelephonyConfig, opts: { timeoutMs?: number } = {}) {
  const base = `${t.apiBase}/${API_VERSION}/Accounts/${t.accountSid}`;
  const auth = `Basic ${Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64')}`;
  const timeoutMs = opts.timeoutMs ?? TWILIO_TIMEOUT_MS;

  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    o: { form?: [string, string][]; creates?: boolean; raw?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(o.signal ? [o.signal] : [])];
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: o.raw ? 'audio/mpeg' : 'application/json',
          ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(o.form ? { body: new URLSearchParams(o.form).toString() } : {}),
        signal: AbortSignal.any(signals),
        redirect: 'error',
      });
    } catch (err) {
      throw transportError(err, o.creates === true);
    }
    if (!res.ok) {
      let body: TwilioErrorBody | null = null;
      try {
        const text = await res.text();
        body = text ? (JSON.parse(text) as TwilioErrorBody) : null;
      } catch {
        body = null;
      }
      throw httpError(res.status, body, res.headers.get('retry-after'), o.creates === true);
    }
    return res;
  }

  async function json<T>(res: Response, creates = false): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (err) {
      // A 2xx whose body cannot be read: for a create the call may exist.
      throw creates
        ? new TelephonyError('unknown', 'unreadable answer to a create-call request')
        : transportError(err, false);
    }
  }

  const assertSid = (re: RegExp, sid: string) => {
    if (!re.test(sid)) throw new TelephonyError('not_found', 'not a provider id');
  };

  return {
    async createCall(req: CreateCallRequest, signal?: AbortSignal): Promise<ProviderCall> {
      const form: [string, string][] = [
        ['To', req.to],
        ['From', req.from],
        ['Url', req.voiceUrl],
        ['Method', 'POST'],
        ['StatusCallback', req.statusUrl],
        ['StatusCallbackMethod', 'POST'],
        ['StatusCallbackEvent', 'initiated'],
        ['StatusCallbackEvent', 'ringing'],
        ['StatusCallbackEvent', 'answered'],
        ['StatusCallbackEvent', 'completed'],
        ['Timeout', String(req.ringTimeoutSeconds)],
        ['TimeLimit', String(req.timeLimitSeconds)],
      ];
      if (req.amdUrl)
        form.push(
          ['MachineDetection', 'Enable'],
          ['AsyncAmd', 'true'],
          ['AsyncAmdStatusCallback', req.amdUrl],
          ['AsyncAmdStatusCallbackMethod', 'POST'],
        );
      const res = await request('POST', '/Calls.json', { form, creates: true, signal });
      const call = toProviderCall(await json<TwilioCallResource>(res, true));
      if (!CALL_SID.test(call.sid))
        throw new TelephonyError('unknown', 'the create-call answer has no call id');
      return call;
    },

    async updateCall(
      sid: string,
      update: { twiml: string } | { status: 'completed' | 'canceled' },
    ): Promise<ProviderCall> {
      assertSid(CALL_SID, sid);
      const form: [string, string][] =
        'twiml' in update ? [['Twiml', update.twiml]] : [['Status', update.status]];
      const res = await request('POST', `/Calls/${sid}.json`, { form });
      return toProviderCall(await json<TwilioCallResource>(res));
    },

    async fetchCall(sid: string): Promise<ProviderCall> {
      assertSid(CALL_SID, sid);
      return toProviderCall(
        await json<TwilioCallResource>(await request('GET', `/Calls/${sid}.json`)),
      );
    },

    async findCalls(q: { to: string; from: string; since: Date }): Promise<ProviderCall[]> {
      const query = new URLSearchParams({
        To: q.to,
        From: q.from,
        // Day granularity (UTC) at Twilio; the caller filters by the exact time itself.
        'StartTime>=': new Date(q.since.getTime() - 86_400_000).toISOString().slice(0, 10),
        PageSize: '50',
      });
      const res = await request('GET', `/Calls.json?${query.toString()}`);
      const page = await json<{ calls?: TwilioCallResource[] }>(res);
      return (page.calls ?? []).map(toProviderCall);
    },

    async startRecording(callSid: string, statusUrl: string): Promise<ProviderRecording> {
      assertSid(CALL_SID, callSid);
      const res = await request('POST', `/Calls/${callSid}/Recordings.json`, {
        form: [
          ['RecordingStatusCallback', statusUrl],
          ['RecordingStatusCallbackMethod', 'POST'],
          ['RecordingStatusCallbackEvent', 'completed'],
          ['RecordingStatusCallbackEvent', 'absent'],
          ['RecordingChannels', 'mono'],
        ],
      });
      return toRecording(await json<TwilioRecordingResource>(res));
    },

    async fetchRecording(recordingSid: string, maxBytes: number): Promise<Buffer> {
      assertSid(RECORDING_SID, recordingSid);
      const res = await request('GET', `/Recordings/${recordingSid}.mp3`, { raw: true });
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new TelephonyError('rejected', 'the recording is larger than allowed');
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) return Buffer.alloc(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new TelephonyError('rejected', 'the recording is larger than allowed');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    },

    async deleteRecording(recordingSid: string): Promise<void> {
      assertSid(RECORDING_SID, recordingSid);
      await request('DELETE', `/Recordings/${recordingSid}.json`);
    },
  };
}
