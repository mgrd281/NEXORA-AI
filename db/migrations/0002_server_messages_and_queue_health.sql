-- 0002: server-written sentences as message keys, and an honest queue metric.
--
-- 1. Sentences the server composes (offline plan/step titles, approval
--    summaries, result lines) are stored as {key, params} next to the plain
--    text, so clients render them in the viewer's locale. The text columns
--    stay as the fallback (and for model-written or page text, the only form).
-- 2. admin_overview() splits queued jobs into ready (due now: the backlog) and
--    scheduled (due later, e.g. approval.expire timers), and reports how long
--    the oldest ready job has waited. queue_depth now means ready jobs.

ALTER TABLE tasks
  ADD COLUMN title_message          jsonb,
  ADD COLUMN objective_message      jsonb,
  ADD COLUMN result_summary_message jsonb;

ALTER TABLE task_steps ADD COLUMN title_message jsonb;

ALTER TABLE approvals ADD COLUMN summary_message jsonb;

CREATE OR REPLACE FUNCTION admin_overview() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_object(
      'users_total', (SELECT count(*) FROM users),
      'users_active_7d', (SELECT count(*) FROM users WHERE last_active_at > now() - interval '7 days'),
      'tenants_total', (SELECT count(*) FROM tenants),
      'tasks_by_status', COALESCE((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM tasks GROUP BY status) s), '{}'::jsonb),
      'queue_depth', (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at <= now()),
      'queue_ready', (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at <= now()),
      'queue_scheduled', (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at > now()),
      'oldest_ready_age_ms', (
        SELECT floor(extract(epoch FROM (now() - min(run_at))) * 1000)::bigint
          FROM jobs WHERE status = 'queued' AND run_at <= now()),
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
