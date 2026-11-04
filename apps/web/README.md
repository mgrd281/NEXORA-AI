# JARVIS web (`@jarvis/web`)

Next.js 16 App Router · React 19 · CSS Modules on Meridian tokens · TanStack Query 5.

```bash
pnpm --filter @jarvis/web dev            # http://localhost:3000 (API at API_ORIGIN, default http://127.0.0.1:4000)
pnpm --filter @jarvis/web typecheck | lint | test
NEXT_DIST_DIR=.next-foundation pnpm --filter @jarvis/web build
```

## Layout of `src/`

| Path                                                | What                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `app/layout.tsx`                                    | `<html lang dir data-theme>` from the `jarvis_locale` / `jarvis_theme` cookies, fonts |
| `app/(app)/layout.tsx`                              | Session-cookie check → `/sign-in?next=…`, then `<AppShell>`                           |
| `app/(app)/**/page.tsx`                             | Screens (placeholders until built)                                                    |
| `app/api/v1/events`                                 | Streaming SSE proxy to the API (`/api/*` is otherwise a rewrite)                      |
| `app/dev/components`                                | Component gallery (development only)                                                  |
| `components/ui`                                     | Meridian primitives                                                                   |
| `components/presence`                               | Presence ring + `presenceFromTask` / `deriveAssistantPresence`                        |
| `components/{composer,approvals,voice,tasks,shell}` | Shared feature components                                                             |
| `i18n`                                              | Catalogs (`messages/{en,de,ar}/<namespace>.ts`), `t()`, formatters                    |
| `lib/api`                                           | Typed client (`api.call`), `ApiError`, query keys (`qk`), shared hooks                |
| `lib/events`                                        | `EventStreamProvider`, `useStreamEvent`, `useAnswerStream`, invalidation map          |
| `proxy.ts`                                          | Per-request nonce CSP                                                                 |

## Rules of the road

- Copy only through `t('namespace.key', params)` (`useI18n()` / `useT()`; `getServerI18n()` on the
  server). Add a key to **all three** locales — `test/i18n-catalogs.test.ts` fails otherwise.
  Plurals: `{count, plural, one {# task} other {# tasks}}` (Arabic also needs zero/two/few/many).
- Logical CSS only (`margin-inline-start`, `inset-inline-end` …); tokens only (no raw hex).
  Type styles: `font: var(--text-body)` in modules or the `.t-body` utility classes.
- Server data only through React Query with keys from `lib/api/query-keys.ts`; realtime events
  invalidate those keys automatically.
- User content inside the interface: `<UserText>` (keeps the UI's direction and alignment, isolates
  the text); `dir="auto"` only where the text is the whole surface (an email body, an input). A
  truncating line takes `dir="auto"` itself (see TaskRow) so the ellipsis follows the text.
  `t()` wraps every interpolated string in FSI…PDI; URLs, emails, hashes go in `.ltr` spans.
- Icons only via `<Icon icon={…} />` (lucide), `mirror` for directional ones.

## Phase B screens (docs/architecture/phase-b.md)

| Feature                         | Where                                                                                                                    | Code                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Conversation thread + follow-up | Task detail: earlier requests above, “Since then” + follow-up field below the result                                     | `features/conversations/{Thread,model,api}`    |
| Conversation history            | Task Center › Conversations (`/tasks/conversations?q=`)                                                                  | `features/conversations/ConversationsScreen`   |
| Clarifying questions            | Task detail question panel (answer field inline, attach button for `document`); “Needs your answer” / “Answered” chips   | `Thread.tsx` `QuestionPanel`, `TaskStatusPill` |
| Attachments                     | Both composers (button, drag-and-drop, paste; progress; checks before upload), chips on tasks/turns, owner-only download | `features/attachments/*`                       |
| Skills                          | Settings › Skills (real availability, switches for toggleable skills only)                                               | `features/settings/SkillsSection`              |
| Schedules                       | Task Center › Scheduled (`/tasks/scheduled`): cards, run history, editor with server preview                             | `features/schedules/*`                         |
| Retention                       | Settings › Privacy (both), Memory (memories)                                                                             | `features/settings/RetentionControls`          |
| Time zones                      | Every zone picker offers exactly `GET /v1/meta/time-zones`                                                               | `features/settings/{TimeZoneSelect,timeZones}` |
| Webhooks                        | Connections › Developer (`/connections#developer`)                                                                       | `features/webhooks/*`                          |

**Why conversation history lives in the Task Center, not the sidebar.** Every request already
starts a conversation, and every task page shows its conversation (earlier turns above, later
turns and the follow-up field below), so the thread needs no screen of its own. History is a
second way to look at the same work, so it is a view of the Task Center next to Tasks and
Scheduled: the primary navigation keeps its five destinations (and phones keep a five-item tab
bar), and “Tasks” stays the one place for everything JARVIS did or will do. A history row opens
the conversation's newest task, i.e. the thread with its follow-up field.

Rules specific to these screens: a clarifying question is never shown as a failure or as
“Completed” (accent tone, “Needs your answer”; “Answered” once a later request in the same
conversation exists); file names, schedule requests and endpoint descriptions are user text
(`<UserText>` / `dir="auto"`); recurrences are phrased on the client from their fields
(`schedules/recurrence.ts`), occurrences come from the server (`previewSchedule`,
`ScheduleDetail.upcoming`) and are shown in the schedule's own zone; a webhook secret is held
only in the dialog's state and never cached or re-shown. Unit tests: `test/{conversations,
attachments,schedules}.test.ts`; visual + behaviour specs: `e2e/visual/phase-b.spec.ts`
(fixtures in `e2e/support/phase-b.ts`, validated against the contracts by `mock-api.ts`).

## Visual tests (mock API)

```bash
pnpm --filter @jarvis/web dev                                        # or build + start
PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @jarvis/web e2e:visual
```

`e2e/support/mock-api.ts` serves contract-validated fixtures (`e2e/support/fixtures.ts`) for every
`/api/v1/**` route; screenshots land in `test-results/screenshots/`.

## End-to-end tests (real stack)

`e2e/real/*` runs against the real API, worker, a fixture website and the dev mailbox when
`E2E_EMAIL` / `E2E_PASSWORD` are set (see the header of each spec for the environment):

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @jarvis/web e2e:real   # --workers=1
```

The specs share one account and one mailbox, so they run one file at a time (`--workers=1`).
`vertical-slice.spec.ts` covers Milestone 1 (plan → approval → verified email → history);
`phase-b.spec.ts` covers a follow-up ("email it to me"), a clarifying question and its answer, a
PDF upload with document summary and owner-only download, a schedule that fires exactly once, a
signed metadata-only webhook to a local receiver (`WEBHOOK_ALLOW_INSECURE_HOSTS`), a disabled
skill refused with the localized reason (en/de/ar) and the retention preference.
