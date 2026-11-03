import '../zod-config';
import {
  ApiErrorBody,
  buildPath,
  routes,
  type ErrorCode,
  type RouteBody,
  type RouteName,
  type RouteQuery,
  type RouteResponse,
} from '@jarvis/contracts';
import type { z } from 'zod';

/** Error codes the API sends, plus two the client produces itself. */
export type ClientErrorCode = ErrorCode | 'NETWORK' | 'BAD_RESPONSE';

/** Every failed call rejects with this. `message` is the API's user-safe message. */
export class ApiError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    /** HTTP status; 0 when the request never got a response. */
    readonly status: number,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown, code?: ClientErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

type Def<N extends RouteName> = (typeof routes)[N];
type RouteParams<N extends RouteName> =
  Def<N> extends { params: infer P extends z.ZodType } ? z.input<P> : never;

type IfNever<T, Yes, No> = [T] extends [never] ? Yes : No;

export type CallOptions<N extends RouteName> = IfNever<
  RouteParams<N>,
  { params?: undefined },
  { params: RouteParams<N> }
> &
  IfNever<RouteBody<N>, { body?: undefined }, { body: RouteBody<N> }> &
  IfNever<RouteQuery<N>, { query?: undefined }, { query?: RouteQuery<N> }> & {
    /** Sent as Idempotency-Key on routes that accept one; reuse it when retrying the same intent. */
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

type CallArgs<N extends RouteName> =
  object extends CallOptions<N> ? [options?: CallOptions<N>] : [options: CallOptions<N>];

export interface ApiClientOptions {
  /** Same-origin proxy prefix; next.config.ts rewrites /api/* to the API. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Called once for a 401 on an authenticated route (the session ended or was revoked). */
  onUnauthenticated?: () => void;
}

export interface ApiClient {
  call<N extends RouteName>(name: N, ...args: CallArgs<N>): Promise<RouteResponse<N>>;
}

/**
 * A typed client over the contract route table: request bodies and queries are validated (and
 * defaulted) with the route's Zod schemas before sending, responses are parsed with the route's
 * response schema, and errors become ApiError with the API's code, message and requestId.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '/api';
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<N extends RouteName>(
    name: N,
    ...[opts]: CallArgs<N>
  ): Promise<RouteResponse<N>> {
    const route = routes[name] as Def<N> & {
      params?: z.ZodType;
      query?: z.ZodType;
      body?: z.ZodType;
      response: z.ZodType | null;
      idempotent?: boolean;
      auth: 'none' | 'user' | 'platform_admin';
    };
    const o = (opts ?? {}) as {
      params?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
    };

    let path: string = route.path;
    if (route.params) {
      const params = route.params.safeParse(o.params ?? {});
      if (!params.success) throw invalid(params.error);
      path = buildPath(route.path, params.data as Record<string, string>);
    }

    let search = '';
    if (route.query) {
      const query = route.query.safeParse(o.query ?? {});
      if (!query.success) throw invalid(query.error);
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query.data as Record<string, unknown>)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      search = s ? `?${s}` : '';
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (route.body) {
      const parsed = route.body.safeParse(o.body ?? {});
      if (!parsed.success) throw invalid(parsed.error);
      body = JSON.stringify(parsed.data);
      headers['content-type'] = 'application/json';
    }
    if (o.idempotencyKey && route.idempotent) headers['idempotency-key'] = o.idempotencyKey;

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}${search}`, {
        method: route.method,
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: o.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('NETWORK', 'Network request failed', 0);
    }

    if (!res.ok) {
      const error = await toApiError(res);
      if (error.status === 401 && route.auth !== 'none') options.onUnauthenticated?.();
      throw error;
    }

    if (route.response === null || res.status === 204) {
      return undefined as RouteResponse<N>;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError('BAD_RESPONSE', 'The response was not valid JSON', res.status);
    }
    const parsed = route.response.safeParse(json);
    if (!parsed.success) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[api] ${name} response does not match the contract`, parsed.error.issues);
      }
      throw new ApiError(
        'BAD_RESPONSE',
        'The response did not match the contract',
        res.status,
        res.headers.get('x-request-id') ?? undefined,
      );
    }
    return parsed.data as RouteResponse<N>;
  }

  return { call };
}

function invalid(error: z.ZodError): ApiError {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return new ApiError('VALIDATION_FAILED', `${where}${issue?.message ?? 'Invalid request'}`, 0);
}

async function toApiError(res: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON error (e.g. the proxy could not reach the API).
  }
  const parsed = ApiErrorBody.safeParse(payload);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ApiError(e.code, e.message, res.status, e.requestId, e.details);
  }
  const code: ClientErrorCode =
    res.status === 401
      ? 'UNAUTHENTICATED'
      : res.status === 403
        ? 'FORBIDDEN'
        : res.status === 404
          ? 'NOT_FOUND'
          : res.status === 429
            ? 'RATE_LIMITED'
            : res.status >= 500
              ? res.status === 502 || res.status === 503 || res.status === 504
                ? 'NETWORK'
                : 'INTERNAL'
              : 'BAD_RESPONSE';
  return new ApiError(code, res.statusText || 'Request failed', res.status);
}

let redirecting = false;

/** Sends the browser to /sign-in, remembering where it was. Runs at most once per page. */
export function redirectToSignIn(): void {
  if (typeof window === 'undefined' || redirecting) return;
  // Signed-out pages (sign-in, the dev component gallery) handle 401s themselves.
  if (
    window.location.pathname.startsWith('/sign-in') ||
    window.location.pathname.startsWith('/dev/')
  ) {
    return;
  }
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}`;
  // A full load: cached data of the ended session must not survive.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/sign-in?next=${encodeURIComponent(next)}&reason=expired`);
}

/** The app-wide client: same-origin /api proxy, 401 → sign-in. */
export const api: ApiClient = createApiClient({ onUnauthenticated: redirectToSignIn });

/** A fresh Idempotency-Key per user intent (one submission = one key, reused on retry). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
