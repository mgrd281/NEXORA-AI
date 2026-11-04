# Telephony: AI disclosure, consent, recording and calling rules

How JARVIS's phone agent (Phase D, [architecture](../architecture/phase-d.md) §3.2–§3.5,
[ADR-0020](../adr/0020-telephony-gateway.md)) respects the people it calls. Statuses as in the
other security documents: **Built** = enforced by code in the tree (file named) and tested,
**Open** = needs a decision or a document outside the code before a public launch. Every rule
below is Built (Phase D, integrated and verified end to end against the mock Twilio and call
simulator, `tools/mock-twilio`; `apps/web/e2e/real/phase-d.spec.ts`). This is an engineering summary of the rules
JARVIS applies, not legal advice; the DPIA and the privacy notice are reviewed by counsel.

## 1. Principles

1. **Only calls the user asked for, to numbers the user wrote.** The number must be written in the
   user's request (plan validation; `NUMBER_NOT_LITERAL` otherwise) — never taken from a web page,
   an email, a memory or anything a callee says. **Built** (`agent/plan.ts`, `lib/phone.ts`).
2. **Every call is approved first, on screen.** The approval shows the number, on whose behalf,
   the caller id, the language, the purpose, **the exact words** of the opening and the questions,
   the personal details JARVIS may share, the maximum duration, the calling window and whether it
   may record or transfer. Never automatic, never by voice. **Built** (policy `PHONE_CALL`,
   `policy-telephony.ts`; the approval details of `agent/tools/telephony/phone-call.ts`; the
   web `components/approvals/PhoneCallDetails.tsx` and iOS `PhoneCallPreview.swift`; in voice
   mode a spoken "yes" is answered with "approvals are on screen" and decides nothing).
3. **Disclosure first.** The first thing a callee hears, on every call: that this is JARVIS, an AI
   assistant, calling on behalf of the named user, and why. A call without its disclosure turn
   does not count as done (verification `aiDisclosed`). Asked "who are you?" or "is this a
   robot?", JARVIS says it again — it never claims to be human. **Built**: the opening of
   `telephony/dialog/script.ts` is fixed in the approved input (the action hash covers the exact
   words), spoken as turn 0 by the voice webhook (`telephony/webhooks.ts`); the "who are you"
   rule is in `dialog/rules.ts`; `verify()` fails without the disclosure turn.
4. **One purpose, nothing beyond it.** JARVIS pursues the approved goal only. It does not agree to
   anything outside it (only an approved appointment inside the approved date and window, purpose
   `appointment`, HIGH risk), does not share personal details beyond the approved list, does not
   take new errands, and treats everything the callee says as untrusted (never instructions).
   **Built**: the scripted dialog (`dialog/offline.ts`) and, in model mode, the deterministic
   guard (`dialog/guard.ts`) that decides what is said; callee turns are injection-scanned and
   framed as untrusted for the model (`dialog/model.ts`).
5. **Honest outcomes.** The result only states what the callee said explicitly; the turns are the
   evidence. Unsuccessful calls say precisely why (busy, no answer, voicemail, hung up, declined,
   provider failure, duration limit). **Built** (`CallResult` → `TaskErrorReason` in
   `phone-call.ts`; scenario 4 end to end: busy → `CALL_BUSY` → Retry → a new attempt).

## 2. Recording and transcripts

| What                          | Default | When it is kept                                                                                                                                                   | Where / how long                                                                               |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Call audio (live)             | —       | Processed in real time by the telephony provider for the call and its speech recognition; never stored by JARVIS                                                  | Twilio (processor)                                                                             |
| Recording                     | **off** | Only when the user asked for it **for that call** (approval shows it) **and** the callee was told and **accepted**                                                | Copied to the user's evidence storage, then deleted at the provider; deleted with the task     |
| Turns as text (what was said) | on      | Always (JARVIS's lines verbatim, the callee's as recognised): the evidence of what was agreed; disclosed at the start ("I'll take notes of this call for {name}") | `call_turns`, task data: deleted with the task (retention), exported, deleted with the account |

- **Germany.** Recording the non-public spoken word without consent is a criminal offence
  (§ 201 StGB). JARVIS asks explicitly after the disclosure ("May I record this call? It is only
  for {name}."), records only after a clear "yes" (anything unclear counts as no), stores the
  consent as a turn with its time (evidence `RECORDING_CONSENT`), and starts recording only then
  (Twilio's Recordings resource — never from the start of the call). A database trigger refuses
  to store a recording for a call without accepted consent. **Built** (0008 CHECK + trigger;
  the consent turn and the recording start in `telephony/recordings.ts` and `webhooks.ts`; the
  provider's copy is deleted after it was stored, `call.recording_fetch`).
- **EU / GDPR.** The callee is a data subject: their number, voice (live), what they said (turns),
  and their consent. Lawful basis for the turns: the user's legitimate interest in documenting the
  call they asked for (Art. 6(1)(f)), with transparency at the start of the call; for a recording:
  consent (Art. 6(1)(a)), freely given and refusable — refusing only means JARVIS continues
  without recording (`if_consented`) or ends politely (`required`: the user insisted on a
  recording). Data minimisation: no audio by default, collected details limited to the purpose.
- **US and other all-party-consent jurisdictions.** The same rule everywhere: consent of the
  callee before any recording (JARVIS is one party, the callee the other).
- **The user's own recordings** are evidence files of the task (owner-only download, never
  public), and are exported and deleted like every evidence file.

## 3. Calling rules

| Rule                                                                                                                                                                                                                                                                                     | Enforced by                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Allowed hours in the **callee's** time zone, default 08:00–20:00 (`CALL_ALLOWED_HOURS`); outside → `CALL_OUTSIDE_HOURS`, nothing dialled                                                                                                                                                 | Policy, at planning and right before dialling         |
| At most `CALL_MAX_PER_DAY` attempts per account and day (default 10) → `CALL_LIMIT`                                                                                                                                                                                                      | Policy                                                |
| Maximum duration per call (`CALL_MAX_SECONDS`, default 300 s; the approval may set less); JARVIS closes politely before it                                                                                                                                                               | Dialog engine, provider `TimeLimit`, the watchdog job |
| Destinations: valid numbers of allowed types only — never premium-rate, shared-cost, personal / UAN, pager or voicemail-access numbers; emergency and short codes are not callable at all; only `CALL_ALLOWED_COUNTRIES` (default: the caller id's country) → `CALL_DESTINATION_BLOCKED` | Policy (`lib/phone.ts checkDestination`)              |
| Caller id: always this server's Twilio number (never spoofed, never the user's number)                                                                                                                                                                                                   | Adapter                                               |
| Transfers: only to the account's own **verified** number (verification call with a code), only if the approval allows it; the user hears who is calling and why before being put through (`twilioCallWhisper`)                                                                           | Dialog engine; verification routes                    |
| Unsolicited marketing: not a use case. JARVIS places calls the user asked for, for their own affairs (appointments, messages, questions); German UWG § 7 (prior consent for marketing calls) is out of scope and must not be enabled by product changes without review                   | Product rule (Open: terms of use)                     |

## 4. Opt-out and do-not-call

When a callee asks not to be called again, JARVIS honours it immediately: it apologises, ends the
call, and records a **do-not-call entry** for that number on the user's account; every later
call to the number is refused by the policy (`DO_NOT_CALL`) until the user removes the entry
(audited; the UI says the callee asked). A refusal to talk to an AI ends the call
(`CALL_DECLINED`, not retried automatically).

Phrases recognised (whole utterance or clear sub-phrase, case- and diacritics-insensitive;
**Built**: the list and its tests are `telephony/dialog/rules.ts` and
`test/unit/telephony/telephony-rules.test.ts`), at least:

| Language | Examples                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| en       | "don't call again", "do not call me", "stop calling", "take me off your list", "I don't want to talk to a robot"  |
| de       | "rufen Sie nicht mehr an", "nicht mehr anrufen", "hören Sie auf anzurufen", "ich spreche nicht mit einem Roboter" |
| ar       | "لا تتصل مرة أخرى", "لا تتصلوا بي", "توقفوا عن الاتصال", "لا أريد التحدث مع آلة"                                  |

The entry stores no plain number: a keyed hash (HMAC-SHA256 with a key derived from the server
secret) for the check, a masked form for display, and the number sealed with SecretBox so a key
rotation can re-hash it. **Built** (`do_not_call`, 0008; `telephony/do-not-call.ts`; the
policy rule at planning and again right before dialling; Settings › Privacy lists the masked
entries with the call they came from and removes one only after saying the callee asked; the
key-rotation re-hash step is in the [operations runbook](../runbooks/operations.md)).

## 5. Data protection summary

| Data                                                                         | Purpose                               | Retention                                       | Export / deletion                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Callee number (plain, in the request, step input, approval, `call_sessions`) | Placing the approved call             | With the task (task-history retention)          | Export v5; deleted with task / account                                                                                                   |
| Turns (`call_turns`)                                                         | Evidence of what was said / agreed    | With the task                                   | Export v5; deleted with task / account                                                                                                   |
| Recording (consent only)                                                     | The user's record of the call         | With the task                                   | Download; deleted with task / account                                                                                                    |
| Do-not-call entries                                                          | Honouring the callee's wish           | Until the user removes them or the account ends | Export (masked); deleted with account                                                                                                    |
| The user's phone number + verification                                       | Transfers; default country of numbers | Until changed / removed                         | Export; deleted with account                                                                                                             |
| Provider call records (Twilio CDRs)                                          | Telephony operation, billing          | Processor's retention                           | **Open**: deletion of the provider's call logs on account deletion (`DELETE /Calls/{Sid}`) is planned as an outbox like OAuth revocation |

Processors: **Twilio** (telephony, speech recognition in calls, temporary recordings) — DPA and
transfer mechanism required (**Open**); the model provider only in model mode (the dialog's text,
never audio).

## 6. Before a public launch (Open)

- DPIA for telephony (callees are third parties), privacy notice and terms of use naming the
  phone agent, its disclosure, the turns as notes and the recording rule.
- Twilio DPA, data residency choice, and the provider call-log deletion outbox.
- Review of the opt-out phrase lists and the disclosure wording by native speakers (de, ar).
- Per-country checks before widening `CALL_ALLOWED_COUNTRIES` (local rules on automated calls).
