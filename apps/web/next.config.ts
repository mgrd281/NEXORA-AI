import type { NextConfig } from 'next';

/** Where the browser-facing `/api/*` proxy forwards to (the Fastify API). */
const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:4000').replace(/\/+$/, '');

/**
 * Static security headers for every response. The Content-Security-Policy is set per request
 * with a fresh script nonce in `src/proxy.ts` (see `src/lib/security/csp.ts`), because a static
 * policy would need `script-src 'unsafe-inline'` for the App Router's inline bootstrap scripts.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    // Voice mode needs the microphone on this origin only; nothing else is used.
    value:
      'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()',
  },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  // The floating dev-tools badge overlaps the sidebar footer in screenshots.
  devIndicators: false,
  transpilePackages: ['@jarvis/contracts', '@jarvis/tokens'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    // Returned as an array, so these apply after the filesystem: the streaming route handler at
    // src/app/api/v1/events/route.ts wins over this rewrite for the SSE endpoint.
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
