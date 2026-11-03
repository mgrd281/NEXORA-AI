# Skill: calendar-management

| Field   | Value                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `calendar-management`                                                                                                                 |
| version | 0.0.1 (draft)                                                                                                                         |
| status  | Planned — Phase 4 (Google Calendar, Microsoft 365 via OAuth)                                                                          |
| tools   | planned: `calendar.list_events`, `calendar.find_free_time`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event` |

## Description

Answers "what's on my calendar", finds free slots, and creates, moves or cancels events — with the
exact event shown for approval before anything changes.

## Input / output sketch

```ts
listEvents: { from: string /* ISO */; to: string; calendarId?: string }
  → { events: { id, title, start, end, timeZone, attendees: string[], location?, isPrivate }[] }
findFreeTime: { from; to; durationMinutes: number; workingHoursOnly?: boolean }
  → { slots: { start, end }[] }
createEvent: { title; start; end; timeZone; attendees?: string[] /* literal, from request */;
               location?; description?; sendInvites: boolean }
  → { eventId, htmlLink, etag }
updateEvent / deleteEvent: { eventId; etag; changes? } → { eventId, etag }
```

## Permissions and risk

- Connection: `google_calendar` / `microsoft_calendar` (planned providers), OAuth scopes read-only
  for listing, read-write only when the user enables changes.
- Risk: list/find `LOW`; create/update without attendees `MEDIUM`; with attendees or invites `HIGH`;
  delete an event with other attendees `HIGH`.

## Cost limits

Provider APIs are free at our volume; model cost only for planning and natural-language summaries
(< $0.05 per request typical). Per-day change cap (planned: 20).

## Execution policy

- Event titles/descriptions from fetched or emailed content are untrusted; attendees must be literal
  addresses from the request.
- Approval shows title, start/end with time zone, attendees, whether invites are sent.
- Optimistic concurrency with provider `etag`; idempotency via `once_per_step` and provider request ids.

## Verification criteria

Read back the event after create/update (id, start, end, attendees match the approved input); for
delete, a `404`/cancelled status on read-back.

## Error handling

Expired OAuth token → connection `expired`, `CONNECTION_REQUIRED`; `etag` conflict → re-plan with
fresh data and new approval; provider 5xx → retry reads only; ambiguous write → `OUTCOME_UNKNOWN`.

## Test cases

1. "What do I have tomorrow?" across a DST change → correct local times.
2. Create event with an attendee not in the request → validation error.
3. Concurrent change → `etag` conflict handled, no double event.
4. Arabic request → titles kept as written, dates in the user's time zone.
