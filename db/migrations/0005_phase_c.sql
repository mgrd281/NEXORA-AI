-- 0005: Phase C — OAuth connections (Google, Microsoft), the email agent, calendars,
-- the isolated browser agent, booking and shopping. Design: docs/architecture/phase-c.md,
-- ADRs 0016 (OAuth), 0017 (browser isolation), 0018 (commerce safety).
--
--  1. connections: providers google / microsoft; the capabilities JARVIS may use and the
--     scopes the provider granted; why a connection is not active; the provider account id
--     (reconnecting must keep the same account); access-token expiry (not secret). Tokens
--     stay in connections.secret_ciphertext as one SecretBox envelope
--     (AAD oauth:<user id>:<provider>:<connection id>) — no second copy anywhere.
--  2. oauth_states: one row per authorization request — bound to the user AND the session
--     that started it, single use, short-lived; stores only a hash of `state` and the PKCE
--     verifier sealed with SecretBox.
--  3. oauth_revocations: an outbox filled by a trigger whenever a Google connection row with
--     tokens is deleted (disconnect, account or tenant deletion), drained by the worker
--     through SECURITY DEFINER functions (the provider's revoke endpoint). Microsoft has no
--     per-app revocation endpoint: its tokens are erased with the row (docs/adr/0016).
--  4. email_watches: threads watched for replies (polled by the worker).
--  5. browser_sessions (created in 0001, never written) becomes the browser agent's
--     lifecycle record; evidence_artifacts holds its evidence files (object storage,
--     queued for deletion by the same trigger as attachments).
--  6. orders and bookings: exactly-once records (unique idempotency key per user) of what
--     the agent submitted; committed_purchases (security_invoker view) feeds the policy's
--     monthly purchase limit.
--  7. New notification kinds, job kinds, worker heartbeat kinds; RLS on every new table;
--     grants; the narrow cross-tenant functions the worker needs.
-- No calendar or mail content is cached in the database (docs/architecture/phase-c.md §3.3).

-- ---------------------------------------------------------------------------
-- 1. Connections
-- ---------------------------------------------------------------------------

ALTER TABLE connections DROP CONSTRAINT connections_provider_check;
ALTER TABLE connections
  ADD CONSTRAINT connections_provider_check
    CHECK (provider IN ('web', 'smtp', 'google', 'microsoft')),
  -- contracts ConnectionCapability; only OAuth connections have any.
  ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}'
    CHECK (capabilities <@ ARRAY['mail.read', 'mail.compose', 'mail.send',
                                 'calendar.read', 'calendar.write']::text[]),
  -- The scopes the provider reported as granted (informational; capabilities decide).
  ADD COLUMN granted_scopes text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(granted_scopes) <= 32),
  -- contracts ConnectionStatusReason: why it is not active.
  ADD COLUMN status_reason text
    CHECK (status_reason IN ('GRANT_INVALID', 'TOKEN_REJECTED', 'SCOPE_MISSING', 'PROVIDER_ERROR')),
  -- Google `sub` / Microsoft object id: a reconnect must sign in to the same account.
  ADD COLUMN provider_account_id text CHECK (length(provider_account_id) BETWEEN 1 AND 255),
  -- When the current access token expires (refresh before it; not a secret).
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN token_refreshed_at timestamptz,
  ADD CONSTRAINT connections_oauth_fields CHECK (
    provider IN ('google', 'microsoft')
    OR (capabilities = '{}' AND granted_scopes = '{}' AND provider_account_id IS NULL
        AND token_expires_at IS NULL)),
  -- An active OAuth connection always has its tokens and its account.
  ADD CONSTRAINT connections_oauth_active CHECK (
    provider NOT IN ('google', 'microsoft') OR status <> 'active'
    OR (secret_ciphertext IS NOT NULL AND provider_account_id IS NOT NULL)),
  -- A reason only while not active (SCOPE_MISSING may stay on an active connection that lost one).
  ADD CONSTRAINT connections_status_reason CHECK (
    status_reason IS NULL OR status <> 'active' OR status_reason = 'SCOPE_MISSING');

-- ---------------------------------------------------------------------------
-- 2. OAuth authorization requests
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_states (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The session that started it; only that session can complete it (login-CSRF defence).
  -- Revoking or deleting the session discards it.
  session_id                  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider                    text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  capabilities                text[] NOT NULL
                                CHECK (cardinality(capabilities) BETWEEN 1 AND 5
                                       AND capabilities <@ ARRAY['mail.read', 'mail.compose',
                                         'mail.send', 'calendar.read', 'calendar.write']::text[]),
  -- The exact scopes requested (identity + the capabilities').
  requested_scopes            text[] NOT NULL CHECK (cardinality(requested_scopes) BETWEEN 1 AND 32),
  -- SHA-256 of the `state` parameter; the state itself is never stored.
  state_hash                  bytea NOT NULL UNIQUE CHECK (length(state_hash) = 32),
  -- PKCE code_verifier, SecretBox envelope (AAD oauth-state:<user id>:<id>).
  code_verifier_ciphertext    bytea NOT NULL,
  code_verifier_key_id        text NOT NULL,
  -- Exactly one of the server's allowed redirect URIs; sent again at the token exchange.
  redirect_uri                text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  -- Reconnect / add capabilities to this connection (same provider account).
  connection_id               uuid REFERENCES connections(id) ON DELETE CASCADE,
  -- contracts OAuthStartRequest.returnTo: a path of the client app.
  return_to                   text CHECK (length(return_to) BETWEEN 1 AND 512 AND return_to ~ '^/[^/\\]'
                                          OR return_to = '/'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  -- contracts OAUTH_LIMITS.stateTtlMinutes (10); never longer than 15 minutes.
  expires_at                  timestamptz NOT NULL,
  -- Set when the callback used it (single use: UPDATE … WHERE consumed_at IS NULL).
  consumed_at                 timestamptz,
  CONSTRAINT oauth_states_short_lived CHECK (expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX oauth_states_user_idx ON oauth_states (user_id, created_at DESC);
CREATE INDEX oauth_states_tenant_idx ON oauth_states (tenant_id);
CREATE INDEX oauth_states_session_idx ON oauth_states (session_id);
CREATE INDEX oauth_states_connection_idx ON oauth_states (connection_id);
CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- 3. Token revocation outbox (Google)
-- ---------------------------------------------------------------------------

-- RLS on, no policy, no table grants: jarvis_app reaches it only through the functions
-- below. No foreign keys: rows outlive the connection, user and tenant they came from.
-- The envelope is the connection's own (AAD oauth:<user id>:<provider>:<connection id>).
CREATE TABLE oauth_revocations (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL CHECK (provider IN ('google')),
  tenant_id          uuid NOT NULL,
  user_id            uuid NOT NULL,
  connection_id      uuid NOT NULL,
  token_ciphertext   bytea NOT NULL,
  token_key_id       text NOT NULL,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  not_before         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_revocations_due_idx ON oauth_revocations (not_before, id);
ALTER TABLE oauth_revocations ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION connections_queue_revocation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.provider = 'google' AND OLD.secret_ciphertext IS NOT NULL THEN
    INSERT INTO oauth_revocations (provider, tenant_id, user_id, connection_id,
                                   token_ciphertext, token_key_id)
    VALUES (OLD.provider, OLD.tenant_id, OLD.user_id, OLD.id,
            OLD.secret_ciphertext, COALESCE(OLD.secret_key_id, ''));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER connections_revocation
  AFTER DELETE ON connections
  FOR EACH ROW EXECUTE FUNCTION connections_queue_revocation();

-- Leases up to p_limit due revocations (due again after the lease, so a crashed
-- worker's batch is retried). Returns what is needed to revoke them.
CREATE FUNCTION oauth_revocations_claim(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (id bigint, provider text, user_id uuid, connection_id uuid,
                 token_ciphertext bytea, token_key_id text, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE oauth_revocations r
       SET attempts = r.attempts + 1,
           not_before = now() + make_interval(secs => GREATEST(p_lease_seconds, 30))
     WHERE r.id IN (
       SELECT o.id FROM oauth_revocations o
        WHERE o.not_before <= now()
        ORDER BY o.not_before, o.id
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
        FOR UPDATE SKIP LOCKED)
    RETURNING r.id, r.provider, r.user_id, r.connection_id, r.token_ciphertext,
              r.token_key_id, r.attempts
  $$;

-- Revoked (or the provider says the token is already invalid): forget the envelope.
CREATE FUNCTION oauth_revocations_complete(p_ids bigint[]) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH gone AS (DELETE FROM oauth_revocations r WHERE r.id = ANY (p_ids) RETURNING 1)
    SELECT count(*)::integer FROM gone
  $$;

-- A revocation failed: retry with exponential backoff (2^attempts minutes, at most a day).
CREATE FUNCTION oauth_revocations_failed(p_id bigint, p_error text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE oauth_revocations r
       SET last_error = left(p_error, 500),
           not_before = now() + LEAST(interval '1 day',
                                      make_interval(mins => power(2, LEAST(r.attempts, 11))::integer))
     WHERE r.id = p_id
  $$;

-- Expired or used authorization requests, across tenants (the worker's cleanup). Count only.
CREATE FUNCTION oauth_states_purge() RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH gone AS (
      DELETE FROM oauth_states s
       WHERE s.expires_at < now() - interval '1 hour'
          OR s.consumed_at < now() - interval '1 hour'
      RETURNING 1)
    SELECT count(*)::integer FROM gone
  $$;

-- ---------------------------------------------------------------------------
-- 4. Email reply tracking
-- ---------------------------------------------------------------------------

CREATE TABLE email_watches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Disconnecting the account ends its watches.
  connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  -- The provider's thread id (Gmail threadId / Graph conversationId).
  thread_id           text NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 512),
  -- As the provider reports it (untrusted text, for the list and the notification).
  subject             text NOT NULL CHECK (length(subject) <= 300),
  -- The task whose email.track_replies step created it (once per step: see the unique index).
  task_id             uuid REFERENCES tasks(id) ON DELETE SET NULL,
  step_id             uuid REFERENCES task_steps(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'watching'
                        CHECK (status IN ('watching', 'replied', 'stopped', 'expired', 'failed')),
  -- The newest message already seen (replies are messages after it, from someone else).
  last_seen_message_id text CHECK (length(last_seen_message_id) <= 512),
  last_seen_at        timestamptz,
  last_checked_at     timestamptz,
  next_check_at       timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  reply_message_id    text CHECK (length(reply_message_id) <= 512),
  reply_from_name     text CHECK (length(reply_from_name) <= 200),
  reply_from_address  text CHECK (length(reply_from_address) <= 320),
  reply_at            timestamptz,
  -- contracts EMAIL_LIMITS.watchMaxDays (30).
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_watches_next_check CHECK ((status = 'watching') = (next_check_at IS NOT NULL)),
  CONSTRAINT email_watches_reply CHECK ((status = 'replied') = (reply_at IS NOT NULL)),
  CONSTRAINT email_watches_bounded CHECK (expires_at <= created_at + interval '31 days')
);
-- One live watch per thread and account.
CREATE UNIQUE INDEX email_watches_one_live ON email_watches (connection_id, thread_id)
  WHERE status = 'watching';
-- Exactly once per tool step (the arbiter of email.track_replies' insert; NULLs are distinct).
CREATE UNIQUE INDEX email_watches_once_per_step ON email_watches (step_id);
CREATE INDEX email_watches_due_idx ON email_watches (next_check_at) WHERE status = 'watching';
CREATE INDEX email_watches_user_idx ON email_watches (user_id, created_at DESC);
CREATE INDEX email_watches_tenant_idx ON email_watches (tenant_id);
CREATE INDEX email_watches_connection_idx ON email_watches (connection_id);
CREATE INDEX email_watches_task_idx ON email_watches (task_id);

-- Watches due a check, across tenants (the worker then polls each in its owner's
-- RLS context). Ids only.
CREATE FUNCTION email_watches_due(p_limit integer)
  RETURNS TABLE (watch_id uuid, tenant_id uuid, user_id uuid, next_check_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT w.id, w.tenant_id, w.user_id, w.next_check_at
      FROM email_watches w JOIN users u ON u.id = w.user_id
     WHERE w.status = 'watching' AND w.next_check_at <= now() AND u.status = 'active'
     ORDER BY w.next_check_at, w.id
     LIMIT LEAST(GREATEST(p_limit, 1), 500)
  $$;

-- ---------------------------------------------------------------------------
-- 5. Browser sessions and evidence files
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM browser_sessions) THEN
    RAISE EXCEPTION '0005 expects browser_sessions to be empty (no release wrote it)';
  END IF;
END $$;

ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_status_check;
ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_task_id_fkey;
ALTER TABLE browser_sessions
  ALTER COLUMN task_id SET NOT NULL,
  -- A session belongs to its task: retention and deletion of the task remove it (and,
  -- through evidence_artifacts, its files).
  ADD CONSTRAINT browser_sessions_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  ALTER COLUMN started_at DROP NOT NULL,
  ALTER COLUMN started_at DROP DEFAULT,
  ADD CONSTRAINT browser_sessions_status_check CHECK (status IN
    ('queued', 'running', 'succeeded', 'failed', 'handover', 'interrupted')),
  ADD CONSTRAINT browser_sessions_isolation CHECK (isolation_profile = 'ephemeral'),
  ADD COLUMN step_id uuid NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  -- The recipe (supported site) and its operation, e.g. 'fixture-shop' / 'checkout'.
  ADD COLUMN site_id text NOT NULL CHECK (site_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  ADD COLUMN operation text NOT NULL CHECK (operation ~ '^[a-z][a-z_]{0,31}$'),
  -- The tool execution's idempotency key (+ attempt): one session per execution attempt.
  ADD COLUMN idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  -- The recipe input (validated by the recipe's schema; no secrets).
  ADD COLUMN request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  -- The recipe output once succeeded (validated by the recipe's schema).
  ADD COLUMN result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  -- contracts BrowserStopReason.
  ADD COLUMN stop_reason text CHECK (stop_reason IN (
    'CAPTCHA_DETECTED', 'LOGIN_REQUIRED', 'BOT_PROTECTION', 'SITE_UNSUPPORTED',
    'NAVIGATION_BLOCKED', 'PAGE_CHANGED', 'SITE_ERROR', 'BROWSER_BUDGET_EXCEEDED',
    'BROWSER_TIMEOUT', 'BROWSER_CRASHED', 'CANCELLED')),
  -- Where the user can continue themselves (handover).
  ADD COLUMN handover_url text CHECK (length(handover_url) <= 2048),
  ADD COLUMN navigations integer NOT NULL DEFAULT 0 CHECK (navigations >= 0),
  ADD COLUMN requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  ADD COLUMN blocked_requests integer NOT NULL DEFAULT 0 CHECK (blocked_requests >= 0),
  -- The browser worker holding it (diagnostics only; the job lease is authoritative).
  ADD COLUMN worker_id text,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT browser_sessions_once_per_key UNIQUE (user_id, idempotency_key),
  ADD CONSTRAINT browser_sessions_ended CHECK (
    (status IN ('queued', 'running')) = (ended_at IS NULL)),
  -- failed and handover say why; interrupted may (CANCELLED) or may not; the others never.
  ADD CONSTRAINT browser_sessions_stop_reason CHECK (
    (status IN ('failed', 'handover') AND stop_reason IS NOT NULL)
    OR status = 'interrupted'
    OR (status IN ('queued', 'running', 'succeeded') AND stop_reason IS NULL)),
  ADD CONSTRAINT browser_sessions_handover CHECK ((status = 'handover') = (handover_url IS NOT NULL)),
  ADD CONSTRAINT browser_sessions_result CHECK (status <> 'succeeded' OR result IS NOT NULL);
CREATE INDEX browser_sessions_step_idx ON browser_sessions (step_id);
CREATE INDEX browser_sessions_live_idx ON browser_sessions (user_id, status)
  WHERE status IN ('queued', 'running');

CREATE TABLE evidence_artifacts (
  -- Generate it before the insert: storage_key must be built from it (CHECK).
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id             uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  browser_session_id  uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('screenshot', 'extract', 'ics')),
  media_type          text NOT NULL CHECK (media_type IN ('image/png', 'application/json', 'text/calendar')),
  -- contracts BROWSER_LIMITS (screenshot 2 MiB, extract 256 KiB, ICS 64 KiB).
  size_bytes          integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_driver      text NOT NULL CHECK (storage_driver IN ('local', 's3')),
  storage_key         text NOT NULL UNIQUE,
  page_url            text CHECK (length(page_url) <= 2048),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_artifacts_media_type CHECK (
    (kind = 'screenshot' AND media_type = 'image/png')
    OR (kind = 'extract' AND media_type = 'application/json')
    OR (kind = 'ics' AND media_type = 'text/calendar')),
  -- Per-tenant key prefix, fixed (as attachments).
  CONSTRAINT evidence_artifacts_storage_key_format CHECK (
    storage_key = 'tenants/' || tenant_id::text || '/users/' || user_id::text
                  || '/evidence/' || id::text)
);
CREATE INDEX evidence_artifacts_session_idx ON evidence_artifacts (browser_session_id);
CREATE INDEX evidence_artifacts_task_idx ON evidence_artifacts (task_id);
CREATE INDEX evidence_artifacts_user_idx ON evidence_artifacts (user_id, created_at DESC);
CREATE INDEX evidence_artifacts_tenant_idx ON evidence_artifacts (tenant_id);

-- Deleting a row (directly or by cascade) queues the stored object, exactly as for
-- attachments: the trigger function reads OLD.storage_driver / storage_key / tenant_id.
CREATE TRIGGER evidence_artifacts_storage_deletion
  AFTER DELETE ON evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION attachments_queue_storage_deletion();

-- ---------------------------------------------------------------------------
-- 6. Orders and bookings (exactly once), purchase spend
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Orders outlive task history (financial record); their evidence follows the task.
  task_id                   uuid REFERENCES tasks(id) ON DELETE SET NULL,
  step_id                   uuid REFERENCES task_steps(id) ON DELETE SET NULL,
  site_id                   text NOT NULL CHECK (site_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  merchant_name             text NOT NULL CHECK (length(merchant_name) BETWEEN 1 AND 200),
  merchant_host             text NOT NULL CHECK (length(merchant_host) BETWEEN 1 AND 255),
  -- Derived from the step (stable across acknowledged retries) and sent to the merchant:
  -- the database and the merchant both refuse a second order for it.
  idempotency_key           text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  status                    text NOT NULL DEFAULT 'submitting'
                              CHECK (status IN ('submitting', 'placed', 'failed', 'unknown')),
  -- contracts CartLine[] as approved.
  items                     jsonb NOT NULL
                              CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 10),
  currency                  text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_micro            bigint NOT NULL CHECK (subtotal_micro >= 0),
  shipping_micro            bigint NOT NULL CHECK (shipping_micro >= 0),
  tax_micro                 bigint CHECK (tax_micro >= 0),
  total_micro               bigint NOT NULL CHECK (total_micro >= 0),
  merchant_order_id         text CHECK (length(merchant_order_id) BETWEEN 1 AND 200),
  placed_at                 timestamptz,
  -- contracts TaskErrorReason (failed / unknown).
  failure_reason            text CHECK (length(failure_reason) BETWEEN 1 AND 64),
  -- The approval that authorised exactly this order, and its action hash (audit trail).
  approval_id               uuid REFERENCES approvals(id) ON DELETE SET NULL,
  action_hash               text NOT NULL CHECK (length(action_hash) BETWEEN 16 AND 128),
  cart_artifact_id          uuid REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  confirmation_artifact_id  uuid REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_once_per_key UNIQUE (user_id, idempotency_key),
  CONSTRAINT orders_placed CHECK (
    (status = 'placed') = (merchant_order_id IS NOT NULL AND placed_at IS NOT NULL)),
  CONSTRAINT orders_failure_reason CHECK (
    (status IN ('failed', 'unknown')) = (failure_reason IS NOT NULL))
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC, id DESC);
CREATE INDEX orders_tenant_idx ON orders (tenant_id);
CREATE INDEX orders_task_idx ON orders (task_id);
CREATE INDEX orders_step_idx ON orders (step_id);
CREATE INDEX orders_approval_idx ON orders (approval_id);
CREATE INDEX orders_cart_artifact_idx ON orders (cart_artifact_id);
CREATE INDEX orders_confirmation_artifact_idx ON orders (confirmation_artifact_id);

CREATE TABLE bookings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id                   uuid REFERENCES tasks(id) ON DELETE SET NULL,
  step_id                   uuid REFERENCES task_steps(id) ON DELETE SET NULL,
  site_id                   text NOT NULL CHECK (site_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  site_name                 text NOT NULL CHECK (length(site_name) BETWEEN 1 AND 200),
  site_host                 text NOT NULL CHECK (length(site_host) BETWEEN 1 AND 255),
  service                   text NOT NULL CHECK (length(service) BETWEEN 1 AND 300),
  idempotency_key           text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  status                    text NOT NULL DEFAULT 'submitting'
                              CHECK (status IN ('submitting', 'confirmed', 'failed', 'unknown', 'cancelled')),
  slot_start                timestamptz NOT NULL,
  slot_end                  timestamptz,
  time_zone                 text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  -- The site's confirmation reference (confirmed only).
  reference                 text CHECK (length(reference) BETWEEN 1 AND 200),
  price_micro               bigint CHECK (price_micro >= 0),
  price_currency            text CHECK (price_currency ~ '^[A-Z]{3}$'),
  binding                   boolean NOT NULL,
  -- The calendar entry made for it afterwards (calendar.create_event), if any.
  calendar_event_id         text CHECK (length(calendar_event_id) BETWEEN 1 AND 1024),
  failure_reason            text CHECK (length(failure_reason) BETWEEN 1 AND 64),
  approval_id               uuid REFERENCES approvals(id) ON DELETE SET NULL,
  action_hash               text NOT NULL CHECK (length(action_hash) BETWEEN 16 AND 128),
  slots_artifact_id         uuid REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  confirmation_artifact_id  uuid REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  ics_artifact_id           uuid REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_once_per_key UNIQUE (user_id, idempotency_key),
  CONSTRAINT bookings_slot CHECK (slot_end IS NULL OR slot_end > slot_start),
  CONSTRAINT bookings_price CHECK ((price_micro IS NULL) = (price_currency IS NULL)),
  CONSTRAINT bookings_confirmed CHECK (status <> 'confirmed' OR reference IS NOT NULL),
  CONSTRAINT bookings_failure_reason CHECK (
    (status IN ('failed', 'unknown')) = (failure_reason IS NOT NULL))
);
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC, id DESC);
CREATE INDEX bookings_tenant_idx ON bookings (tenant_id);
CREATE INDEX bookings_task_idx ON bookings (task_id);
CREATE INDEX bookings_step_idx ON bookings (step_id);
CREATE INDEX bookings_approval_idx ON bookings (approval_id);
CREATE INDEX bookings_slots_artifact_idx ON bookings (slots_artifact_id);
CREATE INDEX bookings_confirmation_artifact_idx ON bookings (confirmation_artifact_id);
CREATE INDEX bookings_ics_artifact_idx ON bookings (ics_artifact_id);

-- Money that is, or may be, committed: placed orders, orders being submitted and
-- orders whose outcome is unknown (conservative: an unknown order may have gone
-- through). security_invoker: the caller's RLS applies, so it sums the caller's own.
-- The policy sums it per currency since the start of the account's calendar month.
CREATE VIEW committed_purchases WITH (security_invoker = true) AS
  SELECT o.user_id, o.currency, o.total_micro, o.created_at, o.status
    FROM orders o
   WHERE o.status IN ('submitting', 'placed', 'unknown');

-- ---------------------------------------------------------------------------
-- 7. Enumerations shared with the contracts, heartbeats
-- ---------------------------------------------------------------------------

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'approval_requested', 'task_completed', 'task_failed', 'connection_error',
  'schedule_failed', 'schedule_paused', 'webhook_disabled',
  'connection_expired', 'email_reply_received'));

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'task.plan', 'task.execute', 'approval.expire',
  'schedule.run', 'retention.sweep', 'webhook.deliver',
  'email.watch_poll', 'browser.session'));
-- The browser worker leases only browser.* jobs, the agent worker everything else.
CREATE INDEX jobs_ready_kind_idx ON jobs (kind, run_at) WHERE status = 'queued';

-- Agent workers and browser workers report health separately (AssistantStatus.worker
-- is the agent workers'; capabilities.browser needs a live browser worker).
ALTER TABLE worker_heartbeats
  ADD COLUMN kind text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'browser'));

UPDATE feature_flags
   SET description = 'Unused since Phase C: the browser agent runs where a browser worker runs (docs/adr/0017).'
 WHERE key = 'browser_agent';

-- ---------------------------------------------------------------------------
-- 8. updated_at, Row-Level Security, cross-tenant functions, grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_watches', 'browser_sessions', 'orders', 'bookings']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- User-private tables: tenant AND user must match (as in 0001). browser_sessions
-- already has its policy (0001).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['oauth_states', 'email_watches', 'evidence_artifacts', 'orders', 'bookings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant() AND user_id = app_current_user()) '
      'WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user())',
      t || '_owner', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION email_watches_due(integer), oauth_revocations_claim(integer, integer),
  oauth_revocations_complete(bigint[]), oauth_revocations_failed(bigint, text),
  oauth_states_purge(), connections_queue_revocation() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  oauth_states, email_watches, evidence_artifacts, orders, bookings
  TO jarvis_app;
GRANT SELECT ON committed_purchases TO jarvis_app;
-- oauth_revocations: no table privileges; only through these functions.
GRANT EXECUTE ON FUNCTION email_watches_due(integer), oauth_revocations_claim(integer, integer),
  oauth_revocations_complete(bigint[]), oauth_revocations_failed(bigint, text),
  oauth_states_purge() TO jarvis_app;
