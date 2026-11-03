# Local development

Everything runs locally against PostgreSQL 16; no cloud account is needed. Without an
`ANTHROPIC_API_KEY`, JARVIS runs its offline rules planner (and says so in the UI).

## Prerequisites

| Tool                   | Version                                                         | Notes                              |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------- |
| Node.js                | ≥ 22.12 (`.nvmrc`: 22)                                          | ESM throughout                     |
| pnpm                   | 10.28.0 (`packageManager` in `package.json`; `corepack enable`) | Do not use npm/yarn in the repo    |
| PostgreSQL             | 16, with `citext`, `pgcrypto`, `pg_trgm` (contrib)              | pgvector not required              |
| `psql`                 | matching client                                                 | Used by `scripts/db-setup.sh`      |
| Xcode + XcodeGen 2.42+ | Only for the iOS app (macOS)                                    | `cd apps/ios && xcodegen generate` |

## 1. Install and start the database

```bash
pnpm install --frozen-lockfile
bash scripts/ensure-postgres.sh          # dev containers: starts the local cluster if needed
ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm db:setup
```

`scripts/db-setup.sh` creates the roles `jarvis_owner` (schema owner, migrations) and `jarvis_app`
(runtime, `NOBYPASSRLS`) and the databases `jarvis` and `jarvis_test`. Passwords default to
`jarvis_owner_dev` / `jarvis_app_dev` (override with `JARVIS_OWNER_PASSWORD`, `JARVIS_APP_PASSWORD`;
databases with `JARVIS_DATABASES`). These defaults are for local development and CI only.

## 2. Configure the API

```bash
cp .env.example apps/api/.env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → SECRET_ENCRYPTION_KEY
```

| Variable                                       | Dev value                                                          | Purpose                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `DATABASE_URL`                                 | `postgresql://jarvis_app:jarvis_app_dev@localhost:5432/jarvis`     | Runtime role (RLS enforced)                                   |
| `DATABASE_OWNER_URL`                           | `postgresql://jarvis_owner:jarvis_owner_dev@localhost:5432/jarvis` | Migrations only                                               |
| `WEB_ORIGIN`                                   | `http://localhost:3000`                                            | Allowed `Origin` for cookie mutations                         |
| `SECRET_ENCRYPTION_KEY` / `_ID`                | 32 random bytes base64 / `k1`                                      | Connection secret encryption                                  |
| `ANTHROPIC_API_KEY`                            | empty (offline) or your key                                        | Model mode                                                    |
| `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_DEEP` | `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5`       | Model tiers                                                   |
| `FETCH_ALLOW_PRIVATE_HOSTS`                    | `127.0.0.1:4599`                                                   | Lets `web.fetch` reach the local fixture site (dev/test only) |
| `SMTP_ALLOW_INSECURE_LOCALHOST`                | `true`                                                             | Lets you connect the dev mailbox without TLS (dev/test only)  |
| `APPROVAL_TTL_HOURS`                           | 24                                                                 | Approval expiry                                               |
| `WORKER_CONCURRENCY`                           | 4                                                                  | Parallel jobs per worker                                      |
| `SESSION_TTL_DAYS`                             | 30                                                                 | Session lifetime                                              |
| `PORT` / `HOST` / `LOG_LEVEL`                  | 4000 / 127.0.0.1 / info                                            | API listener                                                  |

The two dev-only variables make the API refuse to start when `NODE_ENV=production`.

## 3. Migrate

```bash
pnpm db:migrate        # = pnpm --filter @jarvis/api db:migrate (uses DATABASE_OWNER_URL)
```

Migrations in `db/migrations/*.sql` run in order, each in a transaction, recorded with a SHA-256 in
`schema_migrations`; an applied file that was edited afterwards stops the run. Never edit an applied
migration — add a new file (`0002_….sql`).

## 4. Create the owner account

There is no sign-up. Create the account with the CLI; the password comes from the environment so it
does not land in shell history or `ps` output:

```bash
read -rs JARVIS_OWNER_PASSWORD && export JARVIS_OWNER_PASSWORD   # ≥ 12 characters
pnpm --filter @jarvis/api cli create-owner --email you@example.com --name "Your Name" --locale en --time-zone Europe/Berlin
# add --admin to also grant platform_admin (Admin screen)
unset JARVIS_OWNER_PASSWORD
```

## 5. Run

```bash
pnpm --filter @jarvis/api dev          # API on http://127.0.0.1:4000 (tsx watch)
pnpm --filter @jarvis/api dev:worker   # worker (required: nothing is planned or executed without it)
pnpm --filter @jarvis/web dev          # web on http://localhost:3000
```

`pnpm dev` starts API and web in parallel but **not the worker** — start it separately.
Health: `curl http://127.0.0.1:4000/healthz`, `curl http://127.0.0.1:4000/readyz`.

## 6. Dev mailbox (real SMTP path, no provider account)

```bash
pnpm --filter @jarvis/api dev:mailbox
# SMTP on 127.0.0.1:2525, received messages at http://127.0.0.1:2580/messages (and /messages/<id>)
```

In the app: Connections → Email → host `127.0.0.1`, port `2525`, security `none`, any from address
(requires `SMTP_ALLOW_INSECURE_LOCALHOST=true`). Messages are kept in memory until the process stops.
Ports can be changed with `MAILBOX_SMTP_PORT` / `MAILBOX_HTTP_PORT`.

## 7. Fixture site (for `web.fetch`)

`web.fetch` refuses private addresses; the dev allow-list `FETCH_ALLOW_PRIVATE_HOSTS=127.0.0.1:4599`
admits exactly that host and port. Serve any local HTML there, for example:

```bash
mkdir -p /tmp/jarvis-site && cat > /tmp/jarvis-site/article.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test article</title></head>
<body><main><h1>Test article</h1><p>This is a local page for trying the summarize flow end to end.</p>
<p>It contains a few full sentences so that the extractive summary has something to pick.</p></main></body></html>
HTML
python3 -m http.server 4599 --bind 127.0.0.1 --directory /tmp/jarvis-site
```

Then ask JARVIS: "Summarize http://127.0.0.1:4599/article.html and email it to me". The automated
tests use their own in-process fixture site (`apps/api/test/fixtures/http-site.ts`) and SMTP sink
(`apps/api/test/fixtures/smtp-sink.ts`).

## 8. Tests and checks

| Command                                                      | What                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                             | `tsc` in every package                                                                                   |
| `pnpm lint`                                                  | ESLint 9                                                                                                 |
| `pnpm test`                                                  | Unit tests (all packages; API `test/unit/**`)                                                            |
| `pnpm test:integration`                                      | API integration tests against `jarvis_test` (`TEST_DATABASE_URL`, `TEST_DATABASE_OWNER_URL` to override) |
| `pnpm --filter @jarvis/tokens test`                          | WCAG contrast of every token pair                                                                        |
| `pnpm e2e`                                                   | Playwright end-to-end + axe (web app)                                                                    |
| `pnpm tokens:build`                                          | Regenerate CSS/JSON/Swift/Kotlin tokens                                                                  |
| `pnpm openapi` / `pnpm --filter @jarvis/api openapi --check` | Regenerate / verify `docs/api/openapi.json`                                                              |
| `pnpm --filter @jarvis/api build`                            | Production bundles in `apps/api/dist`                                                                    |

**Warning:** the integration global setup runs `DROP SCHEMA public CASCADE` on the test database
before migrating. Never point `TEST_DATABASE_OWNER_URL` at a database you care about.

## 9. Model mode locally (optional)

Set `ANTHROPIC_API_KEY` in `apps/api/.env` and restart API and worker. The default monthly budget is
$20 per user (`Settings → Spending`); costs are recorded per call (`GET /v1/usage`). Estimates:
[costs](../costs.md).

## Troubleshooting

| Symptom                                                    | Cause / fix                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Invalid environment configuration: SECRET_ENCRYPTION_KEY` | Must be exactly 32 bytes, base64                                                                       |
| `Role jarvis_app must exist before migrating`              | Run `pnpm db:setup` first                                                                              |
| `Migration … was modified after being applied`             | Restore the original file; add a new migration                                                         |
| Tasks stay `QUEUED`                                        | Worker not running; `GET /v1/assistant/status` shows `worker.healthy: false`                           |
| `FETCH_BLOCKED` for your local page                        | Host/port not exactly in `FETCH_ALLOW_PRIVATE_HOSTS`                                                   |
| `CONNECTION_FAILED` "Unencrypted SMTP is not allowed"      | Set `SMTP_ALLOW_INSECURE_LOCALHOST=true` (dev) or use TLS/STARTTLS                                     |
| SMTP to a real provider refused as a private address       | Known issue in `lib/net.ts` ([known limitations](../known-limitations.md))                             |
| `403` "Cross-site request blocked"                         | Cookie request without `Origin: WEB_ORIGIN` — call the API through the web proxy or use a bearer token |
