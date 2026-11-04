/**
 * The telephony gateway seam (docs/architecture/phase-d.md §3.3, §4.5; ADR-0020): what the
 * phone agent needs from a provider. Twilio is the only implementation (twilio/client.ts,
 * its documented REST API — no SDK); the seam keeps another provider possible and lets
 * tests point the same adapter at the local mock (TWILIO_BASE_URL_OVERRIDE, never in
 * production).
 *
 * Every URL the provider is given is PUBLIC_WEBHOOK_BASE_URL + a telephonyWebhookRoutes path
 * + `?t=<the call's URL token>` (webhookUrl): the signature the webhook route group checks is
 * computed over exactly that URL.
 */
import { buildPath, telephonyWebhookRoutes, type TelephonyWebhookName } from '@jarvis/contracts';
import type { Config } from '../../config';
import { createTwilioClient } from './twilio/client';

export interface CreateCallRequest {
  /** E.164. */
  to: string;
  /** E.164: this server's caller id (never the user's number, never spoofed). */
  from: string;
  /** Fetched when the call is answered (TwiML). */
  voiceUrl: string;
  /** Status callbacks: initiated, ringing, answered, completed. */
  statusUrl: string;
  /** Asynchronous answering-machine detection result; null = no detection. */
  amdUrl: string | null;
  /** How long it rings before the attempt is no-answer. */
  ringTimeoutSeconds: number;
  /** The provider hangs up after this long (the call's second bound after the dialog's own). */
  timeLimitSeconds: number;
}

/** A provider's call record (Twilio Call resource, the fields JARVIS uses). */
export interface ProviderCall {
  sid: string;
  /** Twilio CallStatus: queued, initiated, ringing, in-progress, completed, busy, failed, no-answer, canceled. */
  status: string;
  to: string;
  from: string;
  /** Seconds, once ended. */
  durationSeconds: number | null;
  /** The provider's price (absolute value) in micro-units of `currency`; null while unknown. */
  price: { micro: number; currency: string } | null;
  answeredBy: string | null;
  createdAt: Date | null;
  startTime: Date | null;
  endTime: Date | null;
}

export interface ProviderRecording {
  sid: string;
  status: string;
  durationSeconds: number | null;
}

export interface TelephonyGateway {
  readonly provider: 'twilio';
  /** The caller id calls show. */
  readonly callerId: string;
  /** POST …/Calls.json. TelephonyError 'unknown' when the outcome cannot be known. */
  createCall(req: CreateCallRequest, signal?: AbortSignal): Promise<ProviderCall>;
  /** POST …/Calls/{Sid}.json: new TwiML for a live call, or end it. */
  updateCall(
    sid: string,
    update: { twiml: string } | { status: 'completed' | 'canceled' },
  ): Promise<ProviderCall>;
  /** GET …/Calls/{Sid}.json. */
  fetchCall(sid: string): Promise<ProviderCall>;
  /** GET …/Calls.json?To&From&StartTime>=: calls to `to` from `from` created since `since`. */
  findCalls(q: { to: string; from: string; since: Date }): Promise<ProviderCall[]>;
  /** POST …/Calls/{Sid}/Recordings.json with a recording status callback. */
  startRecording(callSid: string, statusUrl: string): Promise<ProviderRecording>;
  /** GET …/Recordings/{Sid}.mp3, at most `maxBytes`. */
  fetchRecording(recordingSid: string, maxBytes: number): Promise<Buffer>;
  /** DELETE …/Recordings/{Sid}.json (the provider's copy, after it was stored). */
  deleteRecording(recordingSid: string): Promise<void>;
  /** The public URL of a webhook route for one call / verification, carrying its URL token. */
  webhookUrl(
    name: TelephonyWebhookName,
    id: string,
    token: string,
    extra?: Record<string, string | number>,
  ): string;
}

/** The gateway of this server, or null when no telephony provider is configured. */
export function createTelephonyGateway(
  config: Pick<Config, 'telephony'>,
  opts: { timeoutMs?: number } = {},
): TelephonyGateway | null {
  const t = config.telephony;
  if (!t) return null;
  const client = createTwilioClient(t, opts);
  return {
    provider: 'twilio',
    callerId: t.fromNumber,
    ...client,
    webhookUrl(name, id, token, extra = {}) {
      const def = telephonyWebhookRoutes[name];
      const params: Record<string, string> =
        def.target === 'call' ? { callId: id } : { verificationId: id };
      const query = new URLSearchParams({ t: token });
      for (const [k, v] of Object.entries(extra)) query.set(k, String(v));
      return `${t.webhookBase}${buildPath(def.path, params)}?${query.toString()}`;
    },
  };
}
