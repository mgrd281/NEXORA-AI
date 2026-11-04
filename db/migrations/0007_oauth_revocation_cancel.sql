-- 0007 Phase C integration: disconnect, then reconnect the same Google account before the
-- revocation drain ran.
--
-- Google revokes a whole grant (user + client) when any of its tokens is revoked, and a new
-- consent of the same account joins that grant. A queued revocation of the old connection that
-- runs after the user connected the same account again would therefore revoke the new
-- connection too (it would flip to expired on first use). The outbox now records the account
-- the envelope belongs to, and completing an OAuth connection cancels this user's pending
-- revocations of the same provider account (the user just granted it again). Revocations of a
-- different account, or of another user, are never touched.

ALTER TABLE oauth_revocations
  ADD COLUMN provider_account_id text CHECK (length(provider_account_id) BETWEEN 1 AND 255);

CREATE OR REPLACE FUNCTION connections_queue_revocation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.provider = 'google' AND OLD.secret_ciphertext IS NOT NULL THEN
    INSERT INTO oauth_revocations (provider, tenant_id, user_id, connection_id,
                                   token_ciphertext, token_key_id, provider_account_id)
    VALUES (OLD.provider, OLD.tenant_id, OLD.user_id, OLD.id,
            OLD.secret_ciphertext, COALESCE(OLD.secret_key_id, ''), OLD.provider_account_id);
  END IF;
  RETURN NULL;
END $$;

-- The caller's own (app.user_id) pending revocations of this provider account; count only.
CREATE FUNCTION oauth_revocations_cancel(p_provider text, p_account text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH gone AS (
      DELETE FROM oauth_revocations r
       WHERE r.provider = p_provider
         AND r.provider_account_id = p_account
         AND r.user_id = app_current_user()
         AND r.tenant_id = app_current_tenant()
      RETURNING 1)
    SELECT count(*)::integer FROM gone
  $$;

REVOKE ALL ON FUNCTION oauth_revocations_cancel(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oauth_revocations_cancel(text, text) TO jarvis_app;
