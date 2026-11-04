/**
 * The one wrapper every Gmail / Calendar / Graph call goes through
 * (docs/architecture/phase-c.md §3.1): a valid access token (refreshed when
 * needed), the provider's fixed host, a timeout, and error mapping —
 *   401        one forced refresh and one retry, then CONNECTION_EXPIRED (TOKEN_REJECTED)
 *   403 scope  the capability is removed → CONNECTION_SCOPE_MISSING { provider, capability }
 *   429        TOOL_FAILED, transient, PROVIDER_RATE_LIMITED { provider, seconds } (Retry-After)
 *   5xx / timeout / network  PROVIDER_UNAVAILABLE, transient — or OUTCOME_UNKNOWN for a
 *              non-idempotent write that may have been processed (`unsafe`)
 *   other 4xx  PROVIDER_REJECTED { provider, status }
 * Statuses the caller handles itself (404, 409, 410, 412) are returned.
 * Access tokens only ever travel in the Authorization header to these hosts.
 */
import type { ConnectionCapability } from '@jarvis/contracts';
import type { DbContext } from '../../db/pool';
import { AgentError } from '../agent/errors';
import { providerSignal } from './signal';
import {
  accessToken,
  connectionExpiredError,
  markScopeMissing,
  markTokenRejected,
  providerUnavailableError,
  scopeMissingError,
} from './tokens';
import { PROVIDER_NAME, type IntegrationDeps, type OAuthProvider } from './types';

export interface ProviderCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  json?: unknown;
  headers?: Record<string, string>;
  /** Statuses returned to the caller instead of thrown. */
  accept?: readonly number[];
  /** The capability the call relies on (a 403 for missing scope removes it). */
  capability: ConnectionCapability;
  /**
   * A non-idempotent write (send, draft): a timeout, network error or 5xx
   * after the request left may mean it was processed → OUTCOME_UNKNOWN.
   */
  unsafe?: boolean;
  timeoutMs?: number;
}

export interface ProviderResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  headers: Headers;
}

/** At most this long is reported as Retry-After (an hour). */
const MAX_RETRY_AFTER = 3600;

export function retryAfterSeconds(headers: Headers, now = Date.now()): number {
  const raw = headers.get('retry-after');
  if (!raw) return 30;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(MAX_RETRY_AFTER, Math.ceil(n));
  const at = Date.parse(raw);
  if (!Number.isNaN(at))
    return Math.min(MAX_RETRY_AFTER, Math.max(0, Math.ceil((at - now) / 1000)));
  return 30;
}

interface ErrorBody {
  error?: { code?: unknown; errors?: unknown; details?: unknown };
}
const reasonsOf = (list: unknown): unknown[] =>
  Array.isArray(list) ? list.map((x: { reason?: unknown } | null) => x?.reason) : [];

/** Google insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT; Graph ErrorAccessDenied / Authorization_RequestDenied. */
export function isScopeError(
  provider: OAuthProvider,
  status: number,
  body: unknown,
  headers: Headers,
): boolean {
  if (status !== 403) return false;
  if (/insufficient_scope/i.test(headers.get('www-authenticate') ?? '')) return true;
  const e = (body as ErrorBody | null)?.error;
  if (provider === 'google') {
    const reasons = [...reasonsOf(e?.errors), ...reasonsOf(e?.details)];
    return reasons.some(
      (r) => r === 'insufficientPermissions' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    );
  }
  return e?.code === 'ErrorAccessDenied' || e?.code === 'Authorization_RequestDenied';
}

function buildUrl(call: ProviderCall): string {
  const url = new URL(call.url);
  for (const [k, v] of Object.entries(call.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function outcomeUnknown(provider: OAuthProvider): AgentError {
  return new AgentError(
    'OUTCOME_UNKNOWN',
    `${PROVIDER_NAME[provider]} stopped responding while the change was being made, so JARVIS cannot tell whether it happened. Check before retrying.`,
    { retryable: false, reason: 'SEND_INTERRUPTED' },
  );
}

async function send(call: ProviderCall, token: string, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...(call.json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...call.headers,
  };
  return fetch(buildUrl(call), {
    method: call.method,
    headers,
    body: call.json !== undefined ? JSON.stringify(call.json) : undefined,
    signal: providerSignal(signal, call.timeoutMs),
    redirect: 'error',
  });
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Calls the provider for this connection with its access token (see the file header). */
export async function providerCall(
  deps: IntegrationDeps,
  ctx: DbContext,
  conn: { id: string; provider: OAuthProvider },
  call: ProviderCall,
  signal?: AbortSignal,
): Promise<ProviderResponse> {
  const provider = conn.provider;
  let { token } = await accessToken(deps, ctx, conn.id, { signal });
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await send(call, token, signal);
    } catch (err) {
      if (signal?.aborted && !call.unsafe) throw err;
      throw call.unsafe ? outcomeUnknown(provider) : providerUnavailableError(provider);
    }
    if (res.status !== 401) break;
    await res.body?.cancel().catch(() => {});
    if (attempt >= 2) {
      // A freshly refreshed token was refused too: the grant is gone.
      await markTokenRejected(deps, ctx, conn.id);
      throw connectionExpiredError(provider);
    }
    ({ token } = await accessToken(deps, ctx, conn.id, {
      forceRefresh: true,
      rejectedToken: token,
      signal,
    }));
  }
  let body: unknown;
  try {
    body = await parse(res);
  } catch {
    if (call.unsafe && res.ok) throw outcomeUnknown(provider);
    body = null;
  }
  if (res.ok || call.accept?.includes(res.status))
    return { status: res.status, json: body, headers: res.headers };
  if (res.status === 403 && isScopeError(provider, res.status, body, res.headers)) {
    await markScopeMissing(deps, ctx, conn.id, call.capability);
    throw scopeMissingError(provider, call.capability);
  }
  if (res.status === 429) {
    const seconds = retryAfterSeconds(res.headers);
    throw new AgentError(
      'TOOL_FAILED',
      `${PROVIDER_NAME[provider]} asked JARVIS to slow down. Nothing was changed; try again in ${seconds} seconds.`,
      {
        retryable: true,
        transient: true,
        reason: 'PROVIDER_RATE_LIMITED',
        params: { provider, seconds },
      },
    );
  }
  if (res.status >= 500) {
    if (call.unsafe) throw outcomeUnknown(provider);
    throw providerUnavailableError(provider);
  }
  throw new AgentError(
    'TOOL_FAILED',
    `${PROVIDER_NAME[provider]} refused the request (${res.status}).`,
    { retryable: false, reason: 'PROVIDER_REJECTED', params: { provider, status: res.status } },
  );
}
