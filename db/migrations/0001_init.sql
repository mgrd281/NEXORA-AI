-- JARVIS — initial schema
--
-- Security model
--   * Migrations run as the schema owner role (jarvis_owner).
--   * The API and worker connect as jarvis_app, which is NOT the table owner,
--     so Row-Level Security always applies to it.
--   * Every request/job runs inside a transaction that sets
--       app.tenant_id and app.user_id   (set_config(..., true) — transaction-local)
--     Tenant tables require tenant_id = app.tenant_id; user-private tables
--     additionally require user_id = app.user_id. Without context: zero rows.
--   * The few cross-tenant operations (login lookup, session resolution,
--     admin aggregates) are narrow SECURITY DEFINER functions defined below.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           citext NOT NULL UNIQUE CHECK (length(email) <= 254),
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash   text NOT NULL,
  locale          text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'de', 'ar')),
  time_zone       text NOT NULL DEFAULT 'UTC',
  theme           text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  preferences     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz
);
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE user_roles (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'member', 'platform_admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  text,
  platform              text NOT NULL CHECK (platform IN ('web', 'ios', 'android', 'macos')),
  push_token_ciphertext bytea,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);
CREATE INDEX devices_user_idx ON devices (user_id);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- SHA-256 of the opaque bearer token; the token itself is never stored.
  token_hash    bytea NOT NULL UNIQUE,
  platform      text NOT NULL CHECK (platform IN ('web', 'ios', 'android', 'macos')),
  device_name   text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Conversations & tasks
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id       uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  request               text NOT NULL CHECK (length(request) BETWEEN 1 AND 4000),
  objective             text,
  status                text NOT NULL DEFAULT 'QUEUED' CHECK (status IN
                          ('QUEUED','PLANNING','AWAITING_APPROVAL','RUNNING','VERIFYING',
                           'COMPLETED','FAILED','CANCELLED','EXPIRED')),
  risk_level            text NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  source                text NOT NULL CHECK (source IN ('text','voice','schedule','api')),
  language              text,
  planner               jsonb,
  answer                text,
  result_summary        text,
  evidence              jsonb NOT NULL DEFAULT '[]'::jsonb,
  error                 jsonb,
  estimated_cost_micro  bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_micro >= 0),
  actual_cost_micro     bigint NOT NULL DEFAULT 0 CHECK (actual_cost_micro >= 0),
  attempt               integer NOT NULL DEFAULT 1,
  cancel_requested_at   timestamptz,
  version               integer NOT NULL DEFAULT 0,
  idempotency_key       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz
);
CREATE INDEX tasks_user_status_idx ON tasks (user_id, status, updated_at DESC);
CREATE INDEX tasks_user_created_idx ON tasks (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX tasks_idempotency_idx ON tasks (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  task_id          uuid REFERENCES tasks(id) ON DELETE SET NULL,
  role             text NOT NULL CHECK (role IN ('user','assistant','system')),
  content          text NOT NULL,
  language         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE task_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position >= 0),
  -- Planner-assigned key used for references between steps, e.g. {{s1.text}}.
  step_key         text NOT NULL,
  title            text NOT NULL,
  tool_id          text NOT NULL,
  input            jsonb NOT NULL,           -- as planned (may contain {{refs}})
  resolved_input   jsonb,                    -- exact input executed (after refs)
  input_preview    jsonb NOT NULL DEFAULT '{}'::jsonb,
  output           jsonb,
  output_preview   jsonb,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN
                     ('PENDING','AWAITING_APPROVAL','RUNNING','SUCCEEDED','FAILED','SKIPPED','CANCELLED','BLOCKED')),
  risk_level       text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  requires_approval boolean NOT NULL DEFAULT false,
  policy           jsonb NOT NULL DEFAULT '{"decision":"allow","reasons":[]}'::jsonb,
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts         integer NOT NULL DEFAULT 0,
  error            jsonb,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, position),
  UNIQUE (task_id, step_key)
);

-- One row per side-effect attempt. The unique idempotency key is what makes
-- "no duplicate email / purchase / booking on retry" a database guarantee.
CREATE TABLE tool_executions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id          uuid NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  tool_id          text NOT NULL,
  tool_version     text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('started','succeeded','failed','unknown')),
  input_hash       text NOT NULL,
  output           jsonb,
  error            jsonb,
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_micro       bigint NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  duration_ms      integer
);
CREATE INDEX tool_executions_task_idx ON tool_executions (task_id);
CREATE INDEX tool_executions_tool_time_idx ON tool_executions (tool_id, started_at DESC);

CREATE TABLE approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id          uuid NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  tool_id          text NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN
                     ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED','SUPERSEDED')),
  risk_level       text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  summary          text NOT NULL,
  details          jsonb NOT NULL,
  -- SHA-256 over the canonical resolved input: approval is bound to exactly what was shown.
  action_hash      text NOT NULL,
  reasons          text[] NOT NULL DEFAULT '{}',
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz,
  decision_note    text,
  decision_channel text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approvals_one_pending_per_step ON approvals (step_id) WHERE status = 'PENDING';
CREATE INDEX approvals_user_pending_idx ON approvals (user_id, created_at DESC) WHERE status = 'PENDING';
CREATE INDEX approvals_task_idx ON approvals (task_id);

-- Append-only execution history; also the replay log for the SSE stream.
CREATE TABLE task_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES tasks(id) ON DELETE CASCADE,
  type        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_user_idx ON task_events (user_id, id);
CREATE INDEX task_events_task_idx ON task_events (task_id, id);

-- ---------------------------------------------------------------------------
-- Connections, memory, notifications, voice
-- ---------------------------------------------------------------------------

CREATE TABLE connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('web','smtp')),
  label               text NOT NULL,
  account_identifier  text,
  permissions         text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL CHECK (status IN ('active','error','expired','revoked')),
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret settings only
  secret_ciphertext   bytea,                                -- AES-256-GCM envelope
  secret_key_id       text,
  last_verified_at    timestamptz,
  last_error          text,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connections_one_per_provider ON connections (user_id, provider) WHERE status <> 'revoked';

CREATE TABLE memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('preference','fact')),
  content         text NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
  source          text NOT NULL CHECK (source IN ('user','assistant')),
  source_task_id  uuid REFERENCES tasks(id) ON DELETE SET NULL,
  -- 'simple' config: language-agnostic tokenisation for en/de/ar. Semantic
  -- (pgvector) retrieval is a planned migration; see docs/adr/0006.
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_user_idx ON memories (user_id, updated_at DESC);
CREATE INDEX memories_search_idx ON memories USING gin (search);
CREATE INDEX memories_trgm_idx ON memories USING gin (content gin_trgm_ops);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('approval_requested','task_completed','task_failed','connection_error')),
  task_id     uuid REFERENCES tasks(id) ON DELETE CASCADE,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC, id DESC);

CREATE TABLE voice_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  locale            text NOT NULL,
  engine            text NOT NULL CHECK (engine IN ('browser_speech','ios_speech','android_speech')),
  outcome           text CHECK (outcome IN ('submitted','cancelled','error','no_speech')),
  transcript_chars  integer,
  error_code        text,
  task_id           uuid REFERENCES tasks(id) ON DELETE SET NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

-- Phase 5 (telephony). Created now so the data model is complete; unused in this build.
CREATE TABLE call_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id                 uuid REFERENCES tasks(id) ON DELETE SET NULL,
  callee_label            text,
  callee_number_ciphertext bytea,
  language                text,
  status                  text NOT NULL CHECK (status IN ('scheduled','dialing','in_progress','completed','failed','cancelled')),
  ai_disclosed            boolean NOT NULL DEFAULT false,
  recording_consent       boolean NOT NULL DEFAULT false,
  outcome                 jsonb,
  started_at              timestamptz,
  ended_at                timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Phase 4 (browser agent). Created now; unused in this build.
CREATE TABLE browser_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id           uuid REFERENCES tasks(id) ON DELETE SET NULL,
  status            text NOT NULL CHECK (status IN ('starting','active','closed','failed')),
  isolation_profile text NOT NULL DEFAULT 'ephemeral',
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

CREATE TABLE scheduled_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  request         text NOT NULL,
  rrule           text NOT NULL,
  time_zone       text NOT NULL,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Metering, billing, audit
-- ---------------------------------------------------------------------------

CREATE TABLE usage_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id        uuid REFERENCES tasks(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('model_tokens','tool_call')),
  provider       text,
  model          text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  quantity       integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_user_time_idx ON usage_events (user_id, created_at DESC);

CREATE TABLE cost_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  usage_event_id  uuid REFERENCES usage_events(id) ON DELETE SET NULL,
  category        text NOT NULL CHECK (category IN ('model','tool','telephony')),
  amount_micro    bigint NOT NULL CHECK (amount_micro >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_records_user_time_idx ON cost_records (user_id, created_at DESC);

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan                  text NOT NULL DEFAULT 'private_alpha',
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing','active','past_due','cancelled')),
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  provider              text,
  provider_ref          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Append-only. No foreign keys, so audit history survives tenant/user deletion;
-- once the user row is gone the actor id is an unlinkable pseudonym. Metadata
-- must never contain message content or secrets (enforced in application code).
CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  actor_type   text NOT NULL CHECK (actor_type IN ('user','system','agent','admin')),
  actor_id     uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_time_idx ON audit_events (created_at DESC, id DESC);

CREATE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Durable execution (Postgres-backed job queue; see docs/adr/0004)
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('task.plan','task.execute','approval.expire')),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  task_id       uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
  -- At most one live job per dedupe key (e.g. one execute job per task).
  dedupe_key    text,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  locked_by     text,
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_until) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_dedupe_live_idx ON jobs (dedupe_key) WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL;

CREATE TABLE worker_heartbeats (
  worker_id          text PRIMARY KEY,
  hostname           text,
  version            text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  key          text PRIMARY KEY,
  description  text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT false,
  rules        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO feature_flags (key, description, enabled) VALUES
  ('public_registration', 'Allow self-service sign-up. Off until security & ops readiness criteria are met.', false),
  ('telephony', 'Phase 5 outbound calls.', false),
  ('browser_agent', 'Phase 4 isolated browser automation.', false);

CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route            text NOT NULL,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash     text NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, route, key)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','conversations','tasks','task_steps','approvals',
                           'connections','memories','scheduled_tasks','subscriptions','jobs']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant ON subscriptions
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- User-private tables: tenant AND user must match.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_roles','devices','sessions','conversations','tasks','messages',
                           'task_steps','tool_executions','approvals','task_events','connections',
                           'memories','notifications','voice_sessions','call_sessions',
                           'browser_sessions','scheduled_tasks','usage_events','cost_records',
                           'idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant() AND user_id = app_current_user()) '
      'WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user())',
      t || '_owner', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Narrow cross-tenant functions (SECURITY DEFINER, fixed search_path)
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth_find_login(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.status FROM users u WHERE u.email = p_email::citext
  $$;

CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, user_id uuid, tenant_id uuid, expires_at timestamptz, platform text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.id, s.user_id, s.tenant_id, s.expires_at, s.platform
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'active'
  $$;

CREATE FUNCTION admin_overview() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_object(
      'users_total', (SELECT count(*) FROM users),
      'users_active_7d', (SELECT count(*) FROM users WHERE last_active_at > now() - interval '7 days'),
      'tenants_total', (SELECT count(*) FROM tenants),
      'tasks_by_status', COALESCE((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM tasks GROUP BY status) s), '{}'::jsonb),
      'queue_depth', (SELECT count(*) FROM jobs WHERE status = 'queued'),
      'cost_30d_micro', (SELECT COALESCE(sum(amount_micro), 0) FROM cost_records WHERE created_at > now() - interval '30 days'),
      'tool_reliability', COALESCE((
        SELECT jsonb_agg(r ORDER BY r->>'tool_id') FROM (
          SELECT jsonb_build_object(
            'tool_id', tool_id,
            'executions', count(*),
            'succeeded', count(*) FILTER (WHERE status = 'succeeded'),
            'failed', count(*) FILTER (WHERE status IN ('failed','unknown')),
            'p50_ms', percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL),
            'p95_ms', percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL)
          ) r
          FROM tool_executions WHERE started_at > now() - interval '30 days' GROUP BY tool_id
        ) x), '[]'::jsonb)
    )
  $$;

CREATE FUNCTION admin_list_users(p_limit integer, p_before timestamptz)
  RETURNS TABLE (id uuid, email text, tenant_name text, roles text[], status text,
                 created_at timestamptz, last_active_at timestamptz, task_count bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.email::text, t.name,
           COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id), '{}'),
           u.status, u.created_at, u.last_active_at,
           (SELECT count(*) FROM tasks k WHERE k.user_id = u.id)
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE p_before IS NULL OR u.created_at < p_before
     ORDER BY u.created_at DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
  $$;

CREATE FUNCTION admin_list_audit(p_limit integer, p_before_id bigint)
  RETURNS TABLE (id bigint, created_at timestamptz, tenant_id uuid, actor_type text, actor_id uuid,
                 action text, target_type text, target_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.id, a.created_at, a.tenant_id, a.actor_type, a.actor_id, a.action, a.target_type, a.target_id
      FROM audit_events a
     WHERE p_before_id IS NULL OR a.id < p_before_id
     ORDER BY a.id DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 200)
  $$;

-- Roles of the *calling* user, used to authorise admin endpoints before the
-- admin functions above are invoked.
CREATE FUNCTION auth_user_roles(p_user_id uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE(array_agg(role), '{}') FROM user_roles WHERE user_id = p_user_id
  $$;

REVOKE ALL ON FUNCTION auth_find_login(text), auth_resolve_session(bytea), admin_overview(),
  admin_list_users(integer, timestamptz), admin_list_audit(integer, bigint), auth_user_roles(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants for the runtime role
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_app') THEN
    RAISE EXCEPTION 'Role jarvis_app must exist before migrating (see scripts/db-setup.sh)';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO jarvis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, user_roles, devices, sessions, conversations, tasks, messages, task_steps,
  tool_executions, approvals, task_events, connections, memories, notifications, voice_sessions,
  call_sessions, browser_sessions, scheduled_tasks, usage_events, cost_records, subscriptions,
  idempotency_keys, jobs, worker_heartbeats
  TO jarvis_app;
GRANT SELECT ON feature_flags TO jarvis_app;
GRANT INSERT ON audit_events TO jarvis_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO jarvis_app;
GRANT EXECUTE ON FUNCTION auth_find_login(text), auth_resolve_session(bytea), admin_overview(),
  admin_list_users(integer, timestamptz), admin_list_audit(integer, bigint), auth_user_roles(uuid),
  app_current_tenant(), app_current_user() TO jarvis_app;
