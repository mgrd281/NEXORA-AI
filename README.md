# JARVIS

JARVIS is a secure, multi-tenant personal AI agent platform: you ask in plain language, it shows you
a plan, asks before it acts on the world, executes with durable checkpoints, and proves results with
evidence. It runs on a TypeScript modular monolith (API + worker) over PostgreSQL with Row-Level
Security, with a Next.js web app and a SwiftUI iPhone app.

## Status

**Milestone 1 — private alpha foundation.** One owner, invitation only (no public sign-up). Five
tools (`web.fetch`, `text.summarize`, `email.send`, `memory.save`, `assistant.answer`); without an
`ANTHROPIC_API_KEY` JARVIS runs an offline rules planner and says so in the UI. Read
[docs/known-limitations.md](docs/known-limitations.md) before relying on anything — it lists what is
not built, not verified, and known defects.

## Architecture at a glance

| Part                 | What                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `apps/api` — API     | Fastify 5, Zod-validated contract routes, cookie (web) / bearer (native) sessions, SSE events |
| `apps/api` — worker  | Durable PostgreSQL job queue (`FOR UPDATE SKIP LOCKED`), plan → policy → approval → execute   |
| PostgreSQL 16        | Only datastore; RLS on every tenant table; runtime role `jarvis_app` is not the table owner   |
| `apps/web`           | Next.js 16 App Router; same-origin `/api` proxy so the session cookie stays first-party       |
| `apps/ios`           | SwiftUI client (not compiled in this environment — see [its README](apps/ios/README.md))      |
| `packages/contracts` | Shared Zod schemas, task state machine and route table (OpenAPI is generated from it)         |
| `packages/tokens`    | Meridian design tokens → CSS, JSON, Swift, Kotlin                                             |

Start with the [architecture overview](docs/architecture/overview.md), then the
[agent runtime](docs/architecture/agent-runtime.md), [data model](docs/architecture/data-model.md),
[API conventions](docs/architecture/api.md), [threat model](docs/security/threat-model.md) and the
[ADRs](docs/adr/). The full index is [docs/README.md](docs/README.md).

## Quickstart (local, no Docker)

Prerequisites: Node.js ≥ 22.12 (`.nvmrc`), pnpm 10.28 (`corepack enable`), PostgreSQL 16 with
contrib extensions and `psql`. Details and troubleshooting:
[docs/runbooks/local-development.md](docs/runbooks/local-development.md).

```bash
pnpm install --frozen-lockfile

# Configure the API; set SECRET_ENCRYPTION_KEY to the generated value (32 bytes, base64).
cp .env.example apps/api/.env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# For the local helpers also set FETCH_ALLOW_PRIVATE_HOSTS=127.0.0.1:4599 and
# SMTP_ALLOW_INSECURE_LOCALHOST=true in apps/api/.env (development only).

# Database roles (jarvis_owner, jarvis_app) and databases (jarvis, jarvis_test), then migrate.
bash scripts/ensure-postgres.sh   # dev containers only: starts the local cluster
ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres bash scripts/db-setup.sh
pnpm db:migrate

# Create the owner account. The password is read from the environment, never from arguments.
read -rs JARVIS_OWNER_PASSWORD && export JARVIS_OWNER_PASSWORD   # at least 12 characters
pnpm --filter @jarvis/api cli create-owner --email you@example.com --name "Your Name" --admin
unset JARVIS_OWNER_PASSWORD

# Run everything: API :4000, worker, dev mailbox (SMTP :2525, UI :2580), fixture site :4599, web :3000.
scripts/dev.sh
```

Open http://localhost:3000 and sign in. Try "Summarize http://127.0.0.1:4599/article and email it to
me" after connecting email in Connections (host `127.0.0.1`, port `2525`, security `none`); sent mail
appears at http://127.0.0.1:2580/messages. `scripts/dev.sh` prefixes each service's log, stops all of
them on Ctrl-C or when one exits, and accepts `DEV_SKIP="web mailbox"` to leave services out.

Check a running API: `SMOKE_EMAIL=you@example.com scripts/smoke.sh http://127.0.0.1:4000` (liveness,
readiness, sign-in, worker heartbeat, sign-out; prompts for the password).

> `scripts/db-setup.sh` reads `JARVIS_OWNER_PASSWORD` as the **database role** password, while the
> CLI reads it as the **account** password. Run `db-setup.sh` in a shell where it is not exported.

## Docker Compose (local full stack)

```bash
cp docker/compose.env.example .env     # fill in the four required secrets; .env is git-ignored
docker compose up --build -d
read -rs JARVIS_OWNER_PASSWORD && export JARVIS_OWNER_PASSWORD
docker compose exec -e JARVIS_OWNER_PASSWORD api node dist/cli.js create-owner \
  --email you@example.com --name "Your Name" --admin
```

Services: `postgres` (roles and database created on first start by
[docker/postgres/init](docker/postgres/init/10-jarvis-roles.sh)), `migrate` (one-shot), `api`,
`worker`, `web`, `dev-mailbox`, `fixture-site`. Ports are published on 127.0.0.1 only. The compose
stack runs in development mode for local use; it is not a production deployment. Images:
[apps/api/Dockerfile](apps/api/Dockerfile) (API, worker, migrations and CLI in one image; non-root,
`HEALTHCHECK` on `/healthz`) and [apps/web/Dockerfile](apps/web/Dockerfile) (Next.js standalone).

## Testing

| Command                                                | What                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `pnpm typecheck`                                       | `tsc` in every package                                                     |
| `pnpm lint`                                            | ESLint 9                                                                   |
| `pnpm test`                                            | Unit tests in every package (Vitest)                                       |
| `pnpm test:integration`                                | API against PostgreSQL `jarvis_test` — **drops and re-creates its schema** |
| `pnpm e2e`                                             | Playwright + axe against a running stack (web app)                         |
| `pnpm exec prettier --check apps/*/src packages/*/src` | Formatting                                                                 |
| `pnpm tokens:build`                                    | Regenerate design tokens (CI fails if generated files are stale)           |
| `pnpm --filter @jarvis/api openapi --check`            | `docs/api/openapi.json` matches the contracts                              |
| `node --test .github/scripts/*.test.mjs`               | CI tooling (dependency-audit gate)                                         |
| `node .github/scripts/audit-gate.mjs`                  | Production dependency audit, blocking at `high`                            |

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on pushes to `main`, on every pull
request and on demand: **quality** (install with the frozen lockfile, tokens up to date, OpenAPI up
to date, typecheck, lint, unit tests, format), **integration** (PostgreSQL 16 service), **build**
(API esbuild bundle, `next build`), **e2e** (migrated database, owner created through the CLI with a
per-run generated password, API + worker + dev mailbox + fixture site + `next start`, Playwright;
report, test results and service logs uploaded as artifacts), **images** (builds the API, devtools and
web images, checks they run as non-root and that a planted `.env` never reaches them, then runs
migrate, API, worker and web from the images until healthy) and **security** (gitleaks over the git
history, `pnpm audit --prod` blocking at `high`). Exceptions to the audit go in
[.github/audit-allowlist.json](.github/audit-allowlist.json) with a reason and an expiry of at most
90 days; expired entries fail CI.

## Project structure

```
.
├── apps/
│   ├── api/                 Fastify API, durable worker, operator CLI (TypeScript)
│   │   ├── src/             config, db (Kysely, RLS context), http, lib, modules/*
│   │   ├── test/            unit/ and integration/ (Vitest), fixtures/
│   │   ├── scripts/         build.mjs (esbuild), openapi.ts, dev-mailbox.ts
│   │   └── Dockerfile
│   ├── web/                 Next.js web app + Playwright e2e
│   └── ios/                 SwiftUI app (XcodeGen project)
├── packages/
│   ├── contracts/           Zod schemas, enums, task state machine, route table
│   └── tokens/              Meridian design tokens and generators
├── db/migrations/           Plain SQL migrations (applied in order, checksummed)
├── docker/                  Compose helpers: postgres init script, env example
├── docs/                    Product, architecture, ADRs, security, design, runbooks
├── scripts/                 db-setup.sh, ensure-postgres.sh, dev.sh, smoke.sh, fixture-site.mjs
├── .github/                 CI workflow, Dependabot, PR template, audit gate
└── docker-compose.yml
```

## Security

- **Never commit secrets.** `.env` files are git-ignored (only `.env.example` is tracked) and kept out
  of Docker build contexts. CI scans every push and pull request with gitleaks. Report suspected
  vulnerabilities privately to the owner, not in public issues.
- **Invitation only.** There is no sign-up endpoint; accounts are created with the operator CLI.
- **Tenant isolation is enforced by PostgreSQL**, not only by application code: every tenant query
  runs through `withContext`, and the runtime role cannot bypass RLS.
- **Development allowances are refused in production.** `FETCH_ALLOW_PRIVATE_HOSTS` and
  `SMTP_ALLOW_INSECURE_LOCALHOST` exist only for the local fixture site and dev mailbox; the API will
  not start with them when `NODE_ENV=production`, and production requires an `https` `WEB_ORIGIN`.
- Containers run as the unprivileged `node` user with application code owned by root.
- Supply chain: exact dependency pins and a committed lockfile, install scripts only for allow-listed
  packages, weekly grouped Dependabot updates, blocking production audit.

Follow-ups (not done yet):

- Pin GitHub Actions to full commit SHAs (currently major tags: `actions/checkout@v4`,
  `actions/setup-node@v4`, `pnpm/action-setup@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`,
  `actions/download-artifact@v4`, `gitleaks/gitleaks-action@v2`) and let Dependabot maintain them.
- Pin base images by digest (`node:22-bookworm-slim`, `postgres:16`).
- Organization-owned repositories need a `GITLEAKS_LICENSE` secret for the gitleaks action.
- Container image scanning and SBOM generation; a scheduled run of the dependency audit.

## Contributing

- Branch from `main`, open a pull request, and fill in the
  [template](.github/pull_request_template.md) — including what you could not test.
- Contracts (`packages/contracts`) are the source of truth for every API shape; change them
  deliberately and regenerate `docs/api/openapi.json` (`pnpm openapi`).
- Never edit an applied migration; add `db/migrations/NNNN_description.sql`.
- Every dependency is pinned to an exact version; use pnpm only, and explain new dependencies.
- No placeholder data or simulated progress: every status the UI shows must reflect real system
  state, and every result must be backed by evidence.
- Format with Prettier (`pnpm exec prettier --write <files>`), keep lint and types clean, and add
  tests with the code. Architectural decisions get an ADR in [docs/adr](docs/adr/).
