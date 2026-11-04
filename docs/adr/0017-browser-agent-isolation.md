# ADR-0017: Browser agent isolation — a separate browser worker process

- Status: Accepted
- Date: 2026-11-04
- Design: [Phase C architecture](../architecture/phase-c.md) §3.5, §5

## Context

Booking appointments and shopping need a real browser: availability, prices and carts live behind
JavaScript. A browser is the largest attack surface JARVIS will run: hostile pages execute code in
it, try to exfiltrate data through requests, plant instructions in the DOM, download files, and
probe the internal network. Sites also deploy CAPTCHAs, login walls and bot protection, which JARVIS
must never bypass. The agent worker (`src/worker.ts`) holds `SECRET_ENCRYPTION_KEY` (it decrypts
OAuth tokens and SMTP passwords), the model API key and the OAuth client secrets.

## Decision

- **A separate process type: `src/browser-worker.ts`.** It leases only `browser.*` jobs
  (`BROWSER_JOB_KINDS`, today `browser.session`); the agent worker leases and reclaims everything
  else (`lease`/`reclaimExpired` take a kind filter). Deployed as its own container.
- **No secrets in that process.** It is configured with `loadBrowserWorkerConfig`: database URL,
  storage, browser settings — and nothing else. In production it refuses to start when
  `SECRET_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`,
  `DATABASE_OWNER_URL` or `METRICS_TOKEN` is in its environment; in development (one shared `.env`)
  it deletes them from `process.env` before any browser starts. Chromium is launched with an
  explicit minimal `env`, so not even the database URL reaches it.
- **One ephemeral context per session.** `playwright-core` 1.63.0, executable from
  `BROWSER_EXECUTABLE_PATH` (dev default `/opt/pw-browsers/chromium`), headless, Chromium sandbox on
  (the container runs as a non-root user), a fresh `BrowserContext` per `browser_sessions` row, no
  persistent profile, no stored cookies or credentials, `acceptDownloads: false`, service workers
  blocked, viewport `BROWSER_LIMITS.viewport`. The context is closed when the session ends,
  whatever happened.
- **Every request intercepted.** `context.route('**/*')` aborts any request whose URL is not `http(s)`,
  whose origin is not on the recipe's allow-list (`origins`), or whose host resolves to a private or
  reserved address (`lib/net.ts isPrivateAddress`, the classifier webhooks use; dev fixtures only via
  `BROWSER_ALLOW_PRIVATE_HOSTS`, refused in production). Blocked requests are counted
  (`blocked_requests`); a blocked top-level navigation ends the session with `NAVIGATION_BLOCKED`.
  WebSocket and WebRTC are disabled. (An egress proxy is planned as defence in depth, as for
  `web.fetch` — ADR-0015.)
- **Supported sites only, as recipes.** A recipe (`modules/browser/sites/*`) declares its origins,
  operations (`search`, `product`, `cart`, `checkout`, `slots`, `book`, `read`, `fill`), each with
  input/output schemas, side effect (`none` / `reversible` / `binding`), risk, idempotency, budgets
  and verification — like a tool. Fixture recipes exist only with `BROWSER_FIXTURE_ORIGIN`
  (refused in production). The generic `schema-org` reader extracts schema.org `Product` / `Offer` /
  `Reservation` JSON-LD and ICS confirmations from pages of supported sites; it never clicks.
- **Budgets.** `BROWSER_LIMITS`: 90 s per session, 20 s per page load, 20 navigations, 400 requests,
  10 evidence files; a breach stops the session (`BROWSER_BUDGET_EXCEEDED` / `BROWSER_TIMEOUT`).
- **Evidence, always.** Every read stores a PNG screenshot and the extracted data (JSON) in object
  storage under `tenants/<t>/users/<u>/evidence/<id>` (`evidence_artifacts`; deletion queued by the
  attachments trigger). Availability, prices and confirmations come only from the site's live
  response with this evidence — never estimated. No storage → no browser agent
  (`BROWSER_UNAVAILABLE`).
- **Stop and hand over, never bypass.** CAPTCHA (reCAPTCHA / hCaptcha / Turnstile frames, challenge
  pages), login walls and bot-protection interstitials end the session with status `handover`,
  reason `CAPTCHA_DETECTED` / `LOGIN_REQUIRED` / `BOT_PROTECTION` and a `handover_url` where the user
  continues themselves. A missing selector or an error page is `PAGE_CHANGED` / `SITE_ERROR` — the
  recipe never guesses.
- **Page content is untrusted.** Extracted text runs through the injection detector; flags taint
  later steps (UNTRUSTED_CONTENT approvals). Recipes read structured data and fixed selectors; no
  model drives the browser in Phase C, so page text cannot choose what is clicked.
- **Lifecycle rows.** `browser_sessions` records queued → running → succeeded / failed / handover /
  interrupted, the operation and its validated request/result, counters, worker id and timestamps;
  one row per tool execution key (`UNIQUE (user_id, idempotency_key)`). A tool in the agent worker
  inserts the row and the `browser.session` job, then waits for the row to finish (bounded by the
  tool timeout; cancellation via `cancel_requested_at`). A retried binding step finds the existing
  row and its outcome instead of starting a second submission.

## Alternatives considered

- **Chromium as a child of the agent worker.** Simplest, but a renderer escape would run as the user
  that holds every secret (and `/proc/<pid>/environ` is readable by the same user). Rejected.
- **A remote browser service (Browserless, cloud browsers).** Sends users' sessions and evidence to
  a third party; the same isolation is achievable in-house. Possible later behind the same job kind.
- **A dedicated database role for the browser worker.** Stronger (no access to tables it does not
  need); needs RLS on `jobs` per role. Planned (Phase F); Phase C uses `jarvis_app` with RLS, which
  still scopes every row to its owner.
- **Letting a model operate the page (computer use).** Powerful, but turns page text into actions.
  Not in Phase C; recipes are deterministic.

## Consequences

- A deployment runs three process types (API, agent worker, browser worker); `capabilities.browser`
  is true only while a browser worker heartbeats (`worker_heartbeats.kind = 'browser'`).
- Only sites with a recipe are supported; everything else is honestly `SITE_UNSUPPORTED`.
- Browser sessions are slower than `web.fetch` and cost more CPU; budgets and per-user concurrency
  (`maxConcurrentPerUser`) bound them.
