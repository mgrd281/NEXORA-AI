-- 0004: Phase B — conversations and follow-ups, clarifying questions, attachments,
-- schedules, outbound webhooks, retention. Design: docs/architecture/phase-b.md.
--
--  1. tasks: outcome ('answer' | 'action' | 'question'), the clarifying question,
--     and the schedule that created the task.
--  2. conversations get a localisable title; messages get a kind (request /
--     answer / question / result) and a localisable text; at most one assistant
--     message per task.
--  3. attachments (+ task_attachments): user uploads in object storage. The key
--     format is fixed by a CHECK (per-tenant prefix). Deleting a row — directly,
--     by cascade (conversation, account, tenant) or by retention — queues the
--     object for deletion in storage_deletions (trigger), which only SECURITY
--     DEFINER functions can read, so the worker can drain it across tenants.
--  4. scheduled_tasks becomes usable (recurrence, status, failure counters,
--     links); schedule_runs records each occurrence once (dedupe).
--  5. webhook_endpoints (secret as a SecretBox envelope) and webhook_deliveries
--     (one per endpoint and event; payloads carry ids and metadata only).
--  6. New notification kinds and job kinds.
--  7. RLS on every new table, grants, and the narrow cross-tenant functions the
--     worker needs: due schedules, users due a retention sweep, storage deletions.
-- Retention preferences live in users.preferences (no columns).

-- ---------------------------------------------------------------------------
-- 1. Tasks
-- ---------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN outcome text CHECK (outcome IN ('answer', 'action', 'question')),
  ADD COLUMN question jsonb CHECK (question IS NULL OR jsonb_typeof(question) = 'object'),
  ADD COLUMN schedule_id uuid REFERENCES scheduled_tasks(id) ON DELETE SET NULL,
  -- Only a completed task has an outcome (COMPLETED is final, so it never goes stale).
  ADD CONSTRAINT tasks_outcome_completed CHECK (outcome IS NULL OR status = 'COMPLETED'),
  -- The question is present exactly when the outcome is 'question'.
  ADD CONSTRAINT tasks_question_outcome
    CHECK ((question IS NULL) = (outcome IS DISTINCT FROM 'question'));

CREATE INDEX tasks_schedule_idx ON tasks (schedule_id);
-- A conversation's tasks, newest first (thread pages, follow-up checks).
CREATE INDEX tasks_conversation_created_idx ON tasks (conversation_id, created_at DESC, id DESC);
DROP INDEX IF EXISTS tasks_conversation_idx;

-- ---------------------------------------------------------------------------
-- 2. Conversations and messages
-- ---------------------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN title_message jsonb
    CHECK (title_message IS NULL OR jsonb_typeof(title_message) = 'object');

-- History list: most recent activity first, keyset (updated_at, id).
CREATE INDEX conversations_user_activity_idx ON conversations (user_id, updated_at DESC, id DESC);
DROP INDEX IF EXISTS conversations_user_idx;

ALTER TABLE messages
  ADD COLUMN kind text NOT NULL DEFAULT 'request'
    CHECK (kind IN ('request', 'answer', 'question', 'result')),
  ADD COLUMN content_message jsonb
    CHECK (content_message IS NULL OR jsonb_typeof(content_message) = 'object'),
  -- The user writes requests; JARVIS writes answers, questions and result lines.
  ADD CONSTRAINT messages_kind_role CHECK ((role = 'user') = (kind = 'request'));

-- Exactly-once: the completion path inserts JARVIS's message ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX messages_one_assistant_per_task ON messages (task_id)
  WHERE role = 'assistant' AND task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Attachments
-- ---------------------------------------------------------------------------

CREATE TABLE attachments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set when a request first uses the file; the file is deleted with the conversation.
  conversation_id  uuid REFERENCES conversations(id) ON DELETE CASCADE,
  -- Sanitised by the API (no path separators or control characters).
  filename         text NOT NULL
                     CHECK (length(filename) BETWEEN 1 AND 255 AND filename !~ '[[:cntrl:]/\\]'),
  -- Identified from the content (contracts AttachmentMediaType).
  media_type       text NOT NULL CHECK (media_type IN (
                     'application/pdf',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                     'text/plain', 'text/markdown', 'text/csv')),
  -- contracts ATTACHMENT_LIMITS.maxBytes (10 MiB).
  size_bytes       integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_driver   text NOT NULL CHECK (storage_driver IN ('local', 's3')),
  storage_key      text NOT NULL UNIQUE,
  -- Filled in by document.analyze once it has read the file.
  page_count       integer CHECK (page_count >= 0),
  text_chars       integer CHECK (text_chars >= 0),
  extracted_at     timestamptz,
  -- Unattached uploads are deleted after this (contracts ATTACHMENT_LIMITS.unattachedTtlHours).
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Per-tenant key prefix, fixed: the storage driver may only add a deployment prefix.
  CONSTRAINT attachments_storage_key_format CHECK (
    storage_key = 'tenants/' || tenant_id::text || '/users/' || user_id::text
                  || '/attachments/' || id::text),
  -- Unattached ⇔ expiring.
  CONSTRAINT attachments_unattached_expire CHECK ((conversation_id IS NULL) = (expires_at IS NOT NULL))
);
CREATE INDEX attachments_user_idx ON attachments (user_id, created_at DESC);
CREATE INDEX attachments_tenant_idx ON attachments (tenant_id);
CREATE INDEX attachments_conversation_idx ON attachments (conversation_id);
CREATE INDEX attachments_expiry_idx ON attachments (expires_at) WHERE expires_at IS NOT NULL;

-- Which files a task's request named, in order. The API links only files of the
-- task's own conversation (or unattached uploads, which it then moves into it).
CREATE TABLE task_attachments (
  task_id        uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attachment_id  uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- contracts ATTACHMENT_LIMITS.maxPerRequest (5).
  position       smallint NOT NULL CHECK (position BETWEEN 0 AND 4),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, attachment_id),
  UNIQUE (task_id, position)
);
CREATE INDEX task_attachments_attachment_idx ON task_attachments (attachment_id);
CREATE INDEX task_attachments_user_idx ON task_attachments (user_id);
CREATE INDEX task_attachments_tenant_idx ON task_attachments (tenant_id);

-- Objects to delete from storage. Filled by a trigger on every attachments row
-- deletion (whatever caused it), drained by the worker through the functions
-- below. RLS is on with no policy: jarvis_app cannot read or change it directly.
-- No foreign keys: rows must outlive the user and tenant they belonged to.
CREATE TABLE storage_deletions (
  id              bigserial PRIMARY KEY,
  storage_driver  text NOT NULL CHECK (storage_driver IN ('local', 's3')),
  storage_key     text NOT NULL,
  tenant_id       uuid NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  not_before      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_deletions_due_idx ON storage_deletions (not_before, id);
ALTER TABLE storage_deletions ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION attachments_queue_storage_deletion() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO storage_deletions (storage_driver, storage_key, tenant_id)
  VALUES (OLD.storage_driver, OLD.storage_key, OLD.tenant_id);
  RETURN NULL;
END $$;

CREATE TRIGGER attachments_storage_deletion
  AFTER DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_queue_storage_deletion();

-- Leases up to p_limit due deletions (each becomes due again after the lease,
-- so a crashed worker's batch is retried). Returns what to delete.
CREATE FUNCTION storage_deletions_claim(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (id bigint, storage_driver text, storage_key text, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE storage_deletions d
       SET attempts = d.attempts + 1,
           not_before = now() + make_interval(secs => GREATEST(p_lease_seconds, 30))
     WHERE d.id IN (
       SELECT s.id FROM storage_deletions s
        WHERE s.not_before <= now()
        ORDER BY s.not_before, s.id
        LIMIT LEAST(GREATEST(p_limit, 1), 500)
        FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.storage_driver, d.storage_key, d.attempts
  $$;

-- The objects are gone (deleting a missing object counts as done).
CREATE FUNCTION storage_deletions_complete(p_ids bigint[]) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH gone AS (DELETE FROM storage_deletions d WHERE d.id = ANY (p_ids) RETURNING 1)
    SELECT count(*)::integer FROM gone
  $$;

-- A deletion failed: retry with exponential backoff (2^attempts minutes, at most a day).
CREATE FUNCTION storage_deletions_failed(p_id bigint, p_error text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE storage_deletions d
       SET last_error = left(p_error, 500),
           not_before = now() + LEAST(interval '1 day',
                                      make_interval(mins => power(2, LEAST(d.attempts, 11))::integer))
     WHERE d.id = p_id
  $$;

-- ---------------------------------------------------------------------------
-- 4. Schedules
-- ---------------------------------------------------------------------------

-- Nothing wrote scheduled_tasks before Phase B; the new NOT NULL columns rely on it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM scheduled_tasks) THEN
    RAISE EXCEPTION '0004 expects scheduled_tasks to be empty (no release wrote it)';
  END IF;
END $$;

ALTER TABLE scheduled_tasks DROP COLUMN enabled;
ALTER TABLE scheduled_tasks
  -- contracts Recurrence, normalised by the API; time_zone repeats recurrence.timeZone.
  ADD COLUMN recurrence jsonb NOT NULL,
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed')),
  ADD COLUMN paused_reason text CHECK (paused_reason IN ('user', 'failures', 'budget')),
  ADD COLUMN language text CHECK (language IN ('en', 'de', 'ar')),
  -- Collects the runs' tasks; created with the first run.
  ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent')),
  -- The task whose approved schedule.create step created it (created_by = 'agent').
  ADD COLUMN created_by_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN last_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN last_failure_at timestamptz,
  -- Kept for readers of the Milestone 1 column (the account export); derived, never written.
  ADD COLUMN enabled boolean GENERATED ALWAYS AS (status = 'active') STORED,
  ADD CONSTRAINT scheduled_tasks_title_length CHECK (length(title) BETWEEN 1 AND 120),
  ADD CONSTRAINT scheduled_tasks_request_length CHECK (length(request) BETWEEN 1 AND 4000),
  ADD CONSTRAINT scheduled_tasks_rrule_length CHECK (length(rrule) BETWEEN 1 AND 2000),
  ADD CONSTRAINT scheduled_tasks_recurrence_shape CHECK (
    jsonb_typeof(recurrence) = 'object'
    AND recurrence->>'frequency' IN ('daily', 'weekly', 'monthly')
    AND recurrence->>'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND recurrence->>'timeZone' = time_zone),
  ADD CONSTRAINT scheduled_tasks_paused_reason CHECK ((status = 'paused') = (paused_reason IS NOT NULL)),
  -- Only an active schedule has a next run.
  ADD CONSTRAINT scheduled_tasks_next_run CHECK ((status = 'active') = (next_run_at IS NOT NULL)),
  ADD CONSTRAINT scheduled_tasks_agent_task CHECK (created_by = 'agent' OR created_by_task_id IS NULL);

-- The scheduler's hot path: active schedules by due time.
CREATE INDEX scheduled_tasks_due_idx ON scheduled_tasks (next_run_at) WHERE status = 'active';
CREATE INDEX scheduled_tasks_conversation_idx ON scheduled_tasks (conversation_id);
CREATE INDEX scheduled_tasks_created_by_task_idx ON scheduled_tasks (created_by_task_id);
CREATE INDEX scheduled_tasks_last_task_idx ON scheduled_tasks (last_task_id);

-- One row per occurrence that came due: the unique key is what makes "each
-- occurrence runs at most once" a database guarantee (several workers, retries).
CREATE TABLE schedule_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id    uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  occurrence_at  timestamptz NOT NULL,
  status         text NOT NULL CHECK (status IN ('created', 'skipped', 'failed')),
  reason         text CHECK (reason IN ('BUDGET_EXHAUSTED', 'SCHEDULE_PAUSED', 'CREATE_FAILED')),
  task_id        uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_runs_once_per_occurrence UNIQUE (schedule_id, occurrence_at),
  CONSTRAINT schedule_runs_reason CHECK ((status = 'created') = (reason IS NULL))
);
CREATE INDEX schedule_runs_task_idx ON schedule_runs (task_id);
CREATE INDEX schedule_runs_user_idx ON schedule_runs (user_id);
CREATE INDEX schedule_runs_tenant_idx ON schedule_runs (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. Outbound webhooks (Standard Webhooks)
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_endpoints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Validated (https, public address) by the API at save time and again per attempt.
  url                   text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048 AND url ~ '^https?://'),
  description           text CHECK (length(description) <= 200),
  event_types           text[] NOT NULL CHECK (
                          cardinality(event_types) BETWEEN 1 AND 9
                          AND event_types <@ ARRAY['task.created', 'task.completed', 'task.failed',
                                                   'task.cancelled', 'task.expired',
                                                   'approval.requested', 'approval.decided',
                                                   'schedule.triggered', 'schedule.failed']::text[]),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason       text CHECK (disabled_reason IN ('user', 'failures')),
  -- SecretBox envelope of the whsec_ secret (AAD: webhook:<user id>:<endpoint id>).
  secret_ciphertext     bytea NOT NULL,
  secret_key_id         text NOT NULL,
  -- Last characters of the secret, to recognise it ("whsec_…x7Qa"); never the secret.
  secret_hint           text NOT NULL CHECK (length(secret_hint) BETWEEN 1 AND 32),
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_delivery_at      timestamptz,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoints_disabled_reason
    CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL))
);
CREATE INDEX webhook_endpoints_user_idx ON webhook_endpoints (user_id, created_at);
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id);

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type       text NOT NULL CHECK (event_type IN (
                     'task.created', 'task.completed', 'task.failed', 'task.cancelled',
                     'task.expired', 'approval.requested', 'approval.decided',
                     'schedule.triggered', 'schedule.failed', 'webhook.test')),
  -- What the event is about, e.g. 'task.completed:<task id>' (test sends: 'webhook.test:<uuid>').
  event_key        text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  -- contracts WebhookPayload: ids, enums and times only — never content.
  payload          jsonb NOT NULL
                     CHECK (jsonb_typeof(payload) = 'object' AND payload ?& ARRAY['type', 'timestamp', 'data']),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,
  response_status  integer CHECK (response_status BETWEEN 100 AND 599),
  failure_reason   text CHECK (failure_reason IN (
                     'HTTP_ERROR', 'TIMEOUT', 'CONNECT_FAILED', 'TLS_CERTIFICATE', 'HOST_NOT_FOUND',
                     'PRIVATE_ADDRESS', 'REDIRECT', 'ENDPOINT_DISABLED', 'ENDPOINT_DELETED',
                     'INTERNAL')),
  duration_ms      integer CHECK (duration_ms >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  -- Exactly-once enqueue: one delivery per endpoint and event, however often it is emitted.
  CONSTRAINT webhook_deliveries_once_per_event UNIQUE (endpoint_id, event_key),
  CONSTRAINT webhook_deliveries_completed CHECK ((status = 'pending') = (completed_at IS NULL)),
  CONSTRAINT webhook_deliveries_attempts CHECK (attempts <= max_attempts)
);
-- Delivery log per endpoint, newest first (keyset created_at, id).
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC, id DESC);
-- Retention of the log (WEBHOOK_LIMITS.deliveryRetentionDays) and the user FK.
CREATE INDEX webhook_deliveries_user_idx ON webhook_deliveries (user_id, created_at);
CREATE INDEX webhook_deliveries_tenant_idx ON webhook_deliveries (tenant_id);

-- ---------------------------------------------------------------------------
-- 6. Enumerations shared with the contracts
-- ---------------------------------------------------------------------------

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'approval_requested', 'task_completed', 'task_failed', 'connection_error',
  'schedule_failed', 'schedule_paused', 'webhook_disabled'));

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'task.plan', 'task.execute', 'approval.expire',
  'schedule.run', 'retention.sweep', 'webhook.deliver'));

-- ---------------------------------------------------------------------------
-- 7. updated_at, Row-Level Security, cross-tenant functions, grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attachments', 'webhook_endpoints', 'webhook_deliveries']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- User-private tables: tenant AND user must match (as in 0001).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attachments', 'task_attachments', 'schedule_runs',
                           'webhook_endpoints', 'webhook_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant() AND user_id = app_current_user()) '
      'WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user())',
      t || '_owner', t);
  END LOOP;
END $$;

-- Active schedules that are due, across tenants (the worker's scheduler tick
-- then handles each one inside that user's own RLS context). Ids only.
CREATE FUNCTION scheduler_due_schedules(p_limit integer)
  RETURNS TABLE (schedule_id uuid, tenant_id uuid, user_id uuid, next_run_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.id, s.tenant_id, s.user_id, s.next_run_at
      FROM scheduled_tasks s JOIN users u ON u.id = s.user_id
     WHERE s.status = 'active' AND s.next_run_at <= now() AND u.status = 'active'
     ORDER BY s.next_run_at, s.id
     LIMIT LEAST(GREATEST(p_limit, 1), 500)
  $$;

-- Users with something for the daily retention sweep (retention preferences
-- set, expired unattached uploads, or webhook deliveries past the log's
-- retention), keyset-paged by user id. Ids only; the sweep reads the
-- preferences again inside the user's RLS context.
CREATE FUNCTION retention_due_users(p_after uuid, p_limit integer)
  RETURNS TABLE (tenant_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.tenant_id, u.id
      FROM users u
     WHERE (p_after IS NULL OR u.id > p_after)
       AND (jsonb_typeof(u.preferences -> 'retention' -> 'memoryDays') = 'number'
            OR jsonb_typeof(u.preferences -> 'retention' -> 'taskHistoryDays') = 'number'
            OR EXISTS (SELECT 1 FROM attachments a
                        WHERE a.user_id = u.id AND a.expires_at < now())
            OR EXISTS (SELECT 1 FROM webhook_deliveries d
                        WHERE d.user_id = u.id AND d.created_at < now() - interval '30 days'))
     ORDER BY u.id
     LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  $$;

REVOKE ALL ON FUNCTION scheduler_due_schedules(integer), retention_due_users(uuid, integer),
  storage_deletions_claim(integer, integer), storage_deletions_complete(bigint[]),
  storage_deletions_failed(bigint, text), attachments_queue_storage_deletion() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  attachments, task_attachments, schedule_runs, webhook_endpoints, webhook_deliveries
  TO jarvis_app;
-- storage_deletions: no table privileges; only through these functions.
GRANT EXECUTE ON FUNCTION scheduler_due_schedules(integer), retention_due_users(uuid, integer),
  storage_deletions_claim(integer, integer), storage_deletions_complete(bigint[]),
  storage_deletions_failed(bigint, text) TO jarvis_app;
