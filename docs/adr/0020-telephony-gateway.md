# ADR-0020: Telephony gateway — Twilio over REST, signed webhooks, exactly-once calls

- Status: Accepted
- Date: 2026-11-04
- Design: [Phase D architecture](../architecture/phase-d.md) §3.2–§3.6, §5;
  [telephony, consent and recording](../security/telephony.md)
- Amends: [permission model](../security/permission-model.md) (phone calls: MEDIUM / HIGH, always
  approved); the Phase 5 stance in [privacy](../security/privacy.md)

## Context

The phone agent places outbound calls for the user: it must disclose that an AI is calling and for
whom, pursue one approved goal in German, Arabic or English, collect what the callee says, transfer
or end the call when needed, and report a structured outcome with evidence — and an unsuccessful
call (busy, no answer, voicemail, hang-up, provider failure) must end with a precise reason and a
safe retry, never a duplicate call. Calls are driven by the provider calling back (webhooks), which
carry no session; they cost money and can be abused (toll fraud, harassment); what the callee says
is untrusted; recording conversations is regulated (in Germany a criminal offence without consent,
§ 201 StGB).

## Decision

- **Provider: Twilio, through its documented REST API and TwiML** — no SDK. The adapter
  (`modules/telephony/twilio`) creates calls (`Calls` resource with status callbacks, ring timeout,
  `TimeLimit`, async answering-machine detection), updates / fetches / lists them, and starts,
  fetches and deletes recordings; the dialog is TwiML (`<Say>`, `<Gather input="speech">` with the
  call's language, `<Dial>`, `<Hangup>`). The base URL is overridable only outside production, so
  the whole flow is proven against a local mock Twilio and call simulator that implements the same
  shapes and **signs its webhooks exactly like Twilio** (`tools/mock-twilio`). A `TelephonyGateway`
  seam keeps another provider possible.
- **Webhooks are a separate, unauthenticated route group authenticated by the provider's
  signature.** `X-Twilio-Signature` (HMAC-SHA1 with the auth token over the full public URL —
  rebuilt from `PUBLIC_WEBHOOK_BASE_URL` — and every form parameter, sorted) is checked before
  anything else; then the account id; then a per-call URL token (32 random bytes, stored hashed)
  which is also the only way into the call owner's RLS context, through a SECURITY DEFINER
  function returning ids only. Replays and reordering are harmless: status callbacks are applied
  by sequence and age, gather answers by turn sequence in the signed URL, ended calls accept
  nothing after a grace period.
- **The dialog runs in the API process on webhooks.** Scripted (deterministic, offline) for
  structured goals — deliver a message and record the reply, ask for availability on a date and
  extract times by rules, ask the user's questions — or model-driven within the approved purpose
  (structured decisions behind a deterministic guard: no commitments outside an approved
  appointment window, no personal data beyond the approved list). The opening always discloses
  the AI and the user first; the words are fixed in the approved input (the step's script), so the
  approval's action hash covers them.
- **Exactly once per attempt.** Each attempt is a `call_sessions` row inserted before the provider
  is asked (unique key and `(step, attempt)`); a retry dials a new attempt only after the previous
  one definitely ended; a create request whose outcome is unknown makes the step `OUTCOME_UNKNOWN`
  (`CALL_STATE_UNKNOWN`) and an acknowledged retry reconciles with the provider (webhooks of that
  call, the provider's call list) before dialling again. A watchdog job ends overdue calls and
  reconciles missed callbacks.
- **The Policy Engine decides every call** (`policy-telephony.ts`, restrict-only): telephony
  configured, a valid number of an allowed type and country (never premium-rate / shared-cost;
  default: the caller id's country only), not on the do-not-call list, inside the allowed hours of
  the callee's zone, under the daily limit — then always an approval (`PHONE_CALL`, never
  automatic; `CALL_RECORDING`, `CALL_PERSONAL_INFO`; HIGH and `BINDING_COMMITMENT` for
  appointments). The number must be written in the user's request (plan validation).
- **Consent and minimisation.** Recording off by default; only with the user's request for that
  call and the callee's spoken consent (stored as a turn and evidence; a database trigger refuses a
  recording without it); recordings are copied into the user's evidence storage and deleted at the
  provider. The turns are kept as task data (the evidence of what was agreed), deleted with the
  task. Opt-outs create a do-not-call entry (keyed hash, masked display, sealed number for key
  rotation). Transfers only to the account's own verified number, which first hears who is
  calling and why (`<Number url>` → the `twilioCallWhisper` webhook, added in stage 3; a hang-up
  there bridges nobody).

## Consequences

- A new processor (Twilio) receives callee numbers, call audio in real time, recognised speech,
  and — only with consent — a recording until it is copied and deleted. A DPA and the privacy
  notice must name it ([telephony](../security/telephony.md)); call detail records remain with the
  processor under its retention.
- The API process serves model calls for the model dialog (`AppDeps.modelAdapter`), metered under
  each user's budget; webhook latency bounds model use (fallback to the scripted line).
- Speech recognition quality on calls (8 kHz audio, accents, Arabic dialects) limits what is
  understood; low-confidence answers are confirmed, and the outcome only claims what was said
  explicitly.
- A worker crash mid-call surfaces as `OUTCOME_UNKNOWN` for the step even though the call
  continued; the acknowledged retry adopts the finished call's outcome (never re-dials).

## Alternatives considered

- **Twilio SDK.** Rejected for now: a large dependency for a handful of form-encoded requests;
  the signature algorithm is small and tested against Twilio's own vector.
- **Media streams + a realtime voice model.** More natural turn-taking, but audio would flow
  through the model provider and the approval could no longer bind the words; deferred.
- **Placing calls from the API on approval.** Rejected: calls are task steps so policy re-checks,
  evidence, retries and exactly-once semantics are the runtime's.
- **Unsigned webhooks with secret URLs only.** Rejected: URLs leak (logs, proxies); the provider
  signature is the documented control, the URL token is defence in depth.
