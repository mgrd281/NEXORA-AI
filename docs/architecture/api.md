# API conventions (v1)

- **Machine-readable spec:** [`docs/api/openapi.json`](../api/openapi.json) (OpenAPI 3.1), generated
  from the contract route table by `pnpm openapi` (`pnpm --filter @jarvis/api openapi --check` fails if
  it is stale). Do not edit it by
  hand.
- **Source of truth:** `packages/contracts/src/routes.ts` (35 routes) and `schemas.ts`. The server
  registers every route through `defineRoute` and refuses to boot if one is missing; requests are
  validated with the route's Zod schemas, and responses are validated against the response schema
  (a violation is a `500 INTERNAL` outside production and is logged in production).

## Versioning

- All endpoints live under `/v1`. Within v1, changes are **additive only**: new optional request
  fields, new response fields, new endpoints, new enum values only where clients are told to tolerate
  them (event types, reason codes, error codes).
- Clients must ignore unknown response fields and unknown event types.
- A breaking change ships as `/v2/...` alongside `/v1` with a deprecation window announced in release
  notes (minimum 90 days once external clients exist).
- `AssistantStatus.version` reports the server version (`APP_VERSION`).

## Authentication

| Client              | Credential                                                                           | How to obtain                                                     | Sent as                                   | CSRF                                                                            |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| Web                 | Session cookie `jarvis_session` (`httpOnly`, `SameSite=Lax`, `Secure` in production) | `POST /v1/auth/login` with `platform: "web"` sets it              | Cookie (first-party via the `/api` proxy) | `POST/PUT/PATCH/DELETE` must carry `Origin: <WEB_ORIGIN>`, else `403 FORBIDDEN` |
| iOS, Android, macOS | Opaque bearer token (256-bit)                                                        | `POST /v1/auth/login` with `platform: "ios"` etc. returns `token` | `Authorization: Bearer <token>`           | Not applicable (no ambient credential)                                          |

- If both are present, the bearer token wins.
- Sessions last `SESSION_TTL_DAYS` (default 30). `401 UNAUTHENTICATED` means missing, expired or
  revoked: sign in again.
- `platform_admin` routes additionally require the `platform_admin` role (`403 FORBIDDEN`).
- No public sign-up endpoint exists (invitation only, [ADR-0007](../adr/0007-authentication.md)).

## Requests and responses

- JSON bodies, UTF-8, max **256 KB** per request body.
- Ids are UUIDs; timestamps are ISO 8601 with offset (`2026-11-03T14:05:00.000Z`); money is integer
  **micro-USD** (`1 USD = 1 000 000`).
- `X-Request-Id`: send one (8–64 chars of `[A-Za-z0-9_-]`) to correlate logs; otherwise the server
  generates a UUID. It is returned as `error.requestId` on errors.
- Success statuses come from the route table: `200`, `201` (created), `202` (accepted, work continues
  asynchronously: `createTask`, `retryTask`), `204` (no body).

## Errors

Every error uses `ApiErrorBody`:

```json
{
  "error": {
    "code": "APPROVAL_MISMATCH",
    "message": "This action is not the one you reviewed. Open it again to see exactly what will happen.",
    "requestId": "6f0c…",
    "details": {}
  }
}
```

`message` is safe to show to users (never internals). `details` is optional; validation errors carry
`details.issues: [{ path, message }]`; a retry that needs acknowledgement carries
`details.requiresAcknowledgement: true`.

| Code                   | HTTP | Meaning                                                                                 |
| ---------------------- | ---- | --------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`    | 400  | Path, query or body invalid (also oversized bodies, malformed cursors)                  |
| `UNAUTHENTICATED`      | 401  | No valid session                                                                        |
| `BUDGET_EXCEEDED`      | 402  | Monthly AI budget exhausted or zero                                                     |
| `FORBIDDEN`            | 403  | Not allowed (role, CSRF Origin, wrong confirmation password)                            |
| `POLICY_DENIED`        | 403  | Policy Engine denied the action                                                         |
| `NOT_FOUND`            | 404  | Unknown route or resource (including other users' resources — RLS makes them invisible) |
| `CONFLICT`             | 409  | Concurrent modification or identical request in progress                                |
| `INVALID_STATE`        | 409  | Operation not allowed in the current state (e.g. retry a running task)                  |
| `APPROVAL_EXPIRED`     | 409  | Approval expired before the decision                                                    |
| `APPROVAL_MISMATCH`    | 409  | `actionHash` differs from the action that is pending                                    |
| `CONNECTION_REQUIRED`  | 409  | A required connection is missing or inactive                                            |
| `OUTCOME_UNKNOWN`      | 409  | A side effect may or may not have happened                                              |
| `IDEMPOTENCY_MISMATCH` | 422  | `Idempotency-Key` reused for a different request                                        |
| `CONNECTION_FAILED`    | 422  | A connection could not be verified (SMTP host, TLS, credentials)                        |
| `PLANNER_UNSUPPORTED`  | 422  | The offline planner cannot handle this request                                          |
| `FETCH_BLOCKED`        | 422  | URL refused (private address, scheme, credentials in URL)                               |
| `RATE_LIMITED`         | 429  | Too many requests or too many open event streams                                        |
| `INTERNAL`             | 500  | Unexpected server error                                                                 |
| `MODEL_ERROR`          | 502  | Model provider failure or refusal                                                       |
| `TOOL_FAILED`          | 502  | A tool failed                                                                           |
| `VERIFICATION_FAILED`  | 502  | A completed step did not pass verification                                              |
| `MODEL_NOT_CONFIGURED` | 503  | A step needs a model and none is configured                                             |
| `TOOL_TIMEOUT`         | 504  | A tool did not finish in time                                                           |

Task and step failures are not HTTP errors: they appear as `TaskError { code, message, retryable }` on
`TaskSummary.error` / `TaskStep.error`, using the same codes. `retryable` means a retry is safe
without risking a duplicate side effect.

## Idempotency

- Routes marked `idempotent` accept `Idempotency-Key` (8–128 chars): `POST /v1/tasks`,
  `POST /v1/tasks/:id/retry`, `POST /v1/approvals/:id/decision`. Clients should always send one
  (a UUID per user action) and reuse it when retrying after a network error.
- Semantics (`withIdempotency`, `apps/api/src/http/route.ts`):

  | Situation                                       | Result                                                   |
  | ----------------------------------------------- | -------------------------------------------------------- |
  | First use of `(user, route, key)`               | Request runs; response stored                            |
  | Same key, same request (`hash({params, body})`) | Stored response replayed with the route's success status |
  | Same key, different request                     | `422 IDEMPOTENCY_MISMATCH`                               |
  | Same key while the first is still running       | `409 CONFLICT`                                           |
  | First request failed                            | Key released; a retry runs again                         |

- Keys are scoped per user and route. Retention: until purged (no purge job in Milestone 1;
  proposal: 72 h, see [data model](data-model.md#3-retention-policy-proposal)).
- Side effects inside tasks have their own, stronger guarantee
  ([ADR-0010](../adr/0010-exactly-once-side-effects.md)).

## Pagination

- List endpoints return `{ items: [...], nextCursor: string | null }`; query `?cursor=&limit=`
  (`limit` 1–100, default 25). Pass `nextCursor` back unchanged; `null` means the end.
- Cursors are **opaque**. Tasks, memories and notifications use keyset pagination on
  `(created_at DESC, id DESC)` with microsecond precision; admin users and audit use their own cursor
  formats. Never construct cursors on the client.
- Filters: `GET /v1/tasks?status=active|needs_approval|completed|failed|all` (`failed` includes
  cancelled and expired); `GET /v1/memories?q=` (word match or literal substring).
- Short lists without pagination: approvals (pending only), connections, sessions.

## Rate limits

| Scope                                                        | Limit                                             |
| ------------------------------------------------------------ | ------------------------------------------------- |
| Global, per signed-in user (per IP when signed out)          | 300 requests / minute                             |
| `POST /v1/auth/login`                                        | 10 / minute per IP                                |
| `POST /v1/connections/smtp`, `POST /v1/connections/:id/test` | 10 / minute (each opens an outbound SMTP session) |
| `POST /v1/account/export`                                    | 5 / minute                                        |
| `POST /v1/account/delete`                                    | 5 / 15 minutes                                    |
| `GET /v1/events`                                             | 10 concurrent streams per user                    |

Exceeding a limit returns `429 RATE_LIMITED`. Limits are counted per API process in Milestone 1.

## Realtime: `GET /v1/events` (SSE)

```text
GET /v1/events
Accept: text/event-stream
Last-Event-ID: 1842            (or ?lastEventId=1842)

retry: 3000

id: 1843
event: message
data: {"id":"1843","type":"step.started","taskId":"…","at":"…","data":{"stepId":"…","toolId":"web.fetch","title":"…","attempt":1}}

event: message
data: {"id":"eph-…","type":"task.answer.delta","taskId":"…","at":"…","data":{"stepId":"…","text":"…"}}

: heartbeat
```

- Every frame's `data` is a `StreamEvent` (`packages/contracts/src/schemas.ts`). Persisted events have
  an `id:` line (the `task_events` id); ephemeral `task.answer.delta` frames do not and never move the
  resume position.
- On reconnect the server replays up to **200** newer events, oldest first, then streams live. If a
  client may have missed more (long offline), refetch `GET /v1/home` / `GET /v1/tasks/:id`.
- Heartbeat comment every 25 s; `retry: 3000` ms. Slow consumers are disconnected.
- Authentication as for other endpoints (cookie through the web proxy, or bearer).

Event types and `data` shapes (`apps/api/src/modules/events/events.ts`):

| Type                    | `data`                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `task.created`          | `{ status }`                                                  |
| `task.status_changed`   | `{ from, to }`                                                |
| `plan.ready`            | `{ stepCount, planner: { mode, provider, model }, language }` |
| `step.started`          | `{ stepId, toolId, title, attempt }`                          |
| `step.succeeded`        | `{ stepId, toolId, title }`                                   |
| `step.failed`           | `{ stepId, toolId, title, code, message }`                    |
| `step.blocked`          | `{ stepId, toolId, title, reasons }`                          |
| `approval.requested`    | `{ approvalId, stepId, summary }`                             |
| `approval.decided`      | `{ approvalId, decision: approved \| rejected \| expired }`   |
| `verification.passed`   | `{ checks }`                                                  |
| `verification.failed`   | `{ checks, message }`                                         |
| `task.cancel_requested` | `{}`                                                          |
| `task.retried`          | `{ attempt }`                                                 |
| `notification.created`  | `{ notificationId, kind }`                                    |
| `connection.changed`    | `{ connectionId, provider, status }`                          |
| `task.answer.delta`     | `{ stepId, text }` (ephemeral)                                |

Clients treat events as **invalidation signals** plus optimistic detail; the REST resources remain
the source of truth.

## Endpoints

| Method   | Path                         | Route name              | Auth           | Success | Idempotency-Key | Summary                                                            |
| -------- | ---------------------------- | ----------------------- | -------------- | ------- | --------------- | ------------------------------------------------------------------ |
| `POST`   | `/v1/auth/login`             | `login`                 | none           | 200     |                 | Sign in with email and password                                    |
| `POST`   | `/v1/auth/logout`            | `logout`                | user           | 204     |                 | Sign out and revoke the current session                            |
| `GET`    | `/v1/auth/sessions`          | `listSessions`          | user           | 200     |                 | List active sessions and devices                                   |
| `DELETE` | `/v1/auth/sessions/:id`      | `revokeSession`         | user           | 204     |                 | Revoke a session                                                   |
| `GET`    | `/v1/me`                     | `getMe`                 | user           | 200     |                 | Current user profile and preferences                               |
| `PATCH`  | `/v1/me`                     | `updateMe`              | user           | 200     |                 | Update profile and preferences                                     |
| `POST`   | `/v1/account/export`         | `exportAccount`         | user           | 200     |                 | Export all personal data as JSON (GDPR Art. 20)                    |
| `POST`   | `/v1/account/delete`         | `deleteAccount`         | user           | 204     |                 | Permanently delete the account and its data                        |
| `GET`    | `/v1/home`                   | `getHome`               | user           | 200     |                 | Home snapshot: approvals, active work, recent results, suggestions |
| `GET`    | `/v1/assistant/status`       | `getAssistantStatus`    | user           | 200     |                 | Real capability and health status of the assistant                 |
| `GET`    | `/v1/usage`                  | `getUsage`              | user           | 200     |                 | Usage and cost for the current month                               |
| `POST`   | `/v1/tasks`                  | `createTask`            | user           | 202     | yes             | Submit a request; JARVIS plans and executes it                     |
| `GET`    | `/v1/tasks`                  | `listTasks`             | user           | 200     |                 | List tasks                                                         |
| `GET`    | `/v1/tasks/:id`              | `getTask`               | user           | 200     |                 | Task detail with steps, approvals, evidence and history            |
| `POST`   | `/v1/tasks/:id/cancel`       | `cancelTask`            | user           | 200     |                 | Cancel a task                                                      |
| `POST`   | `/v1/tasks/:id/retry`        | `retryTask`             | user           | 202     | yes             | Retry a failed or expired task from the failed step                |
| `GET`    | `/v1/approvals`              | `listApprovals`         | user           | 200     |                 | Pending approvals                                                  |
| `POST`   | `/v1/approvals/:id/decision` | `decideApproval`        | user           | 200     | yes             | Approve or reject an action                                        |
| `GET`    | `/v1/connections`            | `listConnections`       | user           | 200     |                 | Connected services                                                 |
| `POST`   | `/v1/connections/smtp`       | `connectSmtp`           | user           | 201     |                 | Connect an SMTP mailbox (verified before saving)                   |
| `POST`   | `/v1/connections/web`        | `enableWebAccess`       | user           | 201     |                 | Allow JARVIS to read public web pages                              |
| `POST`   | `/v1/connections/:id/test`   | `testConnection`        | user           | 200     |                 | Re-verify a connection                                             |
| `DELETE` | `/v1/connections/:id`        | `deleteConnection`      | user           | 204     |                 | Disconnect and erase stored credentials                            |
| `GET`    | `/v1/memories`               | `listMemories`          | user           | 200     |                 | List or search memories                                            |
| `POST`   | `/v1/memories`               | `createMemory`          | user           | 201     |                 | Save a memory                                                      |
| `PATCH`  | `/v1/memories/:id`           | `updateMemory`          | user           | 200     |                 | Correct a memory                                                   |
| `DELETE` | `/v1/memories/:id`           | `deleteMemory`          | user           | 204     |                 | Delete a memory                                                    |
| `DELETE` | `/v1/memories`               | `deleteAllMemories`     | user           | 200     |                 | Delete all memories                                                |
| `GET`    | `/v1/notifications`          | `listNotifications`     | user           | 200     |                 | Notifications                                                      |
| `POST`   | `/v1/notifications/read`     | `markNotificationsRead` | user           | 200     |                 | Mark notifications read                                            |
| `POST`   | `/v1/voice-sessions`         | `startVoiceSession`     | user           | 201     |                 | Record the start of a voice session                                |
| `POST`   | `/v1/voice-sessions/:id/end` | `endVoiceSession`       | user           | 200     |                 | Record the end of a voice session                                  |
| `GET`    | `/v1/admin/overview`         | `adminOverview`         | platform_admin | 200     |                 | System health, reliability and cost aggregates                     |
| `GET`    | `/v1/admin/users`            | `adminUsers`            | platform_admin | 200     |                 | Users (no conversation content)                                    |
| `GET`    | `/v1/admin/audit`            | `adminAudit`            | platform_admin | 200     |                 | Audit log                                                          |

Outside the table: `GET /v1/events` (SSE, above), `GET /healthz` (liveness, `{ ok: true }`),
`GET /readyz` (readiness, `200`/`503` with `{ ok, database }`). Both health endpoints are
unauthenticated and expose no data.

## Security headers

Helmet with `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
`Cross-Origin-Resource-Policy: same-origin`, HSTS and the other Helmet defaults. The API serves JSON
only; the web app sets its own CSP for HTML.
