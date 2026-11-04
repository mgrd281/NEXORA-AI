# Skill: phone-calling

| Field   | Value                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `phone-calling`                                                                                                                                            |
| version | 0.1.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                          |
| status  | Implemented (Phase D) — outbound calls through the telephony gateway (Twilio); available where Twilio is configured (`TELEPHONY_NOT_CONFIGURED` otherwise) |
| tools   | `phone.call` (1.0.0); uses `assistant.clarify`                                                                                                             |

Design: [Phase D §3.2–§3.6](../architecture/phase-d.md#32-phone-agent-phonecall-t),
[ADR-0020](../adr/0020-telephony-gateway.md), [telephony, consent and recording](../security/telephony.md).
Code: tool `apps/api/src/modules/agent/tools/telephony/phone-call.ts`; offline intents
`apps/api/src/modules/agent/intents/telephony/calls.ts`; gateway, attempts, dialog engine and
webhooks `apps/api/src/modules/telephony/**`; jobs `apps/api/src/modules/agent/jobs/telephony/`;
mock Twilio + call simulator `tools/mock-twilio/`.

## Description

Places **one** outbound call the user asked for, to a number the user wrote, for one approved goal
— deliver a message and record the reply, ask which times are free on a date, ask the user's
questions, or (with a model, HIGH risk) agree an appointment inside an approved window. The first
thing the callee hears is that this is JARVIS, an AI assistant calling on behalf of the user, why it
calls and that it takes notes. The call runs in German (formal "Sie"), Arabic (MSA) or English. The
outcome is structured (result, collected times / reply / answers / appointment) and backed by the
turns of the call as evidence.

## Input / output

```ts
phone.call {
  to /* E.164, literal from the request */, calleeName?, language /* en | de | ar */,
  calleeTimeZone? /* bind: the account's zone */, purpose /* message | availability | questions | appointment */,
  goal, message?, questions?, date?, window? /* HH:MM–HH:MM */, shareInfo? /* exactly what may be shared */,
  maxDurationSeconds /* ≤ CALL_MAX_SECONDS */, recording /* off | if_consented | required */,
  voicemail /* hang_up | leave_message */, allowTransfer, dialog /* bind: model only with a model */,
  script /* bind: the exact words, covered by the approval's action hash */
}
→ { callId, callSid, attempt, result, goalReached, text, date, times, appointmentDate, appointmentTime,
    reference, reply, answers, notes, suspectedInjection, injectionSignals, durationSeconds,
    disclosure, consent, recorded, turns, transfer }
```

Offline intents (en/de/ar):

| Request                                                                                                                                             | Plan                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "call +49 30 1234567 and ask if they have an appointment on Friday [between 9 and 12]" / "Ruf … an und frag, ob …" / "اتصل بالرقم … واسأل إن كان …" | `phone.call` purpose `availability` (date by the Phase C date rules, window)               |
| "call the front desk at +44 … and tell them I will be 10 minutes late" / "… und sag ihnen, dass …" / "… وقل لهم إن …"                               | `phone.call` purpose `message`                                                             |
| "call +44 … and ask: Do you still have the blue sofa? How much is delivery?"                                                                        | `phone.call` purpose `questions` (at most 5)                                               |
| no number written (or a national number without the account's own number)                                                                           | `assistant.clarify ['phone_number']`                                                       |
| a number and nothing to say or ask                                                                                                                  | `assistant.clarify ['call_goal']`                                                          |
| book / move / cancel an appointment by phone                                                                                                        | honest `OFFLINE_UNSUPPORTED` (binding: needs the model and its guard)                      |
| "… in German / auf Englisch / بالعربية"                                                                                                             | that call language                                                                         |
| "you can give them my name", "record the call", "leave a message if nobody answers", "put them through to me"                                       | `shareInfo` [name], `recording: if_consented`, `voicemail: leave_message`, `allowTransfer` |

## Permissions and risk

- No connection; needs the telephony gateway (`needsTelephony`: hidden from the model planner
  without it; the policy denies offline plans with `TELEPHONY_NOT_CONFIGURED`).
- Risk `MEDIUM`; `HIGH` + `BINDING_COMMITMENT` for purpose `appointment`.
- Policy (`policy-telephony.ts`, at planning and on the resolved input right before dialling, and
  again inside the attempt's transaction): `CALL_DESTINATION_BLOCKED` (invalid, premium-rate /
  shared-cost / personal / UAN / pager / voicemail-access numbers, countries outside
  `CALL_ALLOWED_COUNTRIES`), `DO_NOT_CALL`, `CALL_OUTSIDE_HOURS` (callee's zone),
  `CALL_LIMIT` (attempts per day) deny; otherwise always an approval `PHONE_CALL`
  (+ `CALL_RECORDING`, `CALL_PERSONAL_INFO`) — tap / click only, never by voice.
- Approval kind `phone_call`: the number (E.164 and readable), country, callee name, on whose
  behalf, caller id, language, purpose, goal, **the script verbatim**, dialog mode, date / window,
  every shared detail, maximum duration, calling hours of the callee's zone, recording, voicemail,
  transfer target (masked, verified only), binding, cost estimate.

## Cost limits

The provider's real price of each attempt is recorded (`cost_records` category `telephony`, and the
call's `price`); the approval shows `CALL_PRICE_PER_MINUTE_USD × ⌈max minutes⌉` when configured.
The model dialog (only for calls approved with dialog `model`) is metered under the user's AI budget
(balanced tier, a few short structured decisions). Durations: `CALL_MAX_SECONDS` caps every call,
Twilio's `TimeLimit` (+30 s) and the watchdog job bound it twice more.

## Execution policy

- Exactly once per attempt: the `call_sessions` row is committed before the provider is asked
  (unique key `call:<step>:a<n>` and `(step, attempt)`); a create request whose answer is lost
  makes the step `OUTCOME_UNKNOWN` (`CALL_STATE_UNKNOWN`); the acknowledged retry reconciles
  (a webhook of the call, or the provider's call list) before attempt n + 1 may dial.
- Webhooks: X-Twilio-Signature over `PUBLIC_WEBHOOK_BASE_URL` + path + query and every form
  parameter, the account id, the per-call URL token (hashed), sequence / timestamp / turn rules.
- Callee speech is untrusted: injection-scanned and flagged, never a source of numbers, amounts,
  recipients, steps or memories; requests for personal data or other errands are refused
  (`OUTSIDE_PURPOSE_REFUSED`); only `shareInfo` values are ever said; "who are you?" repeats the
  disclosure; a request for a person is put through only to the account's **verified** number.
- Opt-outs ("don't call again", "bitte nicht mehr anrufen", "لا تتصل مرة أخرى", refusals to talk
  to an AI) → do-not-call entry, apology, hang up (`CALL_DECLINED`, never retried automatically).
- Recording only with `recording` requested **and** the callee's clear yes (unclear = no); started
  after the consent turn; copied to evidence storage, then deleted at the provider.

## Verification criteria

`callConnected { callSid }`, `aiDisclosed` (fails without the opening turn — a call without its
disclosure never counts as done), `callEnded { result }`, `goalReached` / `detailsCollected { count }`,
`consentRespected { consent }`, `transcriptStored { turns }`.

## Error handling

| Result                                 | Step                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| busy / no answer / failed / voicemail  | FAILED `TOOL_FAILED` `CALL_BUSY` / `CALL_NO_ANSWER` / `CALL_FAILED` / `CALL_VOICEMAIL`, retryable (new attempt) |
| hung up before the goal                | `CALL_HUNG_UP`, retryable                                                                                       |
| duration limit before the goal         | `CALL_DURATION_LIMIT { seconds }`, retryable                                                                    |
| declined / opted out                   | `CALL_DECLINED`, not retryable                                                                                  |
| recording `required` refused           | `RECORDING_CONSENT_DECLINED`, not retryable                                                                     |
| provider refused / rate limited / down | `PROVIDER_REJECTED` / `PROVIDER_RATE_LIMITED` / `PROVIDER_UNAVAILABLE` (nothing placed), retryable              |
| provider answer lost                   | `OUTCOME_UNKNOWN` `CALL_STATE_UNKNOWN` (acknowledge, then the retry reconciles)                                 |
| task cancelled during the call         | closing line + hang up (or cancelled while ringing); step and task CANCELLED                                    |

## Test cases

Unit (`apps/api/test/unit/telephony/`): rules (opt-out / refusal / person / identity / consent /
times en/de/ar), scripts (disclosure first), the scripted dialog and outcomes, the guard, the tool
(intents, literalness, bind, approval, policy, verification, step errors). Integration with real
Postgres, the app's webhooks and the mock Twilio + simulator
(`apps/api/test/integration/telephony/`): the German availability call end to end, scenario 4
(busy → retry → completed) and every unsuccessful result, crash after the call (never a second
dial), lost create answer → reconcile, the watchdog, forged / replayed / stale / wrong-account /
wrong-token webhooks, calling hours, opt-out → do-not-call → refused, injection, transfer to a
verified number only (the user hears who is calling and why first — the transfer whisper — and a
replayed or foreign whisper bridges nobody), recording only with consent, Arabic and English
calls, cancellation while ringing (the step and the task end CANCELLED), cross-tenant isolation,
phone verification (and resuming it), export v5, model mode behind the guard. Real stack
(`apps/web/e2e/real/phase-d.spec.ts`): the call from the approval sheet to the collected times,
scenario 4 (busy / no answer → Retry), a forged webhook refused, do-not-call, and a voice
conversation that places a call only after a click. Evals: suite `telephony` (18 offline
scenarios), `spec-03` (offline), `spec-03-phone-call-model`, and `spec-04-unsuccessful-phone-call`
(offline + pipeline: busy → FAILED `CALL_BUSY` → retry → COMPLETED, two calls in all).
