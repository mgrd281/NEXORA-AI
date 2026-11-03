# ADR-0002: Modular monolith on Fastify 5 + Zod (not NestJS), with a separate worker process

- Status: Accepted
- Date: 2026-11-03

## Context

The backend has to serve a typed HTTP API, a realtime stream and a long-running agent runtime. The
team is small; the most valuable properties are a short path from contract to handler, explicit
dependencies that are easy to fake in tests, and no hidden framework behaviour around security
(auth, CSRF, validation).

## Decision

- **One deployable package, `apps/api`, two processes**:
  - `src/server.ts` — Fastify 5 HTTP API (`dist/server.js` in production).
  - `src/worker.ts` — durable job worker running the agent runtime (`dist/worker.js`).
  - `src/cli.ts` — operator CLI (`create-owner`).
- **Modules by domain** under `src/modules/*` (auth, account, tasks, approvals, connections, memory,
  notifications, voice, home, usage, admin, stream, agent, jobs, events, audit). Modules talk through
  plain functions and the interfaces in `src/services.ts`.
- **Contract-driven routes.** `defineRoute(app, deps, routeName, handler)` (`src/http/route.ts`) binds
  a handler to an entry of the shared route table (`packages/contracts/src/routes.ts`): method, path,
  auth level, Zod validation of params/query/body, `Idempotency-Key` replay and validation of the
  response against its contract all come from the table. Boot fails if any route lacks a handler.
- **Explicit dependency injection.** `AppDeps` (`config`, `db`, `secrets`, `agent`, `listen`) is built
  once in `server.ts`; `AgentServices` (`tasks`, `approvals`, `status`) is the only seam between HTTP
  handlers and the agent runtime. No container, no decorators.

## Alternatives considered

- **NestJS.** Mature DI and module system, but adds layers (decorators, providers, pipes, guards)
  around exactly the parts we want to see plainly, and duplicates what the Zod route table already
  provides. Rejected for now.
- **Microservices** (separate planner, executor, API services). Rejected: operational cost and
  distributed-transaction problems with no benefit at one-owner scale. The module boundaries keep a
  later split possible.
- **Running the agent inside the API process.** Rejected: model calls and tool executions take
  seconds to minutes; isolating them lets the API stay responsive and lets workers scale and restart
  independently.

## Consequences

- Handlers are small; most logic lives in services that are tested without HTTP.
- The API and worker share the database schema, configuration and code version; they must be deployed
  together (see [operations runbook](../runbooks/operations.md)).
- Revisit this ADR when more than ~3 teams work on the backend, or when one module needs an
  independent scaling or release cadence (most likely candidates: telephony and the browser agent).
