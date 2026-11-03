# Skill: task-scheduling

| Field   | Value                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| id      | `task-scheduling`                                                                                                        |
| version | 0.0.1 (draft)                                                                                                            |
| status  | Planned — Phase 2. The `scheduled_tasks` table (`rrule`, `time_zone`, `next_run_at`) exists but is unused in Milestone 1 |
| tools   | planned: `schedule.create`, `schedule.list`, `schedule.update`, `schedule.delete`                                        |

## Description

Runs a request later or repeatedly ("every Monday at 8, summarise this page and email it to me";
"remind me tomorrow at 9"). Each run creates a normal task (`source: schedule`) that goes through
planning, policy and approval like any other.

## Input / output sketch

```ts
scheduleCreate: { title: string; request: string; rrule: string /* RFC 5545 */; timeZone: string;
                  startAt?: string; endAt?: string }
→ { scheduleId, nextRunAt }
```

## Permissions and risk

- Creating a schedule: `MEDIUM` (future autonomous runs); approval shows the request, recurrence in
  words, next three run times and what will need approval at run time.
- Each run's steps are evaluated by the policy at run time; a schedule never pre-approves side
  effects. Autonomy rules (e.g. email to self) apply as for interactive tasks.

## Cost limits

Each run is costed and counted against the monthly budget; schedules pause automatically when the
budget is exhausted; per-user cap on active schedules (planned: 20).

## Execution policy

Durable timers: Postgres queue `run_at` for the alpha; move to Temporal when the migration criteria
in [ADR-0004](../adr/0004-postgres-job-queue.md) are met. Missed runs (downtime) run once on
recovery, not once per missed occurrence.

## Verification criteria

`next_run_at` computed in the user's time zone across DST; each run links to its task; run history
visible.

## Error handling

Invalid `rrule` → validation error; repeated failures (3 runs) → schedule disabled with a
notification; approval not given before the next run → that run expires.

## Test cases

1. Weekly schedule across a DST change → correct local time.
2. Run requiring approval while the user is away → approval expires, next run unaffected.
3. Budget exhausted → schedule paused, user notified.
