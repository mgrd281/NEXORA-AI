# Operations runbook

For the private alpha deployment (proposed topology: [overview §7](../architecture/overview.md#7-deployment-topology-private-alpha-proposed)).
Nothing here is automated yet unless stated; commands assume shell access to the application hosts
and the owner database URL from the secret manager.

## Deploy

Build once, deploy the same artifact to API and worker.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
pnpm --filter @jarvis/api build      # dist/server.js, worker.js, cli.js, migrate.js, migrations/
pnpm --filter @jarvis/web build
```

The API bundles inline only the `@jarvis/*` workspace packages; every npm dependency stays an external
import, so the artifact must ship with a production install of `apps/api`'s dependencies
(`node_modules`) next to `dist/`.

Order:

1. **Migrate** (owner role): `DATABASE_OWNER_URL=… node apps/api/dist/migrate.js` (defaults
   `MIGRATIONS_DIR` to `dist/migrations`; serialised by an advisory lock, so concurrent deploys are safe).
2. **Worker**: start new workers, then send `SIGTERM` to old ones — they stop leasing and finish
   in-flight jobs. Jobs of a killed worker are reclaimed after lease expiry (≤ 75 s).
3. **API**: rolling restart (`SIGTERM` closes the server; open SSE streams are ended and clients
   reconnect with `Last-Event-ID`).
4. **Web**: `next start`.
5. Verify: `/readyz` 200; `GET /v1/admin/overview` → worker healthy, queue depth draining; sign in and
   open a recent task.

Migrations must be backward compatible with the previous code version (expand → deploy → contract).
Rollback = deploy the previous artifact; never roll back a migration that dropped data.

Required production environment: `NODE_ENV=production`, `WEB_ORIGIN=https://…`, `DATABASE_URL`
(jarvis_app), `SECRET_ENCRYPTION_KEY`, `SECRET_ENCRYPTION_KEY_ID`, optional `ANTHROPIC_API_KEY`,
`APP_VERSION`. Must **not** be set: `FETCH_ALLOW_PRIVATE_HOSTS`, `SMTP_ALLOW_INSECURE_LOCALHOST=true`
(the API refuses to boot).

## Migrate (ad hoc)

```bash
DATABASE_OWNER_URL=postgresql://jarvis_owner:…@db:5432/jarvis node apps/api/dist/migrate.js
psql "$DATABASE_OWNER_URL" -c "select filename, applied_at from schema_migrations order by filename"
```

## Rotate `SECRET_ENCRYPTION_KEY`

The current build holds **one** key ([ADR-0014](../adr/0014-secrets-encryption.md)); connections
sealed with an old key cannot be opened after rotation and must be reconnected.

1. Generate a key and a new id: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
   id `k2`.
2. Check for in-flight email work and let it finish (or cancel it):
   ```sql
   select id, status from tasks where status in ('RUNNING','AWAITING_APPROVAL','VERIFYING');
   ```
   Do not rotate while an `email.send` step is pending: in the current build a decryption failure at
   send time is reported as `OUTCOME_UNKNOWN` even though nothing was sent (known issue).
3. Store the new key in the secret manager; deploy API and worker with `SECRET_ENCRYPTION_KEY=<new>`,
   `SECRET_ENCRYPTION_KEY_ID=k2`.
4. Find connections still sealed with the old key and mark them so users see a clear state:
   ```sql
   update connections set status = 'error', last_error = 'Reconnect this mailbox (security key rotated).'
    where secret_ciphertext is not null and secret_key_id <> 'k2' and status <> 'revoked';
   ```
5. The owner reconnects SMTP (Connections → Email); the upsert re-seals with `k2`.
6. Destroy the old key after all rows show `secret_key_id = 'k2'`.
7. **Phone numbers (Phase D).** `do_not_call.number_hash` and `call_sessions.callee_number_hash`
   are HMACs keyed by a key derived (HKDF) from `SECRET_ENCRYPTION_KEY`; after the switch the
   policy would no longer recognise an existing do-not-call entry. **Before step 3 takes effect**
   (stop the worker and the API for the minute this takes), re-hash and re-seal with both keys
   from a checkout of the repository (`pnpm install` done; owner role, which bypasses RLS):

   ```bash
   cd apps/api && OLD_KEY=<old base64> NEW_KEY=<new base64> NEW_KEY_ID=k2 \
   DATABASE_OWNER_URL=postgresql://jarvis_owner:…@db:5432/jarvis node --input-type=module -e '
   import pg from "pg"; import c from "node:crypto";
   const { OLD_KEY, NEW_KEY, NEW_KEY_ID, DATABASE_OWNER_URL } = process.env;
   const hkey = (k) => Buffer.from(c.hkdfSync("sha256", Buffer.from(k, "base64"), Buffer.alloc(0), "jarvis/phone-number-hash/v1", 32));
   const hash = (e164) => c.createHmac("sha256", hkey(NEW_KEY)).update(`e164:${e164}`).digest();
   const open = (env, aad) => { const d = c.createDecipheriv("aes-256-gcm", Buffer.from(OLD_KEY, "base64"), env.subarray(1, 13));
     d.setAAD(Buffer.from(aad)); d.setAuthTag(env.subarray(13, 29)); return Buffer.concat([d.update(env.subarray(29)), d.final()]).toString("utf8"); };
   const seal = (text, aad) => { const iv = c.randomBytes(12); const e = c.createCipheriv("aes-256-gcm", Buffer.from(NEW_KEY, "base64"), iv);
     e.setAAD(Buffer.from(aad)); const ct = Buffer.concat([e.update(text, "utf8"), e.final()]); return Buffer.concat([Buffer.from([1]), iv, e.getAuthTag(), ct]); };
   const db = new pg.Client({ connectionString: DATABASE_OWNER_URL }); await db.connect(); await db.query("begin");
   for (const r of (await db.query("select id, user_id, number_ciphertext from do_not_call")).rows) {
     const aad = `dnc:${r.user_id}:${r.id}`; const n = open(r.number_ciphertext, aad);
     await db.query("update do_not_call set number_hash = $1, number_ciphertext = $2, number_key_id = $3 where id = $4", [hash(n), seal(n, aad), NEW_KEY_ID, r.id]); }
   for (const r of (await db.query("select id, callee_number from call_sessions")).rows)
     await db.query("update call_sessions set callee_number_hash = $1 where id = $2", [hash(r.callee_number), r.id]);
   // Verification codes are short-lived: expire the live ones (users start a new verification).
   await db.query("update phone_verifications set status = $1 where status in ($2, $3)", ["expired", "calling", "pending"]);
   await db.query("commit"); await db.end(); console.log("phone numbers re-hashed");'
   ```

   It is one transaction: on any error nothing changes (do not switch keys then). Check afterwards
   that `select count(*) from do_not_call where number_key_id <> 'k2'` is 0.

Emergency rotation (key leaked): same steps immediately; additionally rotate every SMTP password at
the providers, because a leaked key plus a database copy reveals them.

Planned: keyring with decrypt-by-key-id and a re-encryption job (no reconnects).

## Revoke sessions

- One device (user self-service): Settings → Sessions, or `DELETE /v1/auth/sessions/:id`.
- All sessions of a user (operator, owner role — bypasses RLS as table owner):
  ```sql
  update sessions set revoked_at = now() where user_id = '<user-uuid>' and revoked_at is null;
  ```
- Everyone (incident): `update sessions set revoked_at = now() where revoked_at is null;`
- Disable a user entirely: `update users set status = 'disabled' where id = '<user-uuid>';` —
  `auth_resolve_session` stops resolving that user's sessions immediately.

Revocation takes effect on the next request (sessions are resolved on every request); open SSE
streams end at the next reconnect at the latest — restart API processes to cut them immediately.

## Worker stuck or dead jobs

Signals: `GET /v1/assistant/status` → `worker.healthy` (heartbeat < 30 s), `GET /v1/admin/overview` →
`health.queueDepth`, tasks stuck in `QUEUED`/`PLANNING`/`RUNNING`.

```sql
-- workers and their last heartbeat
select worker_id, hostname, version, last_heartbeat_at from worker_heartbeats order by last_heartbeat_at desc;
-- queue by state
select kind, status, count(*) from jobs group by 1, 2 order by 1, 2;
-- oldest ready jobs
select id, kind, task_id, attempts, run_at, last_error from jobs where status = 'queued' order by run_at limit 20;
-- running jobs with expired leases (should be reclaimed within 15 s by a live worker)
select id, kind, locked_by, locked_until from jobs where status = 'running' and locked_until < now();
-- dead jobs
select id, kind, task_id, attempts, last_error, updated_at from jobs where status = 'dead' order by updated_at desc limit 20;
```

| Situation                                      | Action                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| No heartbeat                                   | Start/restart the worker; check logs (`"msg":"worker started"`, `lease failed`) and database connectivity                                          |
| Leases expired, nobody reclaims                | No live worker — reclaim runs inside workers; start one                                                                                            |
| Many `dead` jobs with the same `last_error`    | Bug or dependency outage; fix first. Affected tasks were failed with `INTERNAL` (retryable) by `onJobDead`                                         |
| Re-run a task after fixing                     | Prefer the user-facing retry (`POST /v1/tasks/:id/retry`), which re-queues safely and respects `OUTCOME_UNKNOWN`                                   |
| Re-queue a dead job manually (last resort)     | Only if no live job with the same `dedupe_key` exists: `update jobs set status='queued', attempts=0, run_at=now(), last_error=null where id=<id>;` |
| Task in `AWAITING_APPROVAL` with a past expiry | The `approval.expire` job retries up to 10 times; check it is not `dead`; a user decision after expiry also expires it                             |

Never mark a `tool_executions` row `succeeded` or delete it by hand: it is the duplicate-send guard.

## Incident response

| Severity | Examples                                                          | Response                                                                         |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| SEV1     | Data exposure across users, credential leak, unwanted emails sent | Immediate; stop the worker to halt side effects; revoke sessions; rotate secrets |
| SEV2     | API down, worker down > 15 min, all tasks failing                 | Within 1 hour                                                                    |
| SEV3     | Single feature degraded (model provider errors, one tool failing) | Next business day; offline mode keeps the core working                           |

Steps:

1. **Contain:** stop workers (`SIGTERM`) to halt side effects; if needed, revoke all sessions; disable
   the API key at the provider; take the web tier offline.
2. **Preserve evidence:** snapshot the database; export `audit_events` for the window
   (`select … from audit_events where created_at between …` as owner); keep logs.
3. **Eradicate and recover:** fix, rotate keys (`SECRET_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, DB
   passwords, SMTP passwords), redeploy, restart workers; verify with the vertical-slice checklist.
4. **Notify:** personal-data breach → supervisory authority within 72 hours (GDPR Art. 33) and affected
   users without undue delay when the risk is high (Art. 34).
5. **Review:** blameless post-incident review within 5 working days; update the
   [threat model](../security/threat-model.md).

## Backups and restore

- Managed PITR + daily snapshots, 30-day retention (to be configured with the provider).
- Weekly logical backup kept separately:
  `pg_dump --format=custom --no-owner --no-privileges "$DATABASE_OWNER_URL" > jarvis-<ts>.dump`.
- `SECRET_ENCRYPTION_KEY` is backed up in the secret manager, **separately** from database backups.
- Restore procedure: [data model §4](../architecture/data-model.md#4-backup-and-restore).
- Restore drill monthly into a scratch database (read-only smoke checks; never the integration test
  suite, which drops the schema).

## SLOs (proposal — not measured yet)

Milestone 1 has no metrics pipeline; logs are JSON lines (API via pino, worker via a JSON logger) and
tool latencies are aggregated from `tool_executions` (`GET /v1/admin/overview`). These targets become
active once metrics exist (private alpha gate).

| SLI                                                                  | Target (30-day window)                     | Measurement (planned)                |
| -------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| API availability (non-5xx share of requests, excluding `/v1/events`) | 99.5 %                                     | Load balancer logs                   |
| API latency, non-streaming endpoints (excluding model-bound work)    | p95 < 500 ms, p99 < 1.5 s                  | Request logs / OpenTelemetry         |
| Event delivery latency (commit → SSE frame)                          | p95 < 1 s                                  | Event timestamps vs. send time       |
| Worker freshness                                                     | Heartbeat age < 30 s for 99.9 % of minutes | `worker_heartbeats`                  |
| Queue wait (job `run_at` → lease)                                    | p95 < 5 s                                  | `jobs` timestamps                    |
| Time to plan (task created → `plan.ready`)                           | p95 < 20 s model mode, < 2 s offline       | `task_events`                        |
| Duplicate external side effects                                      | 0                                          | `tool_executions` audit              |
| `OUTCOME_UNKNOWN` share of email sends                               | < 0.5 %                                    | `tool_executions.status = 'unknown'` |

Error budget policy (proposal): when a month's budget is spent, feature work pauses for reliability
work until the SLO recovers.
