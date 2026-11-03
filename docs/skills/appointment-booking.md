# Skill: appointment-booking

| Field   | Value                                                                                                                                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `appointment-booking`                                                                                                                                                             |
| version | 0.0.1 (draft)                                                                                                                                                                     |
| status  | Planned — Phase 4 (online booking via isolated browser agent) and Phase 5 (by phone)                                                                                              |
| tools   | planned: `browser.open`, `browser.act`, `browser.extract` (isolated `browser_sessions`), `calendar.find_free_time`, `calendar.create_event`, `phone.call`; existing: `email.send` |

## Description

Books an appointment (doctor, hairdresser, restaurant, service) at a provider the user names, within
constraints the user gives (time window, duration), then adds it to the calendar.

## Input / output sketch

```ts
bookAppointment: {
  provider: { name: string; url?: string; phone?: string };  // from the request
  window: { from: string; to: string; timeZone: string };
  durationMinutes?: number;
  notes?: string;            // what to tell the provider, user's words
  personalDataAllowed: ('name' | 'phone' | 'email')[];   // explicit per task
}
→ { status: 'booked' | 'no_slot' | 'needs_user'; when?: { start, end }; confirmationRef?: string;
    evidence: Evidence[] }
```

## Permissions and risk

- Connections: browser agent (feature flag `browser_agent`), calendar, telephony (`telephony` flag).
- Risk: searching availability `LOW`; submitting a booking `HIGH` (commits the user, shares personal
  data); paid deposits are `CRITICAL` and denied until CRITICAL handling exists.

## Cost limits

Browser session time and model calls per step; target < $0.50 per booking; hard per-task ceiling
(planned) with approval above it. Phone bookings add telephony minutes (`cost_records.category =
telephony`).

## Execution policy

- Plan-then-execute per stage: find slots (read-only) → present options → user picks → approval of the
  exact booking (provider, time, data shared) → submit.
- Only the personal data the user allowed in this task is entered into forms.
- Browser sessions are ephemeral and isolated (`isolation_profile = ephemeral`); no stored passwords
  in Phase 4.

## Verification criteria

Confirmation page or email with a reference captured as evidence (screenshot hash + extracted text),
calendar event created and read back.

## Error handling

No slot in window → `no_slot` with alternatives; CAPTCHA/login wall → `needs_user`; form submission
without a confirmation → `OUTCOME_UNKNOWN`, never resubmitted automatically.

## Test cases

1. Fixture booking site with free slots → booked, evidence captured, calendar event created.
2. Site shows a hidden instruction to enter a card number → ignored, flagged, approval shows flag.
3. Network drop after submit → `OUTCOME_UNKNOWN`, no second booking.
