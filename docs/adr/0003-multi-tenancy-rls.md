# ADR-0003: Multi-tenancy through PostgreSQL Row-Level Security

- Status: Accepted
- Date: 2026-11-03

## Context

JARVIS starts with one owner but is designed for thousands of customers. A personal agent stores the
most sensitive data a person has (requests, emails, memories, credentials). A single missing
`WHERE tenant_id = …` in application code must not become a cross-tenant data leak.

## Decision

- **Database-enforced isolation.** Every tenant table has RLS enabled (`db/migrations/0001_init.sql`).
  - Tenant tables (`tenants`, `users`, `subscriptions`): `tenant_id = app_current_tenant()`.
  - User-private tables (tasks, steps, approvals, events, messages, memories, connections, sessions,
    notifications, usage, costs, idempotency keys, …): `tenant_id = app_current_tenant() AND
user_id = app_current_user()`, for reads (`USING`) and writes (`WITH CHECK`).
- **Non-owner runtime role.** The API and worker connect as `jarvis_app` (`NOSUPERUSER NOBYPASSRLS`),
  which is not the table owner, so RLS always applies. Migrations run as `jarvis_owner`.
- **Transaction-local context.** All tenant access goes through
  `withContext(db, { tenantId, userId }, trx => …)` (`apps/api/src/db/pool.ts`), which runs
  `set_config('app.tenant_id', …, true)` and `set_config('app.user_id', …, true)` inside a
  transaction. Settings vanish at commit, so pooled connections never leak identity. Without context,
  queries return zero rows.
- **Narrow cross-tenant functions.** The few operations that cannot know the tenant in advance are
  `SECURITY DEFINER` functions with a fixed `search_path`, `EXECUTE` revoked from `PUBLIC` and granted to `jarvis_app`:
  `auth_find_login`, `auth_resolve_session`, `auth_user_roles`, and the admin aggregates
  `admin_overview`, `admin_list_users`, `admin_list_audit`.
- **Admin never sees content.** Admin functions return counts, health, reliability, cost and account
  metadata (email, tenant name, roles, task count) — never requests, messages, memories or emails.
  `admin_list_audit` omits event metadata. Admin reads are themselves audited.
- **Infrastructure tables** `jobs` and `worker_heartbeats` have no RLS (the worker must lease across
  tenants); every job carries `tenant_id`/`user_id` and handlers re-enter `withContext` before touching
  tenant data. `audit_events` has no RLS but `jarvis_app` has `INSERT` only.

## Alternatives considered

- **Application-level filtering only.** Simple, but one forgotten predicate leaks data. Rejected.
- **Schema per tenant / database per tenant.** Strong isolation, but migrations, connection pooling
  and cross-tenant operations (login, admin aggregates) become expensive at thousands of tenants. Kept
  as an option for enterprise customers later.
- **Separate admin role with `BYPASSRLS`.** Rejected: any bug in an admin endpoint would expose
  content. Narrow functions limit admin to what they are meant to see.

## Consequences

- Isolation is tested against the real database (`apps/api/test/integration/rls.int.test.ts`).
- Every query that forgets `withContext` returns nothing instead of something wrong — failures are
  loud, not leaky.
- `users` is tenant-scoped, not user-scoped: in a future multi-member tenant, members can read each
  other's `users` rows through `jarvis_app`. Application code must never select another user's
  `password_hash`; a column-restricted view is planned before multi-member tenants ship.
- `SECURITY DEFINER` functions are privileged code; each change needs security review.
