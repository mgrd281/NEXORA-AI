import type { NextRequest } from 'next/server';
import { EVENTS_PATH } from '@jarvis/contracts';

/**
 * Same-origin proxy for the API's Server-Sent Events stream (GET /v1/events). Route handlers
 * take precedence over the /api/* rewrite, which would buffer; this one pipes the upstream body
 * through unchanged and closes the upstream request when the browser disconnects.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:4000').replace(/\/+$/, '');

/** Request headers the API needs: the session cookie, resume position and request context. */
const FORWARDED = ['cookie', 'last-event-id', 'user-agent', 'x-request-id', 'accept-language'];

export async function GET(request: NextRequest): Promise<Response> {
  const upstreamUrl = new URL(EVENTS_PATH, API_ORIGIN);
  const lastEventId = request.nextUrl.searchParams.get('lastEventId');
  if (lastEventId && /^\d{1,15}$/.test(lastEventId)) {
    upstreamUrl.searchParams.set('lastEventId', lastEventId);
  }

  const headers = new Headers({ accept: 'text/event-stream' });
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

  const upstreamAbort = new AbortController();
  request.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers,
      signal: upstreamAbort.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: { code: 'INTERNAL', message: 'The event stream is unavailable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !upstream.body || !contentType.startsWith('text/event-stream')) {
    // Pass errors (401, 429 …) through as JSON so the browser's EventSource fails cleanly.
    const body = await upstream.text().catch(() => '');
    return new Response(body, {
      status: upstream.ok ? 502 : upstream.status,
      headers: {
        'content-type': contentType || 'application/json',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform keeps compression middleware from buffering the stream.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
