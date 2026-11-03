# ADR-0001: pnpm monorepo with shared contracts and tokens

- Status: Accepted
- Date: 2026-11-03
- Deciders: Principal architect, owner

## Context

JARVIS ships a backend, a web app and native apps that must agree exactly on API shapes, the task
state machine, error codes and the design language. Drift between them is a correctness and a
trust problem: a client that shows a state the server does not have is showing fake state.

## Decision

- One repository, pnpm workspaces (`pnpm@10.28.0`, Node `>=22.12.0`, ESM everywhere).
- Layout:

  | Path                 | What                                                             | Language   |
  | -------------------- | ---------------------------------------------------------------- | ---------- |
  | `apps/api`           | Fastify API, durable worker, operator CLI                        | TypeScript |
  | `apps/web`           | Next.js web app                                                  | TypeScript |
  | `apps/ios`           | SwiftUI app (not a pnpm package)                                 | Swift      |
  | `packages/contracts` | Zod schemas, enums, task state machine, route table              | TypeScript |
  | `packages/tokens`    | Meridian design tokens and generators (CSS, JSON, Swift, Kotlin) | TypeScript |
  | `db/migrations`      | Plain SQL migrations                                             | SQL        |

- Workspace packages are consumed as TypeScript source (`exports: ./src/index.ts`); the API build
  (esbuild) and the web build bundle them. No separate publish step.
- TypeScript **6.0.3**. The TypeScript 7 native port is not yet supported by `typescript-eslint`
  (8.72.1), so lint would lose type-aware rules.
- ESLint **9.39.5**, pinned: the `eslint-config-next@16.4.4` plugins declare a peer dependency on
  ESLint 9.
- Every dependency is pinned to an exact version; `pnpm-lock.yaml` is committed; install scripts are
  allowed only for the packages listed in `pnpm-workspace.yaml` (`onlyBuiltDependencies`).

## Alternatives considered

- **Polyrepo** (one repo per app). Rejected: contract changes would need coordinated releases across
  repos; the cost is highest exactly where correctness matters most.
- **Nx / Turborepo.** Not needed at this size; pnpm filters (`pnpm --filter @jarvis/api …`) and
  `pnpm -r` cover build, test and typecheck. Revisit when CI time becomes a problem.
- **TypeScript 7 (native)**. Faster, but loses type-aware lint today. Revisit when `typescript-eslint`
  supports it.
- **OpenAPI-first with generated TypeScript types.** Rejected for the TypeScript side: Zod schemas give
  runtime validation and static types from one definition. OpenAPI is generated _from_ the contracts
  instead (`docs/api/openapi.json`), which also serves Swift/Kotlin clients.

## Consequences

- A contract change is one commit that the API, web and the OpenAPI document pick up together; the API
  refuses to boot if a route in the table has no handler (`assertAllRoutesRegistered`).
- Swift and Kotlin cannot import Zod; they use generated tokens (`Tokens.swift`, `Tokens.kt`) and
  hand-written models checked against `docs/api/openapi.json`. Keeping those models in sync is a
  manual review item until a generator is added.
- Pinned toolchain versions need deliberate upgrades (see [release checklist](../release-checklist.md)).
