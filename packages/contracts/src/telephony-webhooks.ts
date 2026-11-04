/**
 * Phase D — the telephony provider's webhooks (docs/architecture/phase-d.md §3.3,
 * docs/adr/0020-telephony-gateway.md).
 *
 * A separate route group, NOT part of the user API table (`routes`): these
 * requests come from Twilio, carry no session and are never called by clients.
 * Each one is unauthenticated at the session level and authenticated instead by
 *   1. the X-Twilio-Signature header: base64 HMAC-SHA1, keyed with the account's
 *      auth token, of the full public URL (PUBLIC_WEBHOOK_BASE_URL + path + query)
 *      followed by every form parameter name and value, sorted by name;
 *   2. the call's own URL token `t` (random, TELEPHONY_WEBHOOK_LIMITS.urlTokenBytes,
 *      stored only as a SHA-256 hash), which also selects the RLS context of the
 *      call's owner through a narrow SECURITY DEFINER function;
 *   3. liveness, replay and idempotency rules: status callbacks older than
 *      TELEPHONY_WEBHOOK_LIMITS.maxEventAgeSeconds or out of sequence are ignored,
 *      a gather turn is processed once (its sequence `n` is in the signed URL), and
 *      an ended call accepts nothing after lateEventGraceSeconds.
 * The server registers a handler for every entry (and fails to boot outside the
 * pending list otherwise); OpenAPI documents them under the tag `telephony-webhooks`.
 */
import { z } from 'zod';
import { TELEPHONY_WEBHOOK_LIMITS } from './limits';

/** Every telephony webhook path starts with this (the route group's prefix). */
export const TELEPHONY_WEBHOOK_PREFIX = '/v1/telephony/';
/** The header Twilio signs requests with. */
export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

/** base64url of TELEPHONY_WEBHOOK_LIMITS.urlTokenBytes random bytes, without padding. */
const tokenChars = Math.ceil((TELEPHONY_WEBHOOK_LIMITS.urlTokenBytes * 4) / 3);
export const WebhookUrlToken = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${tokenChars}}$`), 'the call’s URL token');

/** Twilio resource ids (two letters + 32 hex digits). */
export const TwilioCallSid = z.string().regex(/^CA[0-9a-f]{32}$/);
export const TwilioAccountSid = z.string().regex(/^AC[0-9a-f]{32}$/);
export const TwilioRecordingSid = z.string().regex(/^RE[0-9a-f]{32}$/);

/** Twilio's CallStatus values (Call resource and status callbacks). */
export const TwilioCallStatus = z.enum([
  'queued',
  'initiated',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);
export type TwilioCallStatus = z.infer<typeof TwilioCallStatus>;

/** Answering-machine detection results (AsyncAmd / AnsweredBy). */
export const TwilioAnsweredBy = z.enum([
  'human',
  'machine_start',
  'machine_end_beep',
  'machine_end_silence',
  'machine_end_other',
  'fax',
  'unknown',
]);
export type TwilioAnsweredBy = z.infer<typeof TwilioAnsweredBy>;

/**
 * The parameters every voice webhook of a call carries. Loose objects: Twilio adds
 * parameters over time and the signature covers all of them, so unknown ones are
 * kept (and ignored), never rejected.
 */
const CallParams = z.looseObject({
  CallSid: TwilioCallSid,
  AccountSid: TwilioAccountSid,
  From: z.string().max(64).optional(),
  To: z.string().max(64).optional(),
  CallStatus: TwilioCallStatus.optional(),
  Direction: z.string().max(32).optional(),
  ApiVersion: z.string().max(16).optional(),
});

/** The voice URL (`Url` of the create-call request): fetched when the call is answered. */
export const TwilioVoiceForm = CallParams;
/** `<Gather input="speech" action=…>`: what the callee said (absent = nothing recognised). */
export const TwilioGatherForm = CallParams.extend({
  SpeechResult: z.string().max(4_000).optional(),
  /** "0.0" … "1.0" as text. */
  Confidence: z.string().max(16).optional(),
  Digits: z.string().max(32).optional(),
});
/** StatusCallback with StatusCallbackEvent initiated, ringing, answered, completed. */
export const TwilioStatusForm = CallParams.extend({
  CallStatus: TwilioCallStatus,
  /** Seconds, on the final callback. */
  CallDuration: z.string().max(16).optional(),
  /** RFC 2822, when the event fired (replay window). */
  Timestamp: z.string().max(64).optional(),
  /** 0, 1, 2 … per call (out-of-order and repeated callbacks are ignored). */
  SequenceNumber: z.string().max(16).optional(),
  CallbackSource: z.string().max(64).optional(),
  SipResponseCode: z.string().max(8).optional(),
  AnsweredBy: TwilioAnsweredBy.optional(),
});
/** AsyncAmdStatusCallback: the answering-machine detection result. */
export const TwilioAmdForm = CallParams.extend({
  AnsweredBy: TwilioAnsweredBy,
  MachineDetectionDuration: z.string().max(16).optional(),
});
/** `<Dial action=…>` of a transfer to the account's own number. */
export const TwilioDialForm = CallParams.extend({
  DialCallStatus: z.enum(['completed', 'answered', 'busy', 'no-answer', 'failed', 'canceled']),
  DialCallSid: TwilioCallSid.optional(),
  DialCallDuration: z.string().max(16).optional(),
  DialBridged: z.string().max(8).optional(),
});
/** RecordingStatusCallback of a recording started after the callee's consent. */
export const TwilioRecordingForm = z.looseObject({
  AccountSid: TwilioAccountSid,
  CallSid: TwilioCallSid,
  RecordingSid: TwilioRecordingSid,
  RecordingUrl: z.string().max(2_048),
  RecordingStatus: z.enum(['in-progress', 'completed', 'absent', 'failed']),
  RecordingDuration: z.string().max(16).optional(),
  RecordingChannels: z.string().max(4).optional(),
  RecordingSource: z.string().max(64).optional(),
  ErrorCode: z.string().max(16).optional(),
});

const CallTarget = z.object({ callId: z.uuid() });
const VerificationTarget = z.object({ verificationId: z.uuid() });
const TokenQuery = z.object({ t: WebhookUrlToken });
/** Gather: the turn sequence this answer belongs to (processed once). */
const GatherQuery = TokenQuery.extend({ n: z.coerce.number().int().min(0).max(1_000) });

export interface TelephonyWebhookDef {
  method: 'POST';
  /** Fastify-style path under TELEPHONY_WEBHOOK_PREFIX. */
  path: string;
  summary: string;
  provider: 'twilio';
  /** What the URL token and the path id select: a call attempt or a verification call. */
  target: 'call' | 'verification';
  params: z.ZodObject;
  query: z.ZodObject;
  /** application/x-www-form-urlencoded body. */
  form: z.ZodObject;
  /** 'twiml': 200 text/xml TwiML; 'empty': 204 No Content. */
  responds: 'twiml' | 'empty';
}

export const telephonyWebhookRoutes = {
  twilioCallVoice: {
    method: 'POST',
    path: '/v1/telephony/twilio/calls/:callId/voice',
    summary: 'Twilio: the call was answered — TwiML with the AI disclosure and the first question',
    provider: 'twilio',
    target: 'call',
    params: CallTarget,
    query: TokenQuery,
    form: TwilioVoiceForm,
    responds: 'twiml',
  },
  twilioCallGather: {
    method: 'POST',
    path: '/v1/telephony/twilio/calls/:callId/gather',
    summary: 'Twilio: what the callee said (speech) — TwiML with JARVIS’s next line',
    provider: 'twilio',
    target: 'call',
    params: CallTarget,
    query: GatherQuery,
    form: TwilioGatherForm,
    responds: 'twiml',
  },
  twilioCallStatus: {
    method: 'POST',
    path: '/v1/telephony/twilio/calls/:callId/status',
    summary: 'Twilio: call progress (initiated, ringing, answered, completed and final status)',
    provider: 'twilio',
    target: 'call',
    params: CallTarget,
    query: TokenQuery,
    form: TwilioStatusForm,
    responds: 'empty',
  },
  twilioCallAmd: {
    method: 'POST',
    path: '/v1/telephony/twilio/calls/:callId/amd',
    summary: 'Twilio: answering-machine detection result',
    provider: 'twilio',
    target: 'call',
    params: CallTarget,
    query: TokenQuery,
    form: TwilioAmdForm,
    responds: 'empty',
  },
  twilioCallDial: {
    method: 'POST',
    path: '/v1/telephony/twilio/calls/:callId/dial',
    summary: 'Twilio: result of putting the callee through to the account’s own number',
    provider: 'twilio',
    target: 'call',
    params: CallTarget,
    query: TokenQuery,
    form: TwilioDialForm,
    responds: 'twiml',
  },
  twilioCallRecording: {
    method: 'POST',
    path: '/v1/telephony/twilio/calls/:callId/recording',
    summary: 'Twilio: recording status (only for calls recorded with the callee’s consent)',
    provider: 'twilio',
    target: 'call',
    params: CallTarget,
    query: TokenQuery,
    form: TwilioRecordingForm,
    responds: 'empty',
  },
  twilioVerificationVoice: {
    method: 'POST',
    path: '/v1/telephony/twilio/verifications/:verificationId/voice',
    summary: 'Twilio: the verification call was answered — TwiML that reads the code',
    provider: 'twilio',
    target: 'verification',
    params: VerificationTarget,
    query: TokenQuery,
    form: TwilioVoiceForm,
    responds: 'twiml',
  },
  twilioVerificationStatus: {
    method: 'POST',
    path: '/v1/telephony/twilio/verifications/:verificationId/status',
    summary: 'Twilio: verification call progress and final status',
    provider: 'twilio',
    target: 'verification',
    params: VerificationTarget,
    query: TokenQuery,
    form: TwilioStatusForm,
    responds: 'empty',
  },
} as const satisfies Record<string, TelephonyWebhookDef>;

export type TelephonyWebhookName = keyof typeof telephonyWebhookRoutes;
