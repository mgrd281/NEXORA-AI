# ADR-0012: Web app on Next.js 16 App Router with a same-origin API proxy

- Status: Accepted
- Date: 2026-11-03

## Context

The web app is the primary surface during Milestone 1. It must keep the session cookie first-party,
stream task events, support RTL, and stay fast on mobile browsers.

## Decision

- **Next.js 16.4.4 App Router**, React 19.3.1, TypeScript.
- **Client data with TanStack Query 5**: server state is fetched from the API and cached per query key;
  SSE events invalidate or patch the affected queries. No second source of truth in client stores.
- **Same-origin `/api` proxy**: the browser only talks to the web origin; Next.js forwards `/api/*` to
  the API. The `jarvis_session` cookie stays first-party (`SameSite=Lax`), no CORS is needed, and the
  API's CSRF check compares `Origin` with `WEB_ORIGIN`.
- **SSE via a route handler proxy** that streams `GET /v1/events` through without buffering and
  forwards `Last-Event-ID`.
- **Styling: CSS Modules + Meridian CSS variables**, logical properties (`margin-inline-start`,
  `inset-inline-end`, `text-align: start`) so `dir="rtl"` mirrors layouts without per-component
  overrides. No Tailwind.
- **Fonts via `next/font`** (IBM Plex Sans, IBM Plex Sans Arabic, IBM Plex Mono), self-hosted at build
  time — no runtime requests to font CDNs.
- Shared types and validation from `@jarvis/contracts`; icons from `lucide-react` (names from
  `tokens.icons`).
- Tests: Vitest for units, Playwright 1.63 + `@axe-core/playwright` for end-to-end and accessibility.

Status: Milestone 1 (in progress).

## Alternatives considered

- **SPA (Vite) + separate static hosting.** Simpler build, but loses the proxy/route-handler layer that
  keeps cookies first-party, and server rendering of the shell.
- **Calling the API cross-origin with CORS.** Third-party cookie and CSRF complications; rejected.
- **Tailwind.** Fast to write, but physical-direction utilities (`ml-*`) make RTL error-prone and
  duplicate the token layer.

## Consequences

- The web server is in the request path for API calls and the stream; it must not buffer SSE and must
  pass `Origin`, `User-Agent` and `X-Request-Id` through.
- Next.js upgrades are pinned and deliberate ([ADR-0001](0001-monorepo.md)).
