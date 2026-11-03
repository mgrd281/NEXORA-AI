# Architecture overview

JARVIS is a modular monolith: one TypeScript backend package (`apps/api`) running as an **API process**
and a **worker process**, a **Next.js web app**, a **SwiftUI iOS app**, and **PostgreSQL 16** as the
only datastore. Shared Zod contracts (`packages/contracts`) and Meridian tokens (`packages/tokens`)
keep every surface consistent.

Status legend: **Built** = in the foundation or agent runtime as of this document; **Milestone 1
(in progress)** = being implemented in this milestone; **Planned** = later phase.

## 1. System context

```mermaid
flowchart LR
  owner(["Owner<br/>(web, iPhone)"])
  operator(["Operator / platform admin"])
  jarvis["JARVIS"]
  anthropic["Anthropic API<br/>(planning, answers, summaries)"]
  smtp["Owner's SMTP provider<br/>(outgoing email)"]
  web["Public websites"]
  speech["Speech recognition<br/>(browser vendor / Apple)"]

  owner -- "requests, approvals, settings" --> jarvis
  jarvis -- "plans, live progress, results with evidence" --> owner
  operator -- "CLI create-owner, admin aggregates" --> jarvis
  jarvis -- "HTTPS, only in model mode" --> anthropic
  jarvis -- "SMTP over TLS" --> smtp
  jarvis -- "HTTP(S) GET, SSRF-guarded" --> web
  owner -. "audio, on device or vendor service" .-> speech
```

External model use is optional: without an API key, when the user disables external models, or when
the monthly AI budget is used up, JARVIS plans with its offline rules engine and nothing is sent to a
model provider ([ADR-0008](../adr/0008-model-layer.md)).

## 2. Containers

```mermaid
flowchart TB
  subgraph clients["Clients"]
    browser["Browser<br/>Next.js client components, React Query"]
    ios["iOS app<br/>SwiftUI, Keychain, URLSession SSE"]
  end

  subgraph edge["Web tier"]
    next["Next.js 16 server<br/>pages, same-origin /api proxy, SSE proxy"]
  end

  subgraph backend["apps/api (one package, two processes)"]
    api["API process<br/>Fastify 5, contract routes, SSE /v1/events"]
    worker["Worker process<br/>job leasing, planner, policy, executor, tools"]
  end

  db[("PostgreSQL 16<br/>RLS, jobs, task_events, LISTEN/NOTIFY")]
  anthropic["Anthropic API"]
  smtp["SMTP provider"]
  sites["Public websites"]

  browser -- "HTTPS, cookie jarvis_session" --> next
  next -- "HTTP /v1/*, Origin forwarded" --> api
  ios -- "HTTPS, Bearer token" --> api
  api -- "jarvis_app role, withContext" --> db
  worker -- "jarvis_app role, withContext" --> db
  db -- "NOTIFY jarvis_events" --> api
  db -- "NOTIFY jarvis_jobs" --> worker
  worker --> anthropic
  worker --> smtp
  worker --> sites
  api -- "SMTP verify on connect/test" --> smtp
```

| Container    | Code                          | Responsibility                                                                         | Status                    |
| ------------ | ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| API          | `apps/api/src/server.ts`      | Auth, CSRF, rate limits, 35 contract routes + SSE, read models, task/approval commands | Built                     |
| Worker       | `apps/api/src/worker.ts`      | Leases `task.plan`, `task.execute`, `approval.expire` jobs; runs the agent runtime     | Built                     |
| Operator CLI | `apps/api/src/cli.ts`         | `create-owner` (invitation-only accounts)                                              | Built                     |
| Migrator     | `apps/api/src/db/migrate.ts`  | Checksummed, transactional, advisory-locked SQL migrations                             | Built                     |
| Web          | `apps/web`                    | Next.js App Router UI, `/api` proxy, SSE proxy                                         | Milestone 1 (in progress) |
| iOS          | `apps/ios`                    | SwiftUI app, voice, App Intents                                                        | Milestone 1 (in progress) |
| PostgreSQL   | `db/migrations/0001_init.sql` | All state, RLS, queue, event log, NOTIFY                                               | Built                     |

## 3. Components (backend)

```mermaid
flowchart LR
  subgraph http["HTTP layer (src/http)"]
    authhook["Auth hook<br/>bearer or cookie, auth_resolve_session"]
    csrf["CSRF Origin check<br/>(cookie + unsafe method)"]
    rl["Rate limit<br/>per user, else IP"]
    route["defineRoute<br/>auth level, Zod, Idempotency-Key,<br/>response contract"]
  end

  subgraph modules["Domain modules (src/modules)"]
    auth["auth"]
    account["account<br/>me, export, delete"]
    tasksmod["tasks<br/>read models, service"]
    approvals["approvals<br/>decide"]
    conns["connections<br/>SMTP, web, SecretBox"]
    memory["memory"]
    notif["notifications"]
    voice["voice"]
    home["home, usage"]
    admin["admin<br/>SECURITY DEFINER aggregates"]
    stream["stream<br/>SSE"]
  end

  subgraph runtime["Agent runtime (src/modules/agent)"]
    ctxload["context<br/>prefs, connections, budget, route"]
    planner["planner<br/>model or offline"]
    router["router<br/>mode + model tier"]
    adapters["model adapters<br/>Anthropic"]
    plan["validatePlan"]
    policy["Policy Engine<br/>pure function"]
    executor["executor<br/>claim, execute, record, verify"]
    tools["tool registry<br/>web.fetch, text.summarize,<br/>email.send, memory.save,<br/>assistant.answer"]
  end

  subgraph infra["Shared infrastructure"]
    queue["jobs queue"]
    events["events<br/>appendEvent + NOTIFY"]
    auditmod["audit<br/>append-only"]
    pool["db/pool withContext"]
  end

  authhook --> csrf --> rl --> route --> modules
  tasksmod -- "AgentServices.tasks" --> queue
  approvals -- "AgentServices.approvals" --> queue
  queue --> planner
  planner --> router --> adapters
  planner --> plan --> policy
  queue --> executor
  executor --> policy
  executor --> tools
  tools --> adapters
  executor --> events
  stream --> events
  modules --> pool
  runtime --> pool
  modules --> auditmod
  runtime --> auditmod
```

The HTTP layer depends only on the `AgentServices` interface (`src/services.ts`: `tasks.create/cancel/
retry`, `approvals.decide`, `status.get`); the worker calls the job handlers in
`src/modules/agent/jobs.ts`. Details of the runtime: [agent runtime](agent-runtime.md).

## 4. Request lifecycle (HTTP)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant F as Fastify (API)
  participant DB as PostgreSQL

  C->>F: POST /v1/tasks (cookie or Bearer, Idempotency-Key)
  F->>F: genReqId (accepts X-Request-Id 8-64 chars)
  F->>DB: select * from auth_resolve_session(sha256(token))
  DB-->>F: session_id, user_id, tenant_id (or nothing)
  F->>F: cookie + unsafe method: Origin must equal WEB_ORIGIN
  F->>F: rate limit (300/min per user, route overrides)
  F->>F: defineRoute: auth level, Zod-parse params/query/body
  F->>DB: idempotency_keys claim (withContext)
  F->>DB: BEGIN, set_config(app.tenant_id, app.user_id, true), handler SQL under RLS, COMMIT
  F->>F: validate response against contract
  F-->>C: 202 TaskSummary (or ApiErrorBody with requestId)
```

- Unauthenticated requests to a `user`/`platform_admin` route → `401 UNAUTHENTICATED`;
  `platform_admin` routes also check `auth_user_roles(userId)`.
- Errors are always `ApiErrorBody` (`{ error: { code, message, requestId, details? } }`); see
  [API conventions](api.md).
- Liveness `GET /healthz`, readiness `GET /readyz` (database ping) are unauthenticated and return no
  data.

## 5. Task lifecycle

The state machine is shared by server and clients (`packages/contracts/src/task-state.ts`). The
server enforces it inside a transaction with optimistic locking (`transitionTask` in
`src/modules/agent/task-state.ts` checks `assertTransition`, bumps `tasks.version` and writes
`task.status_changed`). Clients use it only to decide which controls to show.

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> PLANNING
  QUEUED --> CANCELLED
  QUEUED --> EXPIRED
  QUEUED --> FAILED
  PLANNING --> RUNNING
  PLANNING --> AWAITING_APPROVAL
  PLANNING --> FAILED
  PLANNING --> CANCELLED
  AWAITING_APPROVAL --> RUNNING
  AWAITING_APPROVAL --> CANCELLED
  AWAITING_APPROVAL --> EXPIRED
  AWAITING_APPROVAL --> FAILED
  RUNNING --> AWAITING_APPROVAL
  RUNNING --> VERIFYING
  RUNNING --> FAILED
  RUNNING --> CANCELLED
  VERIFYING --> COMPLETED
  VERIFYING --> FAILED
  FAILED --> QUEUED : retry
  EXPIRED --> QUEUED : retry
  COMPLETED --> [*]
  CANCELLED --> [*]
```

Terminal: `COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED` (`FAILED` and `EXPIRED` can be retried).
`canCancel(s)` = transition to `CANCELLED` allowed; `canRetry(s)` = transition to `QUEUED` allowed.

| Transition                    | Triggered by (current runtime)                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| QUEUED → PLANNING             | `task.plan` job claims the task                                                              |
| QUEUED → CANCELLED            | `POST /v1/tasks/:id/cancel` (immediate) or the plan job seeing `cancel_requested_at`         |
| QUEUED → FAILED               | Plan job exhausted its attempts (`onJobDead`, `INTERNAL`, retryable)                         |
| QUEUED → EXPIRED              | Allowed by the contract; not produced by the Milestone 1 runtime                             |
| PLANNING → RUNNING            | Plan validated, policies checked, `plan.ready`, `task.execute` enqueued                      |
| PLANNING → FAILED             | Planner error (`PLANNER_UNSUPPORTED`, `MODEL_ERROR`), a step denied by policy, or a dead job |
| PLANNING → CANCELLED          | Cancel requested; applied at the next checkpoint                                             |
| PLANNING → AWAITING_APPROVAL  | Allowed by the contract; the current runtime requests approvals from `RUNNING`               |
| RUNNING → AWAITING_APPROVAL   | Executor: policy requires approval for the next step's resolved input                        |
| AWAITING_APPROVAL → RUNNING   | Approval approved with the matching action hash                                              |
| AWAITING_APPROVAL → CANCELLED | Approval rejected, or the task cancelled                                                     |
| AWAITING_APPROVAL → EXPIRED   | `approval.expire` job at `expires_at`, or a decision attempted after expiry                  |
| AWAITING_APPROVAL → FAILED    | Allowed by the contract; not produced by the Milestone 1 runtime                             |
| RUNNING → VERIFYING           | All steps `SUCCEEDED`/`SKIPPED`                                                              |
| RUNNING → FAILED              | Step failed or blocked, `OUTCOME_UNKNOWN`, or a dead job                                     |
| RUNNING → CANCELLED           | Cancel requested; applied before the next step starts                                        |
| VERIFYING → COMPLETED         | Every step's `verify()` passed; result summary and evidence stored                           |
| VERIFYING → FAILED            | A verification failed (`VERIFICATION_FAILED`)                                                |
| FAILED/EXPIRED → QUEUED       | `POST /v1/tasks/:id/retry`; resumes from the first unfinished step                           |

Cancellation of `PLANNING`/`RUNNING` tasks is cooperative: the API sets `cancel_requested_at` and
emits `task.cancel_requested`; the worker cancels at the next checkpoint. A step that is already
executing finishes (or times out) first. `VERIFYING` cannot be cancelled.

## 6. Data flow: approvals

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker (executor)
  participant DB as PostgreSQL
  participant API as API
  participant U as Owner (client)

  W->>DB: lock task, resolve {{refs}}, validate input
  W->>W: Policy Engine on resolved input → require_approval
  W->>W: actionHash = sha256(canonicalJson({toolId, resolvedInput}))
  W->>DB: insert approvals (PENDING, details, actionHash, expires_at)
  W->>DB: step AWAITING_APPROVAL, task RUNNING→AWAITING_APPROVAL
  W->>DB: task_events approval.requested + notification + enqueue approval.expire
  DB-->>API: NOTIFY jarvis_events {u, id}
  API-->>U: SSE approval.requested
  U->>API: GET /v1/approvals (exact from, to, subject, body + actionHash)
  U->>API: POST /v1/approvals/:id/decision {approve, actionHash} + Idempotency-Key
  API->>DB: lock approval: PENDING? unexpired? hash equal (timing-safe)?
  API->>DB: APPROVED, step PENDING, task → RUNNING, enqueue task.execute
  API-->>U: 200 Approval
  W->>DB: re-resolve input, recompute hash, find APPROVED approval with same hash
  W->>DB: claim tool_executions (idempotency_key = step id, status started)
  W->>W: send email via SMTP
  W->>DB: record SMTP receipt + Message-ID, step SUCCEEDED
  W->>DB: VERIFYING → verify() → COMPLETED (evidence, result summary)
```

If the resolved input differs from what was approved (for example, a referenced output changed after
a retry), the hash differs: the old approval is marked `SUPERSEDED` and a new one is requested.
Mismatched hashes from clients are rejected with `409 APPROVAL_MISMATCH`.

## 7. Deployment topology (private alpha, proposed)

Nothing is deployed by this repository yet; this is the target for the private alpha.

```mermaid
flowchart TB
  user(["Owner devices"])
  subgraph region["One EU region"]
    lb["TLS load balancer / reverse proxy<br/>HTTPS only, HSTS"]
    subgraph app["Application hosts (containers)"]
      webc["web: next start :3000"]
      apic["api: node dist/server.js :4000"]
      workc["worker: node dist/worker.js"]
    end
    pg[("Managed PostgreSQL 16<br/>PITR backups, private network")]
    sm["Secret manager<br/>SECRET_ENCRYPTION_KEY, ANTHROPIC_API_KEY, DB passwords"]
  end
  ext["Anthropic API, SMTP provider, public web<br/>(outbound via egress proxy, planned)"]

  user --> lb
  lb -- "/" --> webc
  lb -- "/v1/* for native apps" --> apic
  webc -- "/api → /v1" --> apic
  apic --> pg
  workc --> pg
  workc --> ext
  apic -. "SMTP verify" .-> ext
  sm -. "env at start" .-> apic
  sm -. "env at start" .-> workc
```

- API and worker run the same build and version; deploy order is migrate → worker + API → web
  ([operations](../runbooks/operations.md)).
- In production the API trusts `X-Forwarded-For` only from loopback, link-local and unique-local
  addresses (`trustProxy`), so the load balancer must sit on a private network.
- `WEB_ORIGIN` must be `https://…` in production (enforced at boot).
- Scale-out: more workers is safe (`SKIP LOCKED`); more API instances is safe, but rate limits and the
  SSE per-user cap are per process ([known limitations](../known-limitations.md)).

## Related documents

- [Agent runtime](agent-runtime.md) · [Data model](data-model.md) · [API conventions](api.md)
- [Threat model](../security/threat-model.md) · [Permission model](../security/permission-model.md)
- ADRs: [index](../README.md#architecture-decision-records)
