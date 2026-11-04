# Known limitations

> **Status note:** most of this page was written for Milestone 1. Phases B–D since added
> conversations, attachments, schedules, webhooks, OAuth (Google/Microsoft), email and calendar
> agents, booking, the browser and shopping agents, voice conversation and the phone agent — see
> [phase-b](architecture/phase-b.md), [phase-c](architecture/phase-c.md) and
> [phase-d](architecture/phase-d.md). A full reconciliation of this page is scheduled for the final phase.

An honest list for Milestone 1. Items marked **issue** are defects to fix; the rest are scope limits
by design or by environment. Last reviewed: 2026-11-03.

## Environment and verification

- **iOS app not compiled here.** The development container has no Swift toolchain or Xcode; the
  SwiftUI app (`apps/ios`) has not been built, run or tested in this environment. It needs a macOS
  machine with Xcode and XcodeGen before any claim about it is verified.
- **No live model calls.** There is no `ANTHROPIC_API_KEY` in this environment. Model mode is covered
  by tests with a scripted adapter (`apps/api/test/fixtures/scripted-model.ts`) and unit tests of the
  Anthropic adapter with a fake client; real plan quality, latency, refusal behaviour, prompt-cache
  hits and costs are unmeasured ([costs](costs.md) are estimates).
- **No public internet in tests.** `web.fetch` and SMTP are tested against local fixture servers
  (`test/fixtures/http-site.ts`, `smtp-sink.ts`) through the development allow-lists.
- **Not deployed.** The deployment topology, backups and SLOs are proposals; no metrics pipeline
  exists, so API p95 < 500 ms is a target, not a measurement.

## Known issues (at the time of writing)

- **resolved — SMTP to public IPv4 hosts refused.** Fixed in the integration round: `lib/net.ts`
  now keeps separate IPv4/IPv6 BlockLists and checks IPv4-mapped addresses via the embedded IPv4
  address; `web.fetch` delegates to the same classifier. Regression tests: `test/unit/agent/net.test.ts`.
- **resolved — decryption failure reported as `OUTCOME_UNKNOWN`.** Failures before any SMTP data
  (secret decryption, SSRF check, transport setup) are now definite `CONNECTION_FAILED` (retryable).
- **resolved — budget month boundary.** Budget enforcement and the usage screen share one
  time-zone-aware month boundary (`lib/period.ts`), resolved against `pg_timezone_names`.

## Agent and tools

- **Five tools only:** `web.fetch`, `text.summarize`, `email.send`, `memory.save`, `assistant.answer`.
  No calendar, Gmail/IMAP (reading email), browser agent, telephony, documents, scheduling or
  purchases. The tables `call_sessions`, `browser_sessions` and `scheduled_tasks` exist but are
  unused.
- **No re-planning:** plans are fixed before execution (≤ 8 sequential steps); JARVIS cannot decide
  next steps from what it read. Multi-stage work needs follow-up requests.
- **Offline planner limits:** understands only "summarize <link> [and email it to me]", "remember
  that …" and "email me: …" (en/de/ar, pattern-based). Any other request with a link is treated as
  "summarize this link"; everything else fails with `PLANNER_UNSUPPORTED`. Offline summaries are
  extractive (lead sentences), and `assistant.answer` (general questions) is unavailable.
- **Language detection is heuristic** (Arabic script, German/English marker words); mixed-language
  requests may get the account language.
- **`web.fetch`:** no JavaScript rendering (single-page apps often have no readable text), HTML /
  XHTML / plain text / JSON only (no PDF), 2 MB, 5 redirects, 10 s, first 20 000 characters of text,
  public addresses only. Intranet pages cannot be read by design.
- **`email.send`:** plain text only, `to` only (no CC/BCC, attachments, HTML, replies or threading),
  ≤ 10 recipients, each written in the request or the owner's own address; sends through the owner's
  SMTP account only.
- **`assistant.answer`** answers from the model's knowledge plus the owner's notes; it cannot browse.
- **Prompt-injection detection is pattern-based** (en/de/ar). It flags; it does not block. Structural
  defences carry the guarantee ([threat model](security/threat-model.md#prompt-injection)); a page can
  still bias summary wording.
- **Unknown outcomes are real:** a crash or timeout while an email is being handed over leaves the
  outcome unknown (`OUTCOME_UNKNOWN`); the user must check their Sent folder before an acknowledged
  retry.
- **Cancellation is cooperative:** a step that is already executing finishes or times out first;
  `VERIFYING` cannot be cancelled.
- **Approval expiry depends on the worker:** the `approval.expire` job runs at `expires_at`; if no
  worker runs then, the approval stays `PENDING` until a worker runs or someone tries to decide it
  (which expires it).

## Memory

- **No semantic retrieval:** pgvector is not available, so memory search and planner retrieval use
  PostgreSQL full-text (`'simple'`, no stemming) plus substring matching. Paraphrases, German compound
  words and Arabic morphology reduce recall.
- Notes reach the planner only in model mode (top 10 by text rank).

## Realtime and voice

- **SSE, not WebSocket.** One-way server → client. Replay after reconnect is limited to the 200 newest
  missed events; streamed answer deltas are ephemeral and not replayed (the final answer is stored).
  Realtime two-way voice (WebSocket/WebRTC) is Phase 5.
- **Web speech depends on the browser vendor.** The Web Speech API is not available in every browser
  (e.g. Firefox), and Chrome processes audio on Google's servers. JARVIS never receives audio, but it
  cannot keep audio on the device on the web. On iOS, recognition is on-device only where the device
  and language support it; otherwise Apple's speech service is used.
- Spoken replies (`preferences.voice.speakResponses`) use the platform's speech synthesis; available
  voices and quality depend on the browser or OS.

## Accounts, security and operations

- **Invitation only:** accounts are created with `cli create-owner`; no sign-up, invite UI, password
  reset or password change, OIDC, Sign in with Apple, passkeys or MFA yet.
- **Single-member tenants:** the `member` role exists in the schema, but sharing and multi-member
  tenants are not implemented; `users` RLS is tenant-scoped and will need a restricted view first.
- **Secret rotation is single-key:** rotating `SECRET_ENCRYPTION_KEY` requires reconnecting SMTP
  accounts; keyring + re-encryption is planned.
- **Per-process limits:** rate limits (`@fastify/rate-limit` in-memory store) and the 10-streams-per-user
  SSE cap are counted per API process; with several instances the effective limits multiply.
- **No retention automation:** no purge jobs; data stays until the user deletes it
  ([data model §3](architecture/data-model.md#3-retention-policy-proposal)). `audit_events` rows remain
  (pseudonymous) after account deletion by design.
- **Notifications are in-app only** (stream + list); no push or email notifications.
- **Admin sees account metadata** (emails, tenant names, roles, counts) but no content; there is no
  admin UI for user management actions (disable, delete) — those are SQL runbook steps.

## Platforms and localisation

- Web and iOS only; Android (Compose) and macOS (SwiftUI multiplatform) are Phase 6.
- Languages: English, German, Arabic. Other languages may be understood by the model in model mode,
  but UI strings, offline planner and injection patterns cover only these three.
