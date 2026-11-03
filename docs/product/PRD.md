# JARVIS — Product requirements

- Status: Living document; Milestone 1 (in progress)
- Owner: Product (TPM)
- Last updated: 2026-11-03

## 1. Vision

A personal AI agent you can trust with real work. You say what you want — by text or voice, in
English, German or Arabic — and JARVIS plans it, shows you exactly what it will do, asks before it
acts on the outside world, does it, and proves it happened. Every status you see is real; nothing is
simulated.

## 2. Personas

| Persona                       | Context                                                                                                                             | Needs                                                                               | Phase                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| **The owner**                 | Runs the private build for themselves; multilingual (en/de/ar); iPhone and a desktop browser; delegates research and correspondence | Speed with control; approve on the go; full history and evidence; costs under a cap | Milestone 1 → private alpha |
| **Busy professional**         | Invited user; many small chores (read this, summarise that, send that, remember this)                                               | One place to delegate; no surprise actions; works on phone                          | Closed beta                 |
| **Privacy-first user**        | Will not send personal data to external AI                                                                                          | Useful offline mode; clear disclosure when a model is used; export and delete       | Closed beta                 |
| **Accessibility-first user**  | Screen reader or voice-first; may use large text                                                                                    | Full keyboard and VoiceOver/TalkBack support; voice input; no colour-only meaning   | All phases                  |
| **Operator / platform admin** | Runs the service                                                                                                                    | Health, queue, cost and reliability at a glance; never sees user content            | Milestone 1 →               |

## 3. Problems

1. Assistants either chat (no action) or act opaquely (no control). Users cannot see what will
   happen before it happens.
2. Agents that read the web or email can be hijacked by instructions hidden in that content.
3. Retries and crashes cause duplicate side effects (two emails, two bookings).
4. "Done" is rarely verifiable: no receipt, no evidence.
5. Costs of model use are invisible and unbounded.
6. Multilingual and RTL users get second-class interfaces.

## 4. Principles

1. **Real state only.** No fake data, no simulated progress, no claimed success without evidence.
2. **Ask before acting on the world.** External side effects need approval unless the user enabled a
   narrow, named autonomy rule.
3. **Approve exactly what runs.** Approvals are bound to the exact input (action hash).
4. **Data is not instructions.** Content JARVIS reads cannot change its plan or recipients.
5. **Exactly once.** A side effect happens at most once; unknown outcomes are said out loud.
6. **Private by default.** Minimal data, no admin access to content, offline mode, export and delete.
7. **One design language.** Meridian on every platform; WCAG 2.2 AA; RTL first-class.
8. **Simple over clever.** Fewer layers, deterministic policy, explicit dependencies.

## 5. Scope by phase

| Phase                         | Theme                       | Scope highlights                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Milestone 1 (in progress) | Foundation + vertical slice | Monorepo, contracts, Meridian tokens, RLS schema, auth, durable queue, agent runtime (plan → policy → approval → execute → verify), 5 tools, Web access + SMTP connections, web app, iOS app, docs ([vertical slice](vertical-slice.md)) |
| 2                             | AI core expansion           | More tools (document analysis, translation, scheduling), re-planning after observations for read-only research, pgvector semantic memory, skill manifests, evaluation suites against live models, keyring-based secret rotation          |
| 3                             | iOS + Web complete          | Full feature parity, push notifications, widgets, App Intents/Shortcuts, offline caching, Settings and Sessions management                                                                                                               |
| 4                             | Integrations                | Gmail and Google Calendar (OAuth), Microsoft 365, isolated browser agent (`browser_sessions`), appointment booking flows                                                                                                                 |
| 5                             | Voice + calls               | Realtime voice (WebSocket/WebRTC), text-to-speech replies, outbound phone calls with AI disclosure and consent (`call_sessions`)                                                                                                         |
| 6                             | Android + macOS             | Jetpack Compose app, macOS via SwiftUI multiplatform, reusing contracts and tokens                                                                                                                                                       |
| 7                             | Private alpha               | Small invited group, OIDC + Sign in with Apple, MFA for admins, production deployment, SLOs measured                                                                                                                                     |
| 8                             | Closed beta                 | Invitations at scale, billing (`subscriptions`), DPIA complete, retention jobs, support tooling                                                                                                                                          |
| 9                             | Commercial release          | Public registration (`public_registration` flag), pricing plans, compliance reviews, multi-region                                                                                                                                        |

## 6. Functional requirements (Milestone 1)

Each requirement has measurable acceptance criteria; the checklist for sign-off is in
[vertical slice](vertical-slice.md).

| ID    | Requirement                                      | Acceptance criteria                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Sign in with email and password; manage sessions | Valid credentials → session (cookie on web, bearer on iOS); invalid → `401` with no hint whether the email exists; the 11th login request within a minute from one IP → `429`; sessions listed with device and last use; revoking one ends it on the next request |
| FR-2  | Accounts only by invitation                      | No sign-up endpoint exists; `cli create-owner` creates tenant, user, roles and subscription; password ≥ 12 characters, read from the environment                                                                                                                  |
| FR-3  | Submit a request by text                         | `POST /v1/tasks` returns `202` with a `QUEUED` task in < 500 ms server time (target, measured later); duplicate `Idempotency-Key` returns the same task                                                                                                           |
| FR-4  | Submit a request by voice                        | Recognised text is submitted as `source: "voice"` with language; JARVIS servers never receive audio; the engine and its privacy implication are shown                                                                                                             |
| FR-5  | Receive a plan                                   | Task shows title, objective, numbered steps with tool, risk and policy decision; the planner mode (model/offline) and provider are visible                                                                                                                        |
| FR-6  | Approve an action with exact content             | For `email.send` the approval shows from, every recipient, subject and full body; deciding requires the displayed action hash; changed content requires a new approval; approvals expire after 24 h by default                                                    |
| FR-7  | Observe execution live                           | Status changes, step start/success/failure, approval requests and verification results arrive over SSE within 1 s of commit (target); a reconnect with `Last-Event-ID` loses no persisted event                                                                   |
| FR-8  | Verified result with evidence                    | A completed task has a result summary and evidence: for fetched pages HTTP status, final URL, bytes and SHA-256; for email the SMTP reply and Message-ID; a failed verification fails the task                                                                    |
| FR-9  | Review execution history                         | Task Center lists tasks by state with filters; task detail shows the full event timeline, steps, approvals, evidence and cost                                                                                                                                     |
| FR-10 | Cancel and retry                                 | Cancel works in every non-terminal state except `VERIFYING`; retry resumes from the first unfinished step; retry after `OUTCOME_UNKNOWN` requires explicit acknowledgement                                                                                        |
| FR-11 | Connections                                      | Enable Web access; connect SMTP (verified before saving, TLS required outside dev); test and disconnect (secrets erased)                                                                                                                                          |
| FR-12 | Memory                                           | Save via request ("remember that …") or the Memory screen; search, edit, delete one, delete all; memory can be turned off                                                                                                                                         |
| FR-13 | Settings                                         | Language (en/de/ar, RTL for ar), theme, time zone, voice options, autonomy (email to self), external models on/off, notification kinds, monthly AI budget                                                                                                         |
| FR-14 | Usage                                            | Current month AI and tool cost, budget, task counts                                                                                                                                                                                                               |
| FR-15 | Privacy self-service                             | Export all data as JSON; delete the account with password confirmation                                                                                                                                                                                            |
| FR-16 | Admin overview                                   | Platform admins see health (database, worker, planner, queue depth), users, tasks by status, tool reliability (p50/p95), 30-day cost, users list, audit list — no content                                                                                         |
| FR-17 | Offline mode                                     | Without an API key / with external models off / budget exhausted, the three offline commands work and the UI states why JARVIS is offline                                                                                                                         |

## 7. Non-functional requirements

| ID     | Area                 | Requirement                                                                              | Measure                                                                                       |
| ------ | -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| NFR-1  | Isolation            | No cross-tenant or cross-user data access                                                | RLS integration tests pass; every tenant query through `withContext`                          |
| NFR-2  | Side effects         | No duplicate external side effect on retry or crash                                      | Crash-after-send test: exactly one email delivered                                            |
| NFR-3  | Prompt injection     | Fetched content cannot add steps or change recipients                                    | Injection corpus: 100 % pass                                                                  |
| NFR-4  | Performance          | API p95 < 500 ms for non-streaming endpoints (excluding model-bound work)                | Measured once production metrics exist; target, not yet measured                              |
| NFR-5  | Latency              | Time to plan p95 < 20 s (model mode), < 2 s (offline)                                    | Measured in evaluation runs; target                                                           |
| NFR-6  | Reliability          | Worker crash loses no task; stuck jobs reclaimed within 75 s (60 s lease + 15 s reclaim) | Recovery tests                                                                                |
| NFR-7  | Accessibility        | WCAG 2.2 AA                                                                              | Token contrast tests; axe-core: 0 serious/critical violations on every screen, light and dark |
| NFR-8  | Internationalisation | en, de, ar; RTL mirroring for ar; no truncated German strings at 390 px                  | Screenshot review matrix ([review process](../design/review-process.md))                      |
| NFR-9  | Privacy              | Export and deletion complete; no content in audit, logs or notifications                 | Export/delete integration tests; code review                                                  |
| NFR-10 | Security             | Secrets encrypted at rest; SSRF blocked; CSRF blocked; sessions revocable                | Unit/integration tests; threat model review                                                   |
| NFR-11 | Cost                 | Every model call metered; budget enforced                                                | Usage records per call; budget tests                                                          |
| NFR-12 | Honesty              | Every visible status maps to stored state; offline mode always disclosed                 | Review checklist item 1                                                                       |

## 8. Success metrics

| Metric                   | Definition                                    | Milestone 1 target                          | Private alpha target                   |
| ------------------------ | --------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| Verified completion rate | `COMPLETED` ÷ tasks that reached `RUNNING`    | ≥ 90 % on the vertical-slice scenarios      | ≥ 85 % on real use                     |
| Duplicate side effects   | Emails sent more than once per step           | 0                                           | 0                                      |
| Unknown outcomes         | `OUTCOME_UNKNOWN` ÷ email executions          | Reported                                    | < 0.5 %                                |
| Approval reject rate     | Rejected ÷ decided approvals                  | Reported                                    | Falling over time (plans match intent) |
| Plan validity            | Valid model plans on first try / after repair | Reported in eval                            | ≥ 90 % / ≥ 98 %                        |
| Cost per task            | `actual_cost_micro` mean by task type         | Within [cost estimates](../costs.md) ± 30 % | Same                                   |
| Weekly active use        | Tasks created per week by the owner           | Reported                                    | ≥ 20 per active user                   |
| Accessibility            | Serious/critical axe violations               | 0                                           | 0                                      |

## 9. Out of scope for Milestone 1

Reading email or calendars; Gmail/Calendar/Microsoft integrations; browser automation; phone calls;
payments and purchases (any `CRITICAL` action); scheduled/recurring tasks; file uploads and document
analysis; multi-member tenants and sharing; public registration; OIDC/Apple/passkeys/MFA; password
reset; push notifications; Android and macOS apps; realtime two-way voice; billing.

## 10. Risks

| Risk                                                        | Impact                                  | Likelihood    | Mitigation                                                                            |
| ----------------------------------------------------------- | --------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| Prompt injection via fetched content                        | Unwanted email content or data exposure | Medium        | Plan-before-read, literal recipients, taint → approval, detection, full-body approval |
| Model plan quality varies (new models, multilingual)        | Failed or wrong plans                   | Medium        | Validation + repair, golden-set evals before model changes, offline fallback          |
| No live-model testing in development                        | Behaviour or cost differs from tests    | High (now)    | Scripted-model tests now; live eval suite with spend cap before private alpha         |
| SMTP deliverability / provider limits                       | Emails rejected or delayed              | Medium        | Verify on connect, classify failures, honest status                                   |
| Cost overrun                                                | Real money                              | Low           | Budgets, offline switch, metering per call, unknown models priced high                |
| Browser speech engine sends audio to vendor                 | Privacy expectation mismatch            | High (Chrome) | Disclose in Voice mode; on-device recognition on iOS; self-hosted STT later           |
| Single region, single database                              | Outage = downtime                       | Medium        | Backups/PITR, runbooks, SLOs; HA before closed beta                                   |
| Small team, broad scope                                     | Delays                                  | High          | Phased plan, vertical slices, contract-first parallel work                            |
| Regulatory (AI Act transparency, GDPR, call recording laws) | Fines, blocked features                 | Medium        | AI disclosure, DPIA, consent design, feature flags                                    |
