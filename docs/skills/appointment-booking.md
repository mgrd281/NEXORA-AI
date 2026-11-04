# Skill: appointment-booking

| Field   | Value                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `appointment-booking`                                                                                                                                                                                             |
| version | 0.1.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                                                                 |
| status  | Implemented (Phase C) — booking on **supported sites** through the isolated browser agent (recipes); meetings with people through the calendar ([calendar-management](calendar-management.md)). By phone: Phase D |
| tools   | `booking.find_slots` (1.0.0), `booking.book` (1.0.0), `browser.fill` (1.0.0); uses `calendar.create_event`, `calendar.free_busy`, `assistant.clarify`; planned: `phone.call`                                      |

Design: [Phase C §3.4](../architecture/phase-c.md#34-booking-scenario-1), [ADR-0017](../adr/0017-browser-agent-isolation.md),
[ADR-0018](../adr/0018-commerce-safety.md). Code: `apps/api/src/modules/agent/tools/browser/booking-*.ts`,
`browser-fill.ts`, recipes in `apps/api/src/modules/browser/sites/`, exactly-once rows in
`apps/api/src/modules/commerce/bookings.ts`.

## Description

Books an appointment (scenario 1) on a site JARVIS supports through a reviewed recipe — in this
build the local **Fixture Dental** site (`fixture-booking`, development/test only). Availability is
read live from the site with a screenshot; the booking is submitted once, after the user approves
the exact slot and every detail sent; the confirmation (reference, schema.org `Reservation`, ICS
file) is read from the site and kept as evidence. Sites without a recipe are honestly
`SITE_UNSUPPORTED`. Meetings with other people (free/busy, invitations) are the calendar skill's.

## Input / output

```ts
booking.find_slots { siteId, service /* as the user named it */, from?, to? /* YYYY-MM-DD */, at? /* HH:MM local */ }
  → { result: BookingSlots, text, slotCount, firstSlot: BookingOffer | null, firstSlotId, firstSlotStart }
booking.book { siteId, slot: '{{s1.firstSlot}}' /* reference only */, details: { [label]: value } }
  → { bookingId, reference, title, start, end, timeZone, location /* frozen: calendar.create_event refs */,
      confirmation: BookingConfirmation, icsArtifactId }
browser.fill { siteId, form /* e.g. 'contact' */, fields: { [label]: value } } → { submitted, reference }
```

Offline intents (en/de/ar, `apps/api/src/modules/agent/intents/browser/booking.ts`):

| Request                                                                                                                                                                       | Plan                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "find free appointments at Fixture Dental [for a cleaning]", "book a check-up at Fixture Dental"                                                                              | `booking.find_slots` (lists the live slots and the details the form needs)                                                                                                           |
| "book a check-up at Fixture Dental on 2026-11-12 at 10:00 for Alex Example, phone +49 30 1234567" / "Buche … am 12. November um 10 Uhr für …" / "احجز … غدا الساعة 10 باسم …" | `booking.find_slots {from, to, at}` → `booking.book {slot: {{s1.firstSlot}}, details}` (→ `calendar.create_event` from the booking's output when a calendar grants `calendar.write`) |
| name or phone not written                                                                                                                                                     | `assistant.clarify ['contact_details']`; the answer ("Alex Example, +49 …") completes it                                                                                             |
| a time without a date                                                                                                                                                         | `assistant.clarify ['date_time']`                                                                                                                                                    |
| "book an appointment at the dentist" (no supported site)                                                                                                                      | `assistant.clarify ['site']`                                                                                                                                                         |

Name and phone come only from the user's words; the email is the account's unless the user wrote one.

## Permissions and risk

- Connection: **Web access** (`web`); a browser worker must be running (`BROWSER_UNAVAILABLE`
  otherwise — the tools are hidden from the model planner, offline plans fail at execution).
- `booking.find_slots`: `LOW`, read-only. `booking.book`: `MEDIUM`; `HIGH` + `BINDING_COMMITMENT`
  when the site says it is binding; a price makes it a purchase — the monthly purchase limit applies
  (`PURCHASES_DISABLED` while it is 0, `PURCHASE_LIMIT`, `PURCHASE_CURRENCY`; otherwise approval
  `PURCHASE`). `browser.fill`: `MEDIUM` (`HIGH` when the recipe declares the form a commitment).
- Approvals: kind `booking` (slot as the site offered it, every field with its value and whether it
  is personal, price, binding, cancellation terms, screenshot id) and `form_submission`.

## Cost limits

No model cost. One browser session per read / booking (≤ 90 s, 20 page loads, 400 requests, 10
evidence files — `BROWSER_LIMITS`); at most 2 sessions per user at once.

## Execution policy

- The slot is never written by the planner: `slot` must be a reference to `booking.find_slots`
  output, and before booking the tool checks it against that session's recorded live read.
- The bookings row (key `booking:<step id>`, also the site's `Idempotency-Key`) is inserted before
  submitting; the browser worker records the outcome from the site's answer.
- Right before submitting, the booking form is re-read: a slot taken meanwhile → `SLOT_TAKEN`,
  nothing booked, the other free times the site shows are offered again (error message and the
  session's result).
- CAPTCHA / login wall / bot protection → the session is handed over (`handover_url`), never bypassed.

## Verification criteria

A confirmation reference read from the site's confirmation (`Reservation` JSON-LD), the confirmed
start equal to the approved slot, a screenshot (and the ICS file when the site links one) stored as
evidence (`BOOKING_CONFIRMATION`, `SCREENSHOT`, `ICS_FILE`).

## Error handling

| Condition                                                       | Result                                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No free slot in the window the user named                       | `NO_FREE_SLOTS` (the booking step does not run)                                                                                        |
| Slot taken between reading and booking                          | `SLOT_TAKEN`, booking row `failed`, alternatives offered, not retryable                                                                |
| A required detail missing at the site                           | `BOOKING_DETAILS_MISSING { fields }`                                                                                                   |
| Submitted, no confirmation shown / interrupted after submitting | `OUTCOME_UNKNOWN` `BOOKING_UNCONFIRMED`, row `unknown`; an acknowledged retry looks the key up on the site first and never books twice |
| CAPTCHA / login / bot wall                                      | `CAPTCHA_DETECTED` / `LOGIN_REQUIRED` / `BOT_PROTECTION` `{ host }` — continue on the site                                             |
| Site not supported / recipe not enabled                         | `SITE_UNSUPPORTED { host }`                                                                                                            |

## Test cases (implemented)

`apps/api/test/integration/commerce/booking.int.test.ts` (real Chromium + Postgres + fixture site):
live slots → approval → booked once with reference + ICS evidence; slot taken meanwhile →
`SLOT_TAKEN` + re-offer; a taken slot is never offered (`NO_FREE_SLOTS`); missing details asked and
answered; no confirmation → `BOOKING_UNCONFIRMED`; a paid booking refused while purchases are off,
`HIGH` + `BINDING_COMMITMENT` + `PURCHASE` within the limit. `test/integration/browser/model-plans.int.test.ts`:
`browser.fill` approval and single submission; an invented slot from a model plan is refused.
Offline evals: `apps/api/evals/scenarios/booking/` (10 scenarios, en/de/ar).
