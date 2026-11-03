# ADR-0010: Exactly-once side effects with database idempotency keys

- Status: Accepted
- Date: 2026-11-03

## Context

Jobs are delivered at least once: workers crash, leases expire, users press retry. Sending an email
twice (or, later, paying or booking twice) is unacceptable. A crash between "the server accepted the
message" and "we recorded that" is the hardest case: we cannot know whether it happened.

## Decision

- **Claim before acting.** Each execution attempt inserts a `tool_executions` row with status
  `started` _before_ the side effect, in its own committed transaction. `idempotency_key` is
  `UNIQUE`, so the database — not timing — guarantees at most one claim per key.
- **Tool idempotency classes** (declared per tool):
  - `once_per_step` (`email.send`): key = step id. A `succeeded` row is reused (the step is marked
    succeeded from stored output and evidence; nothing is re-sent). A `failed` row (definitely not
    executed) is re-claimed. A `started`/`unknown` row of an external tool means the outcome is
    unknown → the step fails with **`OUTCOME_UNKNOWN`** (not retryable). No automatic retry.
  - `safe_to_retry` (read-only or internal tools): key = `<stepId>:a<attempt>`; transient errors are
    retried automatically within the step's retry policy.
- **Failure classification for email**: errors before the message was handed over (connect, TLS,
  auth, rejected envelope, 4xx/5xx reply) are definite failures and safe to retry; anything ambiguous
  (socket error during `DATA`, timeout, unexpected exception) is `OUTCOME_UNKNOWN`.
- **Explicit acknowledgement.** Retrying a task whose last error is `OUTCOME_UNKNOWN` requires
  `POST /v1/tasks/:id/retry` with `acknowledgeUnknownOutcome: true`. The unknown execution keeps its
  row as history (its key is renamed), and the resend carries the **same Message-ID** (derived from the
  step's idempotency key), so mail clients can de-duplicate.
- **API idempotency.** Mutations marked `idempotent` in the route table (`createTask`, `retryTask`,
  `decideApproval`) accept an `Idempotency-Key` header (8–128 chars). The first request claims
  `(user, route, key)` in `idempotency_keys` with a hash of `{params, body}`; a repeat replays the
  stored response; a different request with the same key → `422 IDEMPOTENCY_MISMATCH`; a concurrent
  duplicate → `409 CONFLICT`; a failed request releases the key. `createTask` additionally stores the
  key on `tasks` (unique per user).

## Alternatives considered

- **Retry everything with backoff.** Duplicates side effects. Rejected.
- **Rely on provider idempotency.** SMTP has none; Message-ID helps clients de-duplicate but does not
  stop delivery. We still use it as a second line.
- **Two-phase commit with providers.** Not available for SMTP, web, or most consumer APIs.

## Consequences

- "No duplicate email on retry" is a database invariant, tested with a simulated crash after the SMTP
  server accepted the message (`test/integration/agent/vertical-slice.int.test.ts`).
- Some interrupted sends surface as `OUTCOME_UNKNOWN`, and the user has to check their Sent folder.
  This is the honest outcome.
- Future paid or booking tools must be `once_per_step` and must classify their own failures the same
  way before they can ship.
