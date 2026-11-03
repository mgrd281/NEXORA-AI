# ADR-0005: Realtime via Server-Sent Events + PostgreSQL LISTEN/NOTIFY

- Status: Accepted
- Date: 2026-11-03

## Context

Users watch tasks plan, wait for approval, execute and verify. Updates flow server → client only;
the client acts through normal HTTP requests. Mobile networks drop connections, so the stream must be
resumable without losing events.

## Decision

- **`GET /v1/events`** (`apps/api/src/modules/stream/routes.ts`) streams the signed-in user's events
  as SSE (`text/event-stream`).
- **Source of truth is `task_events`** (append-only, `bigserial` id). `appendEvent` inserts the row and
  calls `pg_notify('jarvis_events', {u: userId, id})` in the same transaction, so a notice exists only
  for committed events.
- **Resume:** the client sends `Last-Event-ID` (or `?lastEventId=` where headers cannot be set); the
  server replays up to 200 newer events from `task_events`, then switches to live. It subscribes
  _before_ replaying, so nothing committed in between is missed; duplicates are suppressed.
- **Ownership double-check:** a notice only carries ids; the server re-reads the row through RLS
  before writing it to the socket.
- **Ephemeral events** (`task.answer.delta`, streamed answer text) are published with `pg_notify`
  only, carry no `id:` and are never replayed; the final answer is stored on the task.
- Limits: `retry: 3000`, heartbeat comment every 25 s, max 10 streams per user per API process, slow
  clients disconnected above 1 MB buffered.

## Alternatives considered

- **WebSockets.** Bidirectional, but needs its own auth, CSRF and reconnect logic and passes through
  proxies less reliably. Not needed for one-way updates.
- **Polling.** Simple, but either slow or wasteful; no streaming answer text.
- **A message broker (Redis pub/sub, NATS).** Extra infrastructure; NOTIFY is enough at alpha scale.

## Consequences

- Works through standard HTTP infrastructure; the web app proxies it through a Next.js route handler
  ([ADR-0012](0012-web-nextjs.md)); iOS consumes it with `URLSession`.
- One dedicated `LISTEN` connection per API process, fanned out in memory.
- NOTIFY payloads must stay under ~8 KB; answer deltas are chunked (≤ 1500 chars).
- A client that missed more than 200 events must refetch task details (`GET /v1/tasks/:id`).
- **Deferred:** WebSockets/WebRTC for realtime voice (Phase 5), where low-latency bidirectional audio
  is required.
