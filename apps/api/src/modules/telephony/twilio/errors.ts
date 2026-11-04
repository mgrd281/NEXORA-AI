/**
 * Errors of the telephony provider (Twilio REST), classified by what they mean for exactly-once
 * calls (docs/architecture/phase-d.md §3.2):
 *   unavailable   nothing reached the provider (connection refused, DNS, TLS, connect timeout)
 *                 or it answered 5xx to a request that changes nothing — retryable, nothing placed
 *   unknown       a request that CREATES a call was sent and its outcome is unknown (timeout after
 *                 sending, a reset connection, any 5xx): the call may exist → reconcile first
 *   rate_limited  429 (Retry-After seconds) — nothing placed
 *   rejected      another 4xx (Twilio error code: invalid number, geo permissions, unverified
 *                 caller id …) — nothing placed
 *   auth          401 / 403 (the account's credentials) — nothing placed
 *   not_found     404 (a call / recording the provider does not know)
 * Twilio error bodies are { code, message, more_info, status }; only code and status are kept
 * (messages can contain the number).
 */
import { AgentError } from '../../agent/errors';

export type TelephonyErrorKind =
  'unavailable' | 'unknown' | 'rate_limited' | 'rejected' | 'auth' | 'not_found';

export class TelephonyError extends Error {
  constructor(
    readonly kind: TelephonyErrorKind,
    message: string,
    readonly details: {
      status?: number;
      /** Twilio's error code (e.g. 21215), when its body had one. */
      code?: number;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = 'TelephonyError';
  }
}

/** Twilio's documented error body. */
export interface TwilioErrorBody {
  code?: number;
  message?: string;
  more_info?: string;
  status?: number;
}

/** A transport failure of fetch: did the request leave this process (unknown) or not (unavailable)? */
export function transportError(err: unknown, creates: boolean): TelephonyError {
  const e = err as { name?: string; cause?: { code?: string } } | null;
  const code = e?.cause?.code ?? '';
  const notConnected = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ].includes(code);
  if (notConnected || !creates)
    return new TelephonyError(
      'unavailable',
      `telephony provider unreachable (${code || e?.name || 'error'})`,
    );
  return new TelephonyError(
    'unknown',
    `telephony provider did not answer (${code || e?.name || 'error'})`,
  );
}

/** An HTTP error answer of the provider. */
export function httpError(
  status: number,
  body: TwilioErrorBody | null,
  retryAfter: string | null,
  creates: boolean,
): TelephonyError {
  const code = typeof body?.code === 'number' ? body.code : undefined;
  if (status === 429) {
    const seconds = Number(retryAfter);
    return new TelephonyError('rate_limited', 'telephony provider rate limit', {
      status,
      code,
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60,
    });
  }
  if (status >= 500)
    return new TelephonyError(
      creates ? 'unknown' : 'unavailable',
      `telephony provider error ${status}`,
      {
        status,
        code,
      },
    );
  if (status === 401 || status === 403)
    return new TelephonyError('auth', `telephony provider refused the credentials (${status})`, {
      status,
      code,
    });
  if (status === 404)
    return new TelephonyError('not_found', 'not found at the telephony provider', { status, code });
  return new TelephonyError(
    'rejected',
    `telephony provider rejected the request (${code ?? status})`,
    {
      status,
      code,
    },
  );
}

/**
 * The step error of a provider failure BEFORE any call was placed (rate limit, refusal,
 * unreachable): nothing happened, so a retry is safe. `unknown` is not handled here (the
 * caller turns it into OUTCOME_UNKNOWN / CALL_STATE_UNKNOWN).
 */
export function providerStepError(err: TelephonyError): AgentError {
  switch (err.kind) {
    case 'rate_limited':
      return new AgentError(
        'TOOL_FAILED',
        'The telephony provider is rate limiting calls right now.',
        {
          retryable: true,
          reason: 'PROVIDER_RATE_LIMITED',
          params: { provider: 'twilio', seconds: err.details.retryAfterSeconds ?? 60 },
        },
      );
    case 'rejected':
    case 'auth':
    case 'not_found':
      return new AgentError('TOOL_FAILED', 'The telephony provider refused to place the call.', {
        retryable: true,
        reason: 'PROVIDER_REJECTED',
        params: { provider: 'twilio', status: err.details.status ?? 400 },
      });
    default:
      return new AgentError('TOOL_FAILED', 'The telephony provider cannot be reached right now.', {
        retryable: true,
        reason: 'PROVIDER_UNAVAILABLE',
        params: { provider: 'twilio' },
      });
  }
}
