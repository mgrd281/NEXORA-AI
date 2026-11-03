# JARVIS web (`@jarvis/web`)

Next.js 16 App Router · React 19 · CSS Modules on Meridian tokens · TanStack Query 5.

```bash
pnpm --filter @jarvis/web dev            # http://localhost:3000 (API at API_ORIGIN, default http://127.0.0.1:4000)
pnpm --filter @jarvis/web typecheck | lint | test
NEXT_DIST_DIR=.next-foundation pnpm --filter @jarvis/web build
```

## Layout of `src/`

| Path                                                | What                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `app/layout.tsx`                                    | `<html lang dir data-theme>` from the `jarvis_locale` / `jarvis_theme` cookies, fonts |
| `app/(app)/layout.tsx`                              | Session-cookie check → `/sign-in?next=…`, then `<AppShell>`                           |
| `app/(app)/**/page.tsx`                             | Screens (placeholders until built)                                                    |
| `app/api/v1/events`                                 | Streaming SSE proxy to the API (`/api/*` is otherwise a rewrite)                      |
| `app/dev/components`                                | Component gallery (development only)                                                  |
| `components/ui`                                     | Meridian primitives                                                                   |
| `components/presence`                               | Presence ring + `presenceFromTask` / `deriveAssistantPresence`                        |
| `components/{composer,approvals,voice,tasks,shell}` | Shared feature components                                                             |
| `i18n`                                              | Catalogs (`messages/{en,de,ar}/<namespace>.ts`), `t()`, formatters                    |
| `lib/api`                                           | Typed client (`api.call`), `ApiError`, query keys (`qk`), shared hooks                |
| `lib/events`                                        | `EventStreamProvider`, `useStreamEvent`, `useAnswerStream`, invalidation map          |
| `proxy.ts`                                          | Per-request nonce CSP                                                                 |

## Rules of the road

- Copy only through `t('namespace.key', params)` (`useI18n()` / `useT()`; `getServerI18n()` on the
  server). Add a key to **all three** locales — `test/i18n-catalogs.test.ts` fails otherwise.
  Plurals: `{count, plural, one {# task} other {# tasks}}` (Arabic also needs zero/two/few/many).
- Logical CSS only (`margin-inline-start`, `inset-inline-end` …); tokens only (no raw hex).
  Type styles: `font: var(--text-body)` in modules or the `.t-body` utility classes.
- Server data only through React Query with keys from `lib/api/query-keys.ts`; realtime events
  invalidate those keys automatically.
- User content: `dir="auto"` or `<bdi>`; URLs, emails, hashes in `.ltr` spans.
- Icons only via `<Icon icon={…} />` (lucide), `mirror` for directional ones.

## Visual tests (mock API)

```bash
pnpm --filter @jarvis/web dev                                        # or build + start
PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @jarvis/web e2e:visual
```

`e2e/support/mock-api.ts` serves contract-validated fixtures (`e2e/support/fixtures.ts`) for every
`/api/v1/**` route; screenshots land in `test-results/screenshots/`. `e2e/real/*` runs against the
real API when `E2E_EMAIL` / `E2E_PASSWORD` are set.
