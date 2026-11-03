# Known limitations

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

- **issue — SMTP to public IPv4 hosts refused.** `apps/api/src/lib/net.ts` registers `::ffff:0:0/96`
  in the same `BlockList` as the IPv4 ranges; Node then matches every IPv4 address, so
  `isPrivateAddress`/`assertPublicHost` treat public IPv4 hosts as private. `web.fetch` uses its own
  guard (`tools/ssrf.ts`) and is unaffected; SMTP connections (connect, test, send) to providers
  resolved only to IPv4 are refused with `FETCH_BLOCKED`/`CONNECTION_FAILED`. It fails safe (blocks,
  never allows). Documented by a failing-by-design test in `test/unit/agent/net.test.ts`.
- **issue — decryption failure reported as `OUTCOME_UNKNOWN`.** If a connection secret cannot be
  decrypted at send time (e.g. after a key rotation), `email.send` classifies the error as
  `OUTCOME_UNKNOWN` although nothing was sent. Workaround: reconnect SMTP before running email tasks
  after a rotation ([operations](runbooks/operations.md#rotate-secret_encryption_key)).
- **issue — budget month boundary.** Budget enforcement counts spend since the 1st of the month in
  UTC (`agent/context.ts`), while `GET /v1/usage` reports the calendar month in the user's time zone;
  around month boundaries the two can differ by a few hours of spend.

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
