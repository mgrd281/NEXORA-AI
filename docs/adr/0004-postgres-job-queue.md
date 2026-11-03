# ADR-0004: Durable execution on a PostgreSQL job queue (Temporal later, if needed)

- Status: Accepted
- Date: 2026-11-03

## Context

Agent tasks must survive worker crashes, deploys and network failures without losing work or
repeating side effects. Tasks wait on humans (approvals, up to `APPROVAL_TTL_HOURS`, max 168 h) and
on slow external systems. The alpha runs on one database and a handful of processes.

## Decision

A job queue in the `jobs` table, implemented in `apps/api/src/modules/jobs/queue.ts`:

| Mechanism      | Implementation                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomic enqueue | `enqueue(trx, …)` inside the same transaction as the state change, then `pg_notify('jarvis_jobs', kind)` (delivered only on commit).        |
| Dedupe         | Partial unique index on `dedupe_key` for `queued`/`running` jobs: at most one live `plan:<taskId>`, `exec:<taskId>`, `expire:<approvalId>`. |
| Lease          | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)`; lease 60 s, extended every 20 s while work runs (`withKeepAlive`).        |
| Backoff        | On failure `run_at = now + min(60 s, 1 s · 2^(attempts−1))`; `dead` after `max_attempts` (default 5; `approval.expire` 10).                 |
| Reclaim        | Every 15 s, running jobs with an expired lease go back to `queued` (or `dead`).                                                             |
| Heartbeats     | Every 10 s into `worker_heartbeats`; the worker counts as healthy if any heartbeat is < 30 s old.                                           |
| Wake-up        | Workers `LISTEN jarvis_jobs` and also poll every 2 s.                                                                                       |
| Dead letter    | `onJobDead` fails the task with `INTERNAL` (retryable) so nothing stays active forever.                                                     |
| Shutdown       | `SIGINT`/`SIGTERM`: stop leasing, wait for in-flight jobs.                                                                                  |

Job kinds: `task.plan`, `task.execute`, `approval.expire`. Correctness does not depend on
exactly-once job delivery: handlers are idempotent and lock the task row; side effects are guarded
separately ([ADR-0010](0010-exactly-once-side-effects.md)).

## Alternatives considered

- **Temporal.** Best-in-class durable workflows (timers, signals, versioning, visibility). Rejected for
  the alpha: another stateful cluster to run and secure, and our workflows are short and linear.
- **Redis-based queues (BullMQ).** Another datastore, and enqueue cannot be atomic with the Postgres
  state change without an outbox. Rejected.
- **Cloud queues (SQS, Pub/Sub).** Same atomicity problem; vendor lock-in for local development.

## Migration criteria (move to Temporal when any holds)

- Scheduled and recurring tasks (`scheduled_tasks`) need reliable timers at scale, or multi-day
  workflows with many waits (booking flows, follow-ups, phone calls in Phase 5).
- Workflows branch or loop (re-planning, sub-tasks) beyond a linear step list.
- Sustained queue volume makes polling and `SKIP LOCKED` contention visible (rule of thumb: p95 lease
  latency > 1 s or > ~200 jobs/s).
- We need workflow versioning across deploys for long-running instances.

**Path:** keep `runJob(kind)` handlers as the unit of work; wrap them as Temporal activities; replace
`enqueue` with workflow starts/signals; run both systems side by side, routing new tasks to Temporal
by feature flag; drain the Postgres queue; remove it.

## Consequences

- One datastore to back up, observe and secure; job and task state commit together.
- Queue depth is visible to operators (`GET /v1/admin/overview` → `health.queueDepth`).
- Polling adds up to 2 s latency if a `NOTIFY` is missed; acceptable for the alpha.
