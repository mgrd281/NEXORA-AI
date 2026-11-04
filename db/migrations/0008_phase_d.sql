-- 0008: Phase D — voice conversation metadata and the phone agent (telephony gateway).
-- Design: docs/architecture/phase-d.md, ADRs 0019 (voice conversation) and 0020 (telephony
-- gateway), docs/security/telephony.md.
--
--  1. users: the account's own phone number (E.164) and when a verification call confirmed it.
--     Stored as plain text, like users.email: it is the owner's own contact detail, shown to
--     them on every profile read (encrypting it would only move the key next to the data, in
--     the same process), protected by RLS and at-rest disk encryption, exported and deleted
--     with the account. It is used for one thing only: putting a callee through to the owner
--     (transfer) — never shared on a call unless the approval lists it.
--  2. call_sessions (created in 0001 and never written) is rebuilt as the record of one call
--     attempt: exactly once per attempt (UNIQUE (user_id, idempotency_key) and
--     UNIQUE (step_id, attempt)), the provider call id (globally unique), a hash of the per-call
--     webhook URL token, the status, its timeline and the provider's sequence number (replay /
--     reordering), the structured outcome, AI disclosure, recording consent, transfer, duration,
--     cost estimate and the provider's price. The callee number is stored as written: it is the
--     user's own input, already in plain text in the request, the step input and the approval,
--     and it goes with the task (retention, deletion). A keyed hash of it serves the
--     do-not-call checks.
--  3. call_turns: what was said, turn by turn (JARVIS verbatim; the callee as the provider's
--     speech recognition — untrusted). Task data: deleted with the call, i.e. with the task.
--  4. do_not_call: numbers this user's JARVIS must not call. They outlive tasks (a callee's
--     wish not to be called again must), so the number itself is NOT stored in plain: a keyed
--     hash (HMAC-SHA256) for the check, a masked form for display and the number sealed with
--     SecretBox (AAD dnc:<user id>:<id>) so a key rotation can re-hash it.
--  5. phone_verifications: a call that reads a code to the owner's number (the code sealed with
--     SecretBox, attempts bounded, short-lived, one live verification per user).
--  6. voice_sessions: conversation mode, its conversation and counters (no content).
--  7. evidence_artifacts: a call recording is an evidence file of its call (kind 'recording',
--     audio/mpeg); a trigger refuses to store one unless the callee consented on that call.
--  8. Job kinds call.timeout and call.recording_fetch; the narrow SECURITY DEFINER function the
--     webhook routes use to find the owner of a call; RLS on every new table; grants.

-- ---------------------------------------------------------------------------
-- 1. The account's phone number
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN phone_number text CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN phone_verified_at timestamptz,
  ADD CONSTRAINT users_phone_verified CHECK (phone_verified_at IS NULL OR phone_number IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. Call sessions (one row per call attempt)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM call_sessions) THEN
    RAISE EXCEPTION '0008 expects call_sessions to be empty (no release wrote it)';
  END IF;
END $$;

-- Dropping the 0001 placeholder removes its policy and its 0003 indexes with it.
DROP TABLE call_sessions;

CREATE TABLE call_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A call belongs to its task: retention and deletion of the task remove it with its turns.
  task_id               uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id               uuid NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  -- 1, 2 … per step: a retry of a definitely ended, unsuccessful call is attempt n + 1.
  attempt               integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  -- 'call:<step id>:a<attempt>': inserted BEFORE the provider is asked; a unique violation means
  -- "this attempt exists — read it, never dial again".
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  provider              text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio')),
  -- Twilio Call SID, known once the provider accepted the create-call request.
  provider_call_sid     text UNIQUE CHECK (provider_call_sid ~ '^CA[0-9a-f]{32}$'),
  -- SHA-256 of the per-call URL token every webhook URL of this call carries (never stored).
  webhook_token_hash    bytea NOT NULL UNIQUE CHECK (length(webhook_token_hash) = 32),
  callee_number         text NOT NULL CHECK (callee_number ~ '^\+[1-9][0-9]{7,14}$'),
  -- HMAC-SHA256 of the E.164 number (lib/phone.ts phoneNumberHash): do-not-call checks.
  callee_number_hash    bytea NOT NULL CHECK (length(callee_number_hash) = 32),
  callee_country        text CHECK (callee_country ~ '^[A-Z]{2}$'),
  callee_name           text CHECK (length(callee_name) BETWEEN 1 AND 120),
  -- Allowed calling hours are checked in this zone.
  callee_time_zone      text NOT NULL CHECK (length(callee_time_zone) BETWEEN 1 AND 64),
  -- The number the callee sees (the server's TWILIO_FROM_NUMBER when it was placed).
  caller_id             text NOT NULL CHECK (caller_id ~ '^\+[1-9][0-9]{7,14}$'),
  language              text NOT NULL CHECK (language IN ('en', 'de', 'ar')),
  purpose               text NOT NULL CHECK (purpose IN ('message', 'availability', 'questions', 'appointment')),
  dialog_mode           text NOT NULL CHECK (dialog_mode IN ('scripted', 'model')),
  -- The approved, resolved phone.call input (contracts PhoneCallInput, with its script).
  request               jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  -- contracts CallStatus / CallResult.
  status                text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'dialing', 'ringing', 'in_progress', 'ended', 'unknown')),
  result                text CHECK (result IN ('completed', 'answered', 'busy', 'no_answer', 'failed',
                                               'voicemail', 'hung_up', 'declined', 'canceled')),
  -- contracts TaskErrorReason of an unsuccessful attempt (CALL_BUSY …, CALL_STATE_UNKNOWN).
  failure_reason        text CHECK (length(failure_reason) BETWEEN 1 AND 64),
  -- contracts CallOutcome, once ended.
  outcome               jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  answered_by           text CHECK (answered_by IN ('human', 'machine', 'fax', 'unknown')),
  -- When the opening (AI disclosure + on whose behalf) was spoken.
  ai_disclosed_at       timestamptz,
  recording_mode        text NOT NULL DEFAULT 'off' CHECK (recording_mode IN ('off', 'if_consented', 'required')),
  recording_consent     text NOT NULL DEFAULT 'not_asked'
                          CHECK (recording_consent IN ('not_asked', 'accepted', 'declined')),
  recording_consent_at  timestamptz,
  -- Twilio Recording SID: only ever started after the callee accepted.
  recording_sid         text CHECK (recording_sid ~ '^RE[0-9a-f]{32}$'),
  transfer_status       text NOT NULL DEFAULT 'none'
                          CHECK (transfer_status IN ('none', 'requested', 'connected', 'failed', 'unavailable')),
  transfer_at           timestamptz,
  -- contracts CallStatusEvent[], oldest first.
  status_timeline       jsonb NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(status_timeline) = 'array' AND jsonb_array_length(status_timeline) <= 64),
  -- The highest provider SequenceNumber applied: older and repeated status callbacks are ignored.
  last_status_sequence  integer CHECK (last_status_sequence >= 0),
  -- Turns stored so far; the next turn's sequence (gather answers carry it in their signed URL).
  turn_count            integer NOT NULL DEFAULT 0 CHECK (turn_count BETWEEN 0 AND 200),
  max_duration_seconds  integer NOT NULL CHECK (max_duration_seconds BETWEEN 30 AND 1800),
  duration_seconds      integer CHECK (duration_seconds >= 0),
  -- Upper bound shown in the approval (CALL_PRICE_PER_MINUTE_USD × max minutes), micro-USD.
  cost_estimate_micro   bigint CHECK (cost_estimate_micro >= 0),
  -- The provider's price once it reports one (absolute value).
  price_micro           bigint CHECK (price_micro >= 0),
  price_currency        text CHECK (price_currency ~ '^[A-Z]{3}$'),
  -- The approval that authorised exactly this call, and its action hash (audit trail).
  approval_id           uuid REFERENCES approvals(id) ON DELETE SET NULL,
  action_hash           text NOT NULL CHECK (length(action_hash) BETWEEN 16 AND 128),
  dialed_at             timestamptz,
  answered_at           timestamptz,
  ended_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_sessions_once_per_key UNIQUE (user_id, idempotency_key),
  CONSTRAINT call_sessions_once_per_attempt UNIQUE (step_id, attempt),
  -- Ended ⇔ a result, an end time and an outcome.
  CONSTRAINT call_sessions_ended CHECK (
    (status = 'ended') = (result IS NOT NULL)
    AND (status = 'ended') = (ended_at IS NOT NULL)
    AND (status = 'ended') = (outcome IS NOT NULL)),
  -- A failure reason only on an ended attempt that was not successful, or an unknown one.
  CONSTRAINT call_sessions_failure_reason CHECK (
    failure_reason IS NULL
    OR (status = 'ended' AND result NOT IN ('completed', 'answered'))
    OR status = 'unknown'),
  -- Past 'queued' the provider has the call — except an unknown create, and an attempt that
  -- ended before the provider accepted it (refused, or cancelled by JARVIS).
  CONSTRAINT call_sessions_provider_sid CHECK (
    provider_call_sid IS NOT NULL
    OR status IN ('queued', 'unknown')
    OR (status = 'ended' AND result IN ('failed', 'canceled'))),
  CONSTRAINT call_sessions_disclosed_after_answer CHECK (
    ai_disclosed_at IS NULL OR answered_at IS NOT NULL),
  -- Consent is asked only when recording was requested, and answered with a time.
  CONSTRAINT call_sessions_consent CHECK (
    (recording_consent = 'not_asked') = (recording_consent_at IS NULL)
    AND (recording_mode <> 'off' OR recording_consent = 'not_asked')),
  -- Never a recording without the callee's consent on this call.
  CONSTRAINT call_sessions_recording_consented CHECK (
    recording_sid IS NULL OR recording_consent = 'accepted'),
  CONSTRAINT call_sessions_price CHECK ((price_micro IS NULL) = (price_currency IS NULL)),
  CONSTRAINT call_sessions_transfer CHECK ((transfer_status = 'none') = (transfer_at IS NULL))
);
CREATE INDEX call_sessions_user_idx ON call_sessions (user_id, created_at DESC, id DESC);
CREATE INDEX call_sessions_tenant_idx ON call_sessions (tenant_id);
CREATE INDEX call_sessions_task_idx ON call_sessions (task_id);
CREATE INDEX call_sessions_step_idx ON call_sessions (step_id);
CREATE INDEX call_sessions_approval_idx ON call_sessions (approval_id);
-- Calls still in flight (the watchdog, the per-user concurrency check).
CREATE INDEX call_sessions_live_idx ON call_sessions (user_id, status)
  WHERE status IN ('queued', 'dialing', 'ringing', 'in_progress', 'unknown');

-- ---------------------------------------------------------------------------
-- 3. Call turns
-- ---------------------------------------------------------------------------

CREATE TABLE call_turns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_session_id  uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  -- 0, 1, 2 … in the order spoken; a repeated webhook cannot add a turn twice.
  sequence         integer NOT NULL CHECK (sequence BETWEEN 0 AND 199),
  speaker          text NOT NULL CHECK (speaker IN ('agent', 'callee', 'system')),
  kind             text NOT NULL CHECK (kind IN ('disclosure', 'consent_request', 'consent_reply',
                                                 'question', 'answer', 'statement', 'clarification',
                                                 'refusal', 'transfer', 'voicemail', 'goodbye')),
  text             text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  language         text NOT NULL CHECK (language IN ('en', 'de', 'ar')),
  confidence       real CHECK (confidence BETWEEN 0 AND 1),
  -- The callee's words contained instructions to AI assistants (ignored; detector signal ids).
  flagged          boolean NOT NULL DEFAULT false,
  injection_signals text[] NOT NULL DEFAULT '{}' CHECK (cardinality(injection_signals) <= 16),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_turns_once_per_sequence UNIQUE (call_session_id, sequence),
  -- Only what the callee said has a recognition confidence or can be flagged.
  CONSTRAINT call_turns_callee_fields CHECK (
    speaker = 'callee' OR (confidence IS NULL AND NOT flagged AND injection_signals = '{}'))
);
CREATE INDEX call_turns_user_idx ON call_turns (user_id);
CREATE INDEX call_turns_tenant_idx ON call_turns (tenant_id);

-- ---------------------------------------------------------------------------
-- 4. Do-not-call list
-- ---------------------------------------------------------------------------

CREATE TABLE do_not_call (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- HMAC-SHA256 of the E.164 number with the server's phone-hash key (lib/phone.ts).
  number_hash        bytea NOT NULL CHECK (length(number_hash) = 32),
  -- For display only, e.g. "+49 30 ••• •• 78".
  number_masked      text NOT NULL CHECK (length(number_masked) BETWEEN 4 AND 40),
  -- The number sealed with SecretBox (AAD dnc:<user id>:<id>): lets a key rotation re-hash it.
  number_ciphertext  bytea NOT NULL,
  number_key_id      text NOT NULL CHECK (length(number_key_id) BETWEEN 1 AND 64),
  country            text CHECK (country ~ '^[A-Z]{2}$'),
  source             text NOT NULL CHECK (source IN ('callee_request', 'user')),
  -- The call during which the callee asked; the entry outlives the call and its task.
  call_session_id    uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT do_not_call_once_per_number UNIQUE (user_id, number_hash)
);
CREATE INDEX do_not_call_user_idx ON do_not_call (user_id, created_at DESC);
CREATE INDEX do_not_call_tenant_idx ON do_not_call (tenant_id);
CREATE INDEX do_not_call_call_idx ON do_not_call (call_session_id);

-- ---------------------------------------------------------------------------
-- 5. Phone number verification calls
-- ---------------------------------------------------------------------------

CREATE TABLE phone_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_number        text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  -- The code JARVIS reads out, sealed with SecretBox (AAD phone-verification:<user id>:<id>).
  code_ciphertext     bytea NOT NULL,
  code_key_id         text NOT NULL CHECK (length(code_key_id) BETWEEN 1 AND 64),
  status              text NOT NULL DEFAULT 'calling'
                        CHECK (status IN ('calling', 'pending', 'verified', 'expired', 'failed')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  provider_call_sid   text UNIQUE CHECK (provider_call_sid ~ '^CA[0-9a-f]{32}$'),
  webhook_token_hash  bytea NOT NULL UNIQUE CHECK (length(webhook_token_hash) = 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- contracts CALL_LIMITS.verificationTtlMinutes (10); never longer than 15 minutes.
  expires_at          timestamptz NOT NULL,
  verified_at         timestamptz,
  CONSTRAINT phone_verifications_short_lived CHECK (expires_at <= created_at + interval '15 minutes'),
  CONSTRAINT phone_verifications_verified CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);
-- One live verification per user.
CREATE UNIQUE INDEX phone_verifications_one_live ON phone_verifications (user_id)
  WHERE status IN ('calling', 'pending');
CREATE INDEX phone_verifications_user_idx ON phone_verifications (user_id, created_at DESC);
CREATE INDEX phone_verifications_tenant_idx ON phone_verifications (tenant_id);

-- ---------------------------------------------------------------------------
-- 6. Voice sessions: conversation mode (metadata only)
-- ---------------------------------------------------------------------------

ALTER TABLE voice_sessions DROP CONSTRAINT voice_sessions_outcome_check;
ALTER TABLE voice_sessions
  ADD CONSTRAINT voice_sessions_outcome_check
    CHECK (outcome IN ('submitted', 'cancelled', 'error', 'no_speech', 'ended')),
  ADD COLUMN mode text NOT NULL DEFAULT 'dictation' CHECK (mode IN ('dictation', 'conversation')),
  -- The conversation the session's requests went to (follow-ups).
  ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN turn_count integer CHECK (turn_count BETWEEN 0 AND 500),
  ADD COLUMN barge_in_count integer CHECK (barge_in_count >= 0),
  ADD COLUMN reconnect_count integer CHECK (reconnect_count >= 0),
  ADD COLUMN end_reason text CHECK (end_reason IN ('end_button', 'escape_key', 'voice_command', 'idle',
                                                   'switched_to_text', 'navigation', 'error'));
CREATE INDEX voice_sessions_conversation_idx ON voice_sessions (conversation_id);

-- ---------------------------------------------------------------------------
-- 7. Call recordings as evidence files
-- ---------------------------------------------------------------------------

ALTER TABLE evidence_artifacts DROP CONSTRAINT evidence_artifacts_kind_check;
ALTER TABLE evidence_artifacts DROP CONSTRAINT evidence_artifacts_media_type_check;
ALTER TABLE evidence_artifacts DROP CONSTRAINT evidence_artifacts_media_type;
ALTER TABLE evidence_artifacts DROP CONSTRAINT evidence_artifacts_size_bytes_check;
ALTER TABLE evidence_artifacts
  ALTER COLUMN browser_session_id DROP NOT NULL,
  ADD COLUMN call_session_id uuid REFERENCES call_sessions(id) ON DELETE CASCADE,
  ADD CONSTRAINT evidence_artifacts_kind_check
    CHECK (kind IN ('screenshot', 'extract', 'ics', 'recording')),
  ADD CONSTRAINT evidence_artifacts_media_type_check
    CHECK (media_type IN ('image/png', 'application/json', 'text/calendar', 'audio/mpeg')),
  ADD CONSTRAINT evidence_artifacts_media_type CHECK (
    (kind = 'screenshot' AND media_type = 'image/png')
    OR (kind = 'extract' AND media_type = 'application/json')
    OR (kind = 'ics' AND media_type = 'text/calendar')
    OR (kind = 'recording' AND media_type = 'audio/mpeg')),
  -- contracts BROWSER_LIMITS (2 MiB) for browser evidence, CALL_LIMITS.maxRecordingBytes (32 MiB).
  ADD CONSTRAINT evidence_artifacts_size_bytes_check CHECK (
    size_bytes >= 1
    AND size_bytes <= CASE WHEN kind = 'recording' THEN 33554432 ELSE 2097152 END),
  -- Every file comes from exactly one source: a browser session, or (recordings) a call.
  ADD CONSTRAINT evidence_artifacts_source CHECK (
    (browser_session_id IS NULL) <> (call_session_id IS NULL)
    AND (kind = 'recording') = (call_session_id IS NOT NULL));
CREATE INDEX evidence_artifacts_call_idx ON evidence_artifacts (call_session_id);
CREATE UNIQUE INDEX evidence_artifacts_one_recording_per_call ON evidence_artifacts (call_session_id)
  WHERE kind = 'recording';

-- A recording is stored only for a call whose callee accepted being recorded (defence in depth
-- behind the dialog engine and the call_sessions CHECK). Runs as the inserting role, under its
-- RLS: a call it cannot see counts as not consented.
CREATE FUNCTION evidence_artifacts_recording_consent() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'recording' AND NOT EXISTS (
       SELECT 1 FROM call_sessions c
        WHERE c.id = NEW.call_session_id AND c.recording_consent = 'accepted'
          AND c.recording_mode <> 'off') THEN
    RAISE EXCEPTION 'a call recording needs the callee''s consent on that call'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evidence_artifacts_recording_consent
  BEFORE INSERT OR UPDATE OF kind, call_session_id ON evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION evidence_artifacts_recording_consent();

-- ---------------------------------------------------------------------------
-- 8. Job kinds, feature flag
-- ---------------------------------------------------------------------------

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'task.plan', 'task.execute', 'approval.expire',
  'schedule.run', 'retention.sweep', 'webhook.deliver',
  'email.watch_poll', 'browser.session',
  'call.timeout', 'call.recording_fetch'));

UPDATE feature_flags
   SET description = 'Unused since Phase D: phone calls are available where Twilio is configured (docs/adr/0020).'
 WHERE key = 'telephony';

-- ---------------------------------------------------------------------------
-- 9. updated_at, Row-Level Security, the webhook owner look-up, grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_sessions', 'phone_verifications']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- User-private tables: tenant AND user must match (as in 0001).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_sessions', 'call_turns', 'do_not_call', 'phone_verifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant() AND user_id = app_current_user()) '
      'WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user())',
      t || '_owner', t);
  END LOOP;
END $$;

-- The owner of the call (or verification call) a telephony webhook is about — only when the
-- URL token's hash matches. Webhooks carry no session: this is how they enter the owner's RLS
-- context (after the provider signature was validated). Ids only; nothing else crosses tenants.
CREATE FUNCTION telephony_webhook_target(p_target text, p_id uuid, p_token_hash bytea)
  RETURNS TABLE (tenant_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.tenant_id, c.user_id FROM call_sessions c
     WHERE p_target = 'call' AND c.id = p_id AND c.webhook_token_hash = p_token_hash
    UNION ALL
    SELECT v.tenant_id, v.user_id FROM phone_verifications v
     WHERE p_target = 'verification' AND v.id = p_id AND v.webhook_token_hash = p_token_hash
  $$;

REVOKE ALL ON FUNCTION telephony_webhook_target(text, uuid, bytea),
  evidence_artifacts_recording_consent() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  call_sessions, call_turns, do_not_call, phone_verifications
  TO jarvis_app;
GRANT EXECUTE ON FUNCTION telephony_webhook_target(text, uuid, bytea) TO jarvis_app;
