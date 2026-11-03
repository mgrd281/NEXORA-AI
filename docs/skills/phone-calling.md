# Skill: phone-calling

| Field   | Value                                                                  |
| ------- | ---------------------------------------------------------------------- |
| id      | `phone-calling`                                                        |
| version | 0.0.1 (draft)                                                          |
| status  | Planned — Phase 5 (behind feature flag `telephony`, seeded `false`)    |
| tools   | planned: `phone.call` (realtime voice agent over a telephony provider) |

## Description

Places an outbound call on the user's behalf for a narrow, stated goal (book, confirm, ask a simple
question), discloses that it is an AI assistant, and reports the outcome.

## Input / output sketch

```ts
phoneCall: {
  callee: { label: string; number: string /* E.164, from the request or a saved contact */ };
  goal: string;                 // one sentence, user's words
  allowedFacts: string[];       // what JARVIS may say about the user
  language: 'en' | 'de' | 'ar';
  maxMinutes: number;           // default 5
}
→ { status: 'completed' | 'no_answer' | 'declined' | 'failed'; outcome: string;
    aiDisclosed: true; recordingConsent: boolean; durationSeconds: number; costMicro: number }
```

Stored in `call_sessions` (callee number encrypted, `ai_disclosed`, `recording_consent`).

## Permissions and risk

- Connection: telephony provider (planned), verified caller id.
- Risk: `HIGH` for every call (speaks for the user to a third party). Emergency and premium-rate
  numbers: `CRITICAL`, denied.

## Cost limits

Per-minute telephony + realtime model cost; `maxMinutes` hard stop; costs under the monthly budget
(`cost_records.category = telephony`); approval shows the estimated maximum cost.

## Execution policy

- Approval before dialling shows callee, goal, allowed facts, max duration and cost.
- AI disclosure at the start of every call; no recording unless every party consents; no transcript
  stored without consent ([privacy](../security/privacy.md#call-recording-and-telephony-phase-5-stance)).
- The call agent cannot commit the user beyond the approved goal (no payments, no new agreements);
  anything else → "I will check with <name> and call back".

## Verification criteria

Call record with provider call id, duration, disclosure flag; outcome confirmed by the callee's
explicit statement captured in the structured outcome; follow-up calendar entry if booked.

## Error handling

No answer / voicemail → `no_answer` (no message left unless approved); callee declines AI calls →
`declined`, logged, not retried; provider failure mid-call → `OUTCOME_UNKNOWN` for any commitment.

## Test cases

1. Simulated callee consents → outcome stored, no audio stored without consent.
2. Callee asks for card details → refused, call ends politely, flagged.
3. Call to an emergency number → denied by policy.
