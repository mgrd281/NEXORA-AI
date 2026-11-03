import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, createNonce } from './lib/security/csp';

/**
 * Sets a nonce-based Content-Security-Policy on every page request. Next.js reads the policy
 * from the request headers and adds the nonce to the scripts it renders. Authentication is not
 * decided here: the (app) layout checks the session cookie, and the API validates the session.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  // Lets the authenticated layout send a signed-out visitor back here after sign-in.
  requestHeaders.set('x-jarvis-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API proxy, static assets or metadata files.
      source: '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
