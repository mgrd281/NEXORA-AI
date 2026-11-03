# Data model

Source of truth: `db/migrations/0001_init.sql` (PostgreSQL 16; extensions `citext`, `pgcrypto`,
`pg_trgm`). Kysely row types: `apps/api/src/db/types.ts`. Every timestamp is `timestamptz`; every id is
a `uuid` (`gen_random_uuid()`) except the append-only logs and the job queue (`bigserial`). Money is
integer micro-USD (`bigint`).

## 1. Entity-relationship diagram

Every user-private table also has `tenant_id → tenants.id ON DELETE CASCADE`; those edges are omitted
for readability.

```mermaid
erDiagram
  tenants ||--o{ users : has
  tenants ||--o{ subscriptions : has
  users ||--o{ user_roles : has
  users ||--o{ devices : owns
  users ||--o{ sessions : owns
  devices |o--o{ sessions : "signed in on"
  users ||--o{ conversations : owns
  conversations ||--o{ tasks : contains
  conversations ||--o{ messages : contains
  tasks |o--o{ messages : "about"
  tasks ||--o{ task_steps : "planned as"
  task_steps ||--o{ tool_executions : "attempted as"
  task_steps ||--o{ approvals : "gated by"
  tasks |o--o{ task_events : "history of"
  users ||--o{ connections : owns
  users ||--o{ memories : owns
  tasks |o--o{ memories : "saved by"
  users ||--o{ notifications : receives
  users ||--o{ voice_sessions : records
  tasks |o--o{ voice_sessions : "started"
  users ||--o{ call_sessions : "Phase 5"
  users ||--o{ browser_sessions : "Phase 4"
  users ||--o{ scheduled_tasks : "planned"
  users ||--o{ usage_events : meters
  usage_events |o--o{ cost_records : "priced as"
  tasks |o--o{ cost_records : "costs of"
  users ||--o{ idempotency_keys : claims

  tenants {
    uuid id PK
    text name
    text status "active | suspended"
  }
  users {
    uuid id PK
    uuid tenant_id FK
    citext email UK
    text display_name
    text password_hash "argon2id"
    text locale "en | de | ar"
    text time_zone
    text theme
    jsonb preferences
    text status "active | disabled"
    timestamptz last_active_at
  }
  user_roles {
    uuid user_id PK
    text role PK "owner | member | platform_admin"
  }
  devices {
    uuid id PK
    uuid user_id FK
    text platform
    bytea push_token_ciphertext
    timestamptz revoked_at
  }
  sessions {
    uuid id PK
    uuid user_id FK
    uuid device_id FK
    bytea token_hash UK "SHA-256 of token"
    text platform
    timestamptz expires_at
    timestamptz revoked_at
  }
  conversations {
    uuid id PK
    uuid user_id FK
    text title
  }
  messages {
    uuid id PK
    uuid conversation_id FK
    uuid task_id FK
    text role "user | assistant | system"
    text content
  }
  tasks {
    uuid id PK
    uuid conversation_id FK
    text request "1..4000 chars"
    text status "state machine"
    text risk_level
    text source "text | voice | schedule | api"
    jsonb planner
    text answer
    text result_summary
    jsonb evidence
    jsonb error
    bigint estimated_cost_micro
    bigint actual_cost_micro
    integer attempt
    integer version "optimistic lock"
    timestamptz cancel_requested_at
    text idempotency_key "unique per user"
  }
  task_steps {
    uuid id PK
    uuid task_id FK
    integer position
    text step_key "s1..s8"
    text tool_id
    jsonb input "as planned"
    jsonb resolved_input "as executed"
    jsonb output
    text status
    text risk_level
    jsonb policy
    jsonb evidence
    integer attempts
  }
  tool_executions {
    uuid id PK
    uuid step_id FK
    text tool_version
    text idempotency_key UK
    text status "started | succeeded | failed | unknown"
    text input_hash
    jsonb output
    jsonb evidence
    bigint cost_micro
    integer duration_ms
  }
  approvals {
    uuid id PK
    uuid step_id FK
    text status
    text summary
    jsonb details "exact action shown"
    text action_hash "SHA-256"
    text_array reasons
    timestamptz expires_at
    text decision_channel
  }
  task_events {
    bigint id PK "SSE id"
    uuid user_id FK
    uuid task_id FK
    text type
    jsonb data
  }
  connections {
    uuid id PK
    uuid user_id FK
    text provider "web | smtp"
    text status
    jsonb config "non-secret"
    bytea secret_ciphertext "AES-256-GCM"
    text secret_key_id
  }
  memories {
    uuid id PK
    uuid user_id FK
    text kind "preference | fact"
    text content "1..1000 chars"
    text source "user | assistant"
    uuid source_task_id FK
    tsvector search "simple config"
  }
  notifications {
    uuid id PK
    uuid user_id FK
    text kind
    uuid task_id FK
    jsonb data "i18n params only"
    timestamptz read_at
  }
  voice_sessions {
    uuid id PK
    uuid user_id FK
    text engine
    text outcome
    integer transcript_chars
    uuid task_id FK
  }
  call_sessions {
    uuid id PK
    bytea callee_number_ciphertext
    boolean ai_disclosed
    boolean recording_consent
  }
  browser_sessions {
    uuid id PK
    text isolation_profile
  }
  scheduled_tasks {
    uuid id PK
    text rrule
    text time_zone
    timestamptz next_run_at
  }
  usage_events {
    uuid id PK
    text kind "model_tokens | tool_call"
    text model
    integer input_tokens
    integer output_tokens
  }
  cost_records {
    uuid id PK
    uuid usage_event_id FK
    text category "model | tool | telephony"
    bigint amount_micro
  }
  subscriptions {
    uuid id PK
    uuid tenant_id FK
    text plan "private_alpha"
    text status
  }
  idempotency_keys {
    uuid user_id PK
    text route PK
    text key PK
    text request_hash
    jsonb response_body
  }
  audit_events {
    bigint id PK
    uuid tenant_id "no FK"
    text actor_type
    uuid actor_id "no FK"
    text action
    jsonb metadata "never content"
  }
  jobs {
    bigint id PK
    text kind
    uuid tenant_id
    uuid user_id
    uuid task_id
    text status
    text dedupe_key
    timestamptz run_at
    integer attempts
    timestamptz locked_until
  }
  worker_heartbeats {
    text worker_id PK
    timestamptz last_heartbeat_at
  }
  feature_flags {
    text key PK
    boolean enabled
  }
```

### Tables by purpose

| Group                            | Tables                                                                                                | Notes                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Identity                         | `tenants`, `users`, `user_roles`, `devices`, `sessions`                                               | Email is `citext`, globally unique. Tokens stored only as SHA-256. |
| Work                             | `conversations`, `messages`, `tasks`, `task_steps`, `tool_executions`, `approvals`, `task_events`     | `task_events` is the append-only history and SSE replay log.       |
| Capabilities                     | `connections`, `memories`, `notifications`, `voice_sessions`                                          | One non-revoked connection per provider per user.                  |
| Reserved (unused in Milestone 1) | `call_sessions` (Phase 5), `browser_sessions` (Phase 4), `scheduled_tasks`                            | Created now so the model is complete.                              |
| Metering                         | `usage_events`, `cost_records`, `subscriptions`                                                       | `subscriptions` row created per tenant by `create-owner`.          |
| Platform                         | `audit_events`, `jobs`, `worker_heartbeats`, `feature_flags`, `idempotency_keys`, `schema_migrations` | `schema_migrations` is created by the migrator.                    |

### Notable constraints and indexes

- `tool_executions.idempotency_key UNIQUE` — the exactly-once guarantee
  ([ADR-0010](../adr/0010-exactly-once-side-effects.md)).
- `approvals_one_pending_per_step` — partial unique index: at most one `PENDING` approval per step.
- `jobs_dedupe_live_idx` — partial unique index on `dedupe_key` for `queued`/`running` jobs.
- `tasks_idempotency_idx` — unique `(user_id, idempotency_key)`.
- `connections_one_per_provider` — unique `(user_id, provider)` where `status <> 'revoked'`.
- `task_steps` unique `(task_id, position)` and `(task_id, step_key)`.
- `memories_search_idx` (GIN on `tsvector`), `memories_trgm_idx` (GIN trigram).
- `updated_at` maintained by triggers on 11 tables.
- `audit_events` has a trigger that raises on `UPDATE`/`DELETE` (append-only for every role).
- Length/enum `CHECK` constraints mirror the contract enums (status, risk, locale, provider, …).

## 2. Row-Level Security model

```mermaid
flowchart LR
  req["Request or job<br/>(tenantId, userId)"] --> wc["withContext<br/>BEGIN<br/>set_config app.tenant_id, true<br/>set_config app.user_id, true"]
  wc --> q["Queries as jarvis_app"]
  q --> rls{"RLS policy"}
  rls -- "tenant table:<br/>tenant_id = app_current_tenant()" --> rows["Visible rows"]
  rls -- "user-private table:<br/>tenant AND user match" --> rows
  rls -- "no context set" --> none["Zero rows"]
```

| Class                   | Tables                                                                                                                                                                                                                                                                                                           | Policy (`USING` and `WITH CHECK`)                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tenant                  | `tenants`                                                                                                                                                                                                                                                                                                        | `id = app_current_tenant()`                                                                |
| Tenant                  | `users`, `subscriptions`                                                                                                                                                                                                                                                                                         | `tenant_id = app_current_tenant()`                                                         |
| User-private            | `user_roles`, `devices`, `sessions`, `conversations`, `tasks`, `messages`, `task_steps`, `tool_executions`, `approvals`, `task_events`, `connections`, `memories`, `notifications`, `voice_sessions`, `call_sessions`, `browser_sessions`, `scheduled_tasks`, `usage_events`, `cost_records`, `idempotency_keys` | `tenant_id = app_current_tenant() AND user_id = app_current_user()`                        |
| No RLS (infrastructure) | `jobs`, `worker_heartbeats`                                                                                                                                                                                                                                                                                      | Full DML for `jarvis_app`; job handlers re-enter `withContext(job.tenant_id, job.user_id)` |
| No RLS, insert-only     | `audit_events`                                                                                                                                                                                                                                                                                                   | `jarvis_app` has `INSERT` only; read via `admin_list_audit`                                |
| No RLS, read-only       | `feature_flags`                                                                                                                                                                                                                                                                                                  | `jarvis_app` has `SELECT` only                                                             |

Roles (created by `scripts/db-setup.sh`):

- `jarvis_owner` — owns the schema; runs migrations. As table owner it is **not** subject to RLS
  (no `FORCE ROW LEVEL SECURITY`); use it only for migrations and break-glass operations.
- `jarvis_app` — `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`; runtime role of API and
  worker; `CONNECT` on the database, no `CREATE` on `public`.

`SECURITY DEFINER` functions (fixed `search_path = public, pg_temp`, `EXECUTE` revoked from `PUBLIC`,
granted to `jarvis_app`):

| Function                             | Returns                                                                       | Used by                      |
| ------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------- |
| `auth_find_login(email)`             | user id, tenant id, password hash, status                                     | `POST /v1/auth/login`        |
| `auth_resolve_session(token_hash)`   | session, user, tenant, expiry, platform (active, unexpired, user active)      | Auth hook, every request     |
| `auth_user_roles(user_id)`           | roles array                                                                   | `platform_admin` route guard |
| `admin_overview()`                   | counts, tasks by status, queue depth, 30-day cost, tool reliability (p50/p95) | `GET /v1/admin/overview`     |
| `admin_list_users(limit, before)`    | id, email, tenant name, roles, status, dates, task count (≤ 100)              | `GET /v1/admin/users`        |
| `admin_list_audit(limit, before_id)` | audit rows without `metadata` (≤ 200)                                         | `GET /v1/admin/audit`        |

Verified by `apps/api/test/integration/rls.int.test.ts` against a real database.

## 3. Retention policy (proposal)

Not implemented: Milestone 1 has **no automatic purge jobs**. Data stays until the user deletes it or
deletes the account. Proposal for closed beta (to be confirmed with the [privacy](../security/privacy.md)
review):

| Data                                                            | Proposed retention                                                                                                                 | Mechanism                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Tasks, steps, messages, task events, tool executions, approvals | Until the user deletes them or the account; option "auto-delete after N months" (default off)                                      | User-facing setting + daily purge job |
| Memories                                                        | Until the user deletes them                                                                                                        | Memory screen, `DELETE /v1/memories`  |
| Connections                                                     | Until disconnected; secrets wiped on disconnect                                                                                    | Implemented                           |
| Sessions                                                        | Revoked/expired rows deleted after 30 days                                                                                         | Purge job                             |
| Notifications                                                   | 90 days                                                                                                                            | Purge job                             |
| Voice session metadata                                          | 90 days                                                                                                                            | Purge job                             |
| `idempotency_keys`                                              | 72 hours                                                                                                                           | Purge job                             |
| `jobs`                                                          | `succeeded` after 7 days; `dead` after 30 days (after review)                                                                      | Purge job                             |
| `usage_events`, `cost_records`                                  | 24 months (spend history, abuse investigation); longer only if invoices require it                                                 | Purge job                             |
| `audit_events`                                                  | 13 months, then deleted by an owner-run maintenance task (the append-only trigger must be bypassed deliberately by `jarvis_owner`) | Maintenance runbook                   |
| Backups                                                         | 30 days rolling (deleted accounts disappear from backups within 30 days)                                                           | Backup provider                       |

## 4. Backup and restore

- **Production (proposed):** managed PostgreSQL with point-in-time recovery (PITR, WAL archiving) and
  daily snapshots, 30-day retention, encrypted at rest, in the same jurisdiction as the primary.
  Targets: RPO ≤ 5 minutes, RTO ≤ 4 hours for the alpha.
- **Logical backups** (portable, for restore drills and region moves):

  ```bash
  pg_dump --format=custom --no-owner --no-privileges \
    "$DATABASE_OWNER_URL" > jarvis-$(date -u +%Y%m%dT%H%M%SZ).dump
  ```

- **Restore** into a fresh database:
  1. `scripts/db-setup.sh` on the target server (creates `jarvis_owner`, `jarvis_app`, the database and
     schema ownership; the migration refuses to run if `jarvis_app` is missing).
  2. `pg_restore --no-owner --role=jarvis_owner -d "$TARGET_OWNER_URL" jarvis-….dump` (the dump
     contains `schema_migrations`, so `db:migrate` afterwards reports "up to date").
  3. Re-apply grants (the dump above is taken with `--no-privileges`): run the "Grants for the runtime
     role" section at the end of `0001_init.sql` as `jarvis_owner`, plus the `GRANT` statements of any
     later migration.
  4. Point the API and worker at the restored database with the **same** `SECRET_ENCRYPTION_KEY`
     (without it, connection secrets cannot be decrypted and mailboxes must be reconnected).
  5. Check `GET /readyz`, sign in, open a past task, run `POST /v1/connections/:id/test`.
- **Drill:** restore the latest backup into a scratch database monthly and run read-only smoke checks
  (row counts per table against the source, sign in, open a recent task, test a connection) — planned
  with the first production deployment. Never point the integration test suite at a restored or real
  database: its global setup drops and re-creates the `public` schema.
- Step-by-step operator procedure: [operations runbook](../runbooks/operations.md#backups-and-restore).
