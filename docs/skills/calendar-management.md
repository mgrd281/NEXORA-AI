# Skill: calendar-management

| Field   | Value                                                                                                                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `calendar-management`                                                                                                                                                                                                                                                                  |
| version | 0.1.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                                                                                                                                      |
| status  | Implemented (Phase C) — Google Calendar API v3 and Microsoft Graph calendars via OAuth: read events, free/busy and proposed meeting times, create / update / cancel events with approval, Home "Upcoming". Switchable.                                                                 |
| tools   | `calendar.list`, `calendar.free_busy`, `calendar.create_event`, `calendar.update_event`, `calendar.cancel_event` (1.0.0) — `apps/api/src/modules/agent/tools/integrations/calendar-*.ts`, clients `apps/api/src/modules/integrations/{google/calendar.ts,microsoft/graph-calendar.ts}` |

## Description

Answers "what's on my calendar", finds times when the user and the people they name are free, and
creates, changes or cancels events — always showing exactly what will be written and who is told.
Meeting booking (scenario 1a): "find a time to meet bob@example.org on Tuesday" proposes mutual free
times; the follow-up "book Tuesday 10:30" creates the event and the provider sends the invitations
after approval. Booking-site appointments are the appointment-booking skill.

## Input / output sketch

```ts
calendar.list { provider?, from?, to?, days ≤ 62, query?, limit ≤ 50, timeZone? }
  → { text, events: CalendarEvent[], count, firstEventId, firstEventEtag, firstEventTitle, firstEventStart, firstEventEnd }
calendar.free_busy { provider?, attendees: literal[], from, to (≤ 14 days), durationMinutes, timeZone?, workdayStart?, workdayEnd? }
  → { result: FreeBusyResult, text, slotCount, firstSlotStart, firstSlotEnd }
calendar.create_event { provider?, title, start, end, timeZone?, allDay?, location?, description?,
                        attendees: literal[], allowConflict?, sourceBookingId? } → { eventId, webLink, start, end }
calendar.update_event { provider?, eventId, etag?, title, start, end, …, attendees: literal[], notifyAttendees?, previous? } → { eventId }
calendar.cancel_event { provider?, eventId, etag?, title, start, end, attendees: literal[], notifyAttendees? } → { eventId }
```

Times are ISO instants with offset, or local `YYYY-MM-DDTHH:MM` resolved in the step's `timeZone`
(bound at planning to the account's zone unless the user names one).

## Permissions and risk

- Capabilities: `calendar.read` (Google `calendar.events.readonly` + `calendar.freebusy`; Graph
  `Calendars.Read`), `calendar.write` (Google `calendar.events`; Graph `Calendars.ReadWrite`). Never
  the full `calendar` scope.
- Reads LOW. Create / update / cancel MEDIUM (create HIGH above 10 attendees), approval kind
  `calendar_event` with title, instants, zone, all-day, place, description, every attendee and
  whether they are told; anyone but the owner adds `RECIPIENT_EXTERNAL` (`MANY_RECIPIENTS` > 3).
- Attendees and free/busy addresses are literal from the user's own requests (plan validation);
  never from invitations, mail, pages or results.

## Cost limits

No model cost. Provider quotas: 429 → `PROVIDER_RATE_LIMITED`.

## Execution policy

- Events are read live (nothing is stored); Home "Upcoming" asks every `calendar.read` connection in
  parallel within `CALENDAR_LIMITS.homeTimeoutMs`, each source reporting ok / expired /
  scope_missing / unavailable, cached in memory for 60 s per connection.
- Time zones: instants in UTC, each event keeps its zone (Graph Windows ids mapped to IANA with the
  CLDR table); proposals and local times are computed in the zone with Intl (DST-correct).
- Free/busy: Google `freeBusy.query` / Graph `getSchedule`; a calendar the provider does not share is
  reported and never assumed free; proposals within working hours (Mon–Fri, 08:00–18:00 in the zone),
  on 15-minute steps, at most 5, non-overlapping.
- Before writing: free/busy of the account is re-checked — busy → `CALENDAR_CONFLICT`, nothing
  written (unless `allowConflict`, shown in the approval). Updates and cancellations send the etag /
  changeKey read earlier (If-Match → `EVENT_CHANGED`) and refuse when the event has attendees that
  were not in the approval.
- Exactly once: Google events get an id derived from the idempotency key (a retried insert answers
  409 and the existing event is read); Graph events carry `transactionId` and a tagged extended
  property, looked up before creating.

## Verification criteria

The provider's event id (`eventWritten`), times as written equal to the approved ones (in the
event's zone), `noConflict` when checked; free/busy: `slotsFound`. Evidence `CALENDAR_EVENT
{ provider, eventId, action }`, `FREE_BUSY { provider, calendars, slots }`.

## Error handling

| Condition                                   | Code / reason                                                                                    | Retryable | Notes                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------- | ---------------------------------- |
| No calendar connection / expired / no scope | `CONNECTION_REQUIRED` / `CONNECTION_MISSING` · `CONNECTION_EXPIRED` · `CONNECTION_SCOPE_MISSING` | yes       | Policy denies before anything runs |
| Time already busy                           | `TOOL_FAILED` / `CALENDAR_CONFLICT { count }`                                                    | yes       | Nothing written                    |
| Event changed since it was read             | `TOOL_FAILED` / `EVENT_CHANGED`                                                                  | no        | Nothing written                    |
| Event gone                                  | `TOOL_FAILED` / `EVENT_NOT_FOUND`                                                                | no        |                                    |
| Nobody free in the window                   | `TOOL_FAILED` / `NO_FREE_SLOTS`                                                                  | yes       | Ask with another window            |
| Window invalid / too long                   | `TOOL_FAILED` / `INVALID_TIME_RANGE`                                                             | no        |                                    |
| 429 / 5xx                                   | `PROVIDER_RATE_LIMITED` / `PROVIDER_UNAVAILABLE`                                                 | yes       | Reads retried automatically        |

## Offline planner (en / de / ar)

"what's on my calendar [today | tomorrow | this week]" / "welche Termine habe ich morgen" / "ما الذي
في تقويمي" → `calendar.list`; "find a time to meet <address> [for N minutes] <when>" / "finde einen
Termin mit …" / "ابحث عن وقت للقاء …" → `calendar.free_busy` (no window → asks `date_time`, no
address → asks `recipient`); the follow-up "book <day> <time>" after proposals →
`calendar.create_event` with the attendees of that request; "add <title> to my calendar on <day> at
<time>" → `calendar.create_event` (no time → asks). Known gap: the German "Was steht in meinem
Kalender …" is taken by the Phase B document intent ("was steht in …") before the domain intents
run (reported to the architect).

## Test cases (apps/api/test/{unit,integration}/integrations)

1. Home "Upcoming": null without `calendar.read`; Google + Microsoft merged by start; an expired
   source reported as `expired`, a slow one as `unavailable` within the timeout.
2. Create with approval: exact instants and zone (Europe/Berlin), written in the zone, verified.
3. Invitation to someone else: `RECIPIENT_EXTERNAL`, the provider records the invitation.
4. Busy time → `CALENDAR_CONFLICT`, nothing written; stale etag → `EVENT_CHANGED`.
5. Meeting booking end to end: free/busy proposals (an unshared calendar reported, not assumed
   free) → follow-up "Book Tuesday 10:30" → approval → event + invitations.
6. DST: working hours computed in the zone on change days; ambiguous / missing local times.
