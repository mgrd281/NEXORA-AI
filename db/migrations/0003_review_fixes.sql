-- 0003: fixes from the backend review.
--
-- 1. Idempotency claims are owned. Each claim carries a random claim_token, so
--    a request releases (deletes) or completes only the claim it holds, never
--    one another request inserted or took over after its lease ran out.
--    created_at is when the current claim was taken: a takeover renews it.
--    Rows written before this migration have no token; they are completed
--    responses, or abandoned claims that the next request takes over.
-- 2. Session changes are announced on the jarvis_sessions channel, so every
--    API instance ends the event streams (SSE) of a session or user at once:
--      {"s": <session id>, "u": <user id>}  that session was revoked, deleted
--                                           or its expiry was brought forward
--      {"u": <user id>}                     the user was disabled or deleted
--    The triggers cover every writer (logout, revokeSession, account deletion,
--    operator SQL). NOTIFY is transactional: nothing is sent on rollback.
-- 3. Every foreign key gets an index on its referencing columns, plus
--    jobs(user_id). Without them each cascaded delete (account deletion
--    removes a user's tasks and steps one by one) and the executor's
--    per-step tool_executions claim scan whole tables.
--
-- The indexes are built inside the migration transaction, which blocks writes
-- to each table while it is built. On a large deployment, create them first
-- with CREATE INDEX CONCURRENTLY under the same names; IF NOT EXISTS then
-- skips them here.

-- 1. Idempotency claim ownership -------------------------------------------

ALTER TABLE idempotency_keys ADD COLUMN claim_token uuid;

-- 2. Session-end notifications ----------------------------------------------

CREATE FUNCTION notify_session_ended() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r sessions;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM pg_notify('jarvis_sessions', json_build_object('s', r.id, 'u', r.user_id)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER sessions_ended_notify
  AFTER UPDATE OF revoked_at, expires_at ON sessions
  FOR EACH ROW
  WHEN ((OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR NEW.expires_at < OLD.expires_at)
  EXECUTE FUNCTION notify_session_ended();

CREATE TRIGGER sessions_deleted_notify
  AFTER DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION notify_session_ended();

CREATE FUNCTION notify_user_access_ended() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('jarvis_sessions', json_build_object('u', OLD.id)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER users_disabled_notify
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION notify_user_access_ended();

CREATE TRIGGER users_deleted_notify
  AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION notify_user_access_ended();

-- 3. Indexes ----------------------------------------------------------------

-- Per-step and per-task look-ups (cascades from task_steps and tasks).
CREATE INDEX IF NOT EXISTS tool_executions_step_idx ON tool_executions (step_id);
CREATE INDEX IF NOT EXISTS approvals_step_idx ON approvals (step_id);
CREATE INDEX IF NOT EXISTS messages_task_idx ON messages (task_id);
CREATE INDEX IF NOT EXISTS notifications_task_idx ON notifications (task_id);
CREATE INDEX IF NOT EXISTS cost_records_task_idx ON cost_records (task_id);
CREATE INDEX IF NOT EXISTS cost_records_usage_event_idx ON cost_records (usage_event_id);
CREATE INDEX IF NOT EXISTS usage_events_task_idx ON usage_events (task_id);
CREATE INDEX IF NOT EXISTS memories_source_task_idx ON memories (source_task_id);
CREATE INDEX IF NOT EXISTS voice_sessions_task_idx ON voice_sessions (task_id);
CREATE INDEX IF NOT EXISTS call_sessions_task_idx ON call_sessions (task_id);
CREATE INDEX IF NOT EXISTS browser_sessions_task_idx ON browser_sessions (task_id);
CREATE INDEX IF NOT EXISTS tasks_conversation_idx ON tasks (conversation_id);
CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions (device_id);

-- Per-user rows (cascade from users; jobs are deleted explicitly).
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id);
-- The stuck-task sweeper checks each active task for a live job.
CREATE INDEX IF NOT EXISTS jobs_task_idx ON jobs (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approvals_user_idx ON approvals (user_id);
CREATE INDEX IF NOT EXISTS browser_sessions_user_idx ON browser_sessions (user_id);
CREATE INDEX IF NOT EXISTS call_sessions_user_idx ON call_sessions (user_id);
CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id);
CREATE INDEX IF NOT EXISTS scheduled_tasks_user_idx ON scheduled_tasks (user_id);
CREATE INDEX IF NOT EXISTS task_steps_user_idx ON task_steps (user_id);
CREATE INDEX IF NOT EXISTS tool_executions_user_idx ON tool_executions (user_id);
CREATE INDEX IF NOT EXISTS voice_sessions_user_idx ON voice_sessions (user_id);
-- The partial (revoked_at IS NULL) index cannot serve the cascade; a full one serves both.
DROP INDEX IF EXISTS sessions_user_idx;
CREATE INDEX IF NOT EXISTS sessions_user_all_idx ON sessions (user_id);

-- Per-tenant rows (cascade when an account's last user deletes the tenant).
CREATE INDEX IF NOT EXISTS user_roles_tenant_idx ON user_roles (tenant_id);
CREATE INDEX IF NOT EXISTS devices_tenant_idx ON devices (tenant_id);
CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions (tenant_id);
CREATE INDEX IF NOT EXISTS conversations_tenant_idx ON conversations (tenant_id);
CREATE INDEX IF NOT EXISTS tasks_tenant_idx ON tasks (tenant_id);
CREATE INDEX IF NOT EXISTS messages_tenant_idx ON messages (tenant_id);
CREATE INDEX IF NOT EXISTS task_steps_tenant_idx ON task_steps (tenant_id);
CREATE INDEX IF NOT EXISTS tool_executions_tenant_idx ON tool_executions (tenant_id);
CREATE INDEX IF NOT EXISTS approvals_tenant_idx ON approvals (tenant_id);
CREATE INDEX IF NOT EXISTS task_events_tenant_idx ON task_events (tenant_id);
CREATE INDEX IF NOT EXISTS connections_tenant_idx ON connections (tenant_id);
CREATE INDEX IF NOT EXISTS memories_tenant_idx ON memories (tenant_id);
CREATE INDEX IF NOT EXISTS notifications_tenant_idx ON notifications (tenant_id);
CREATE INDEX IF NOT EXISTS voice_sessions_tenant_idx ON voice_sessions (tenant_id);
CREATE INDEX IF NOT EXISTS call_sessions_tenant_idx ON call_sessions (tenant_id);
CREATE INDEX IF NOT EXISTS browser_sessions_tenant_idx ON browser_sessions (tenant_id);
CREATE INDEX IF NOT EXISTS scheduled_tasks_tenant_idx ON scheduled_tasks (tenant_id);
CREATE INDEX IF NOT EXISTS usage_events_tenant_idx ON usage_events (tenant_id);
CREATE INDEX IF NOT EXISTS cost_records_tenant_idx ON cost_records (tenant_id);
CREATE INDEX IF NOT EXISTS subscriptions_tenant_idx ON subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idempotency_keys_tenant_idx ON idempotency_keys (tenant_id);
