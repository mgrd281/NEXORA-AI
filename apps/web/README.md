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

## Phase C screens (docs/architecture/phase-c.md §3.9)

| Feature            | Where                                                                                                                                        | Code                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Google / Microsoft | Connections: one card per provider — “Not configured on this server”, capability checkboxes with the exact scopes, connected, expired        | `features/connections/{OAuthCard,oauth,Reconnect}`            |
| OAuth callback     | `/connections/callback` (the redirect URI): forwards `code`/`state`/`error`/`iss` once, clears the address, offers Retry for resumable tasks | `features/connections/CallbackScreen`                         |
| Home “Upcoming”    | Only when `HomeSnapshot.upcoming` is not null: days in the account’s zone, overlaps flagged, calendars that didn’t answer with their fix     | `features/home/{Upcoming,upcoming}`                           |
| Approval sheets    | `calendar_event`, `booking`, `purchase` (items, totals, delivery, payment, monthly limit meter), `form_submission`, email drafts / `via`     | `components/approvals/{PhaseCDetails,labels}`                 |
| Task results       | Email threads, free times, offers compared (table; cards on phones), cart, slots (“Choose” fills the follow-up), booking, order, sessions    | `features/tasks/phase-c/{PhaseCResults,results}`              |
| Failure next steps | Reconnect, Allow, Open the site yourself, Adjust the limit, Finish at the shop — one action per Phase C reason                               | `features/tasks/phase-c/NextStep`                             |
| Evidence           | Screenshots as thumbnails with a lightbox (alt text: site + time), ICS / JSON as owner-only downloads                                        | `components/evidence/EvidenceImage`, `phase-c/PhaseCEvidence` |
| Settings           | Spending (monthly purchase limit, 0 = off; orders; bookings), Reply tracking (watched threads, Stop)                                         | `features/settings/{SpendingSection,RepliesSection,spending}` |

Rules specific to these screens: amounts are contracts `Money` formatted with `lib/money.ts` in the
viewer's notation inside a left-to-right isolate (money parameters of server sentences —
"USD 129.99" — are reformatted the same way); a price, shipping cost or delivery time a page did
not state reads “Not stated”, never 0 or free; nothing from a page, a mailbox or an invitation is
ever a link target unless it is http(s) (`safeExternalUrl`); evidence files load only from the
API's own `/v1/evidence/:id/content`; the consent URL is followed only when it is https (http only
on localhost, for the mock providers). Step outputs are the tools' display previews: a full
`ShoppingComparison` / `BookingSlots` / `PreparedCart` / `EmailThreadSummary[]` is used when a
preview carries one, otherwise the preview fields (see `phase-c/results.ts`). Unit tests:
`test/phase-c.test.ts`, `test/phase-c-catalogs.test.ts`; visual + behaviour specs:
`e2e/visual/phase-c.spec.ts` (fixtures in `e2e/support/phase-c.ts`, evidence screenshots captured
from the local fixture site in `e2e/support/evidence/`).

## Phase D screens (docs/architecture/phase-d.md §3.1, §3.7)

| Feature               | Where                                                                                                                                                                                               | Code                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Voice conversation    | Voice overlay (mic button of every composer): “One request” / “Conversation” (default from Settings › Voice), captions, text field, End / microphone                                                | `components/voice/{ConversationSession,useVoiceConversation,display,replies}` |
| Conversation engine   | Turn-taking state machine over speech seams (no React, no DOM): end of utterance, barge-in + echo guard, sentence streaming, retries, idle end, stop phrases                                        | `components/voice/engine/{controller,text,types,browser}`                     |
| Presence              | `speaking` state (bars) next to `listening`; the shell Presence follows the overlay (`setListening` / `setSpeaking`)                                                                                | `components/presence/*`, `shell/ShellContext`                                 |
| Settings › Voice      | Read aloud, conversation mode, recognition language, speaking rate, pause before sending (600–4 000 ms), a voice per language with preview (online marked)                                          | `features/settings/VoiceSection`                                              |
| `phone_call` approval | Whom, number (readable + country), on whose behalf, caller id, language, purpose, the exact script, what may be shared, duration, hours, recording, voicemail, transfer, cost — approved by a click | `components/approvals/PhoneCallDetails`                                       |
| Task detail: calls    | Latest attempt in full (status, live captions with speaker labels, outcome, notes, timeline, disclosure + consent, recording player only with consent), earlier attempts in short                   | `features/calls/CallCard`                                                     |
| Unsuccessful calls    | One next step per reason (retry places a new attempt; unknown outcome asks to acknowledge; do-not-call → Settings › Privacy)                                                                        | `features/tasks/phase-c/NextStep`                                             |
| Phone number          | Settings › Profile: E.164 input (spaces, `00`, Arabic-Indic digits normalised), verification by call with a code (resumed after a reload: `GET /v1/me/phone/verification`)                          | `features/settings/PhoneNumberRow`                                            |
| Do-not-call list      | Settings › Privacy: masked numbers, why each is there, removal states the callee’s wish first                                                                                                       | `features/settings/DoNotCallCard`                                             |
| Task Center › Calls   | `/tasks/calls`: every call, newest first, each opening its task                                                                                                                                     | `features/calls/CallsScreen`                                                  |

Rules specific to these screens: speech never reaches JARVIS — only the requests, as text, and voice
session metadata (counters, end reason). Approvals are never given by voice: while one waits the
overlay says so aloud, opens the ApprovalSheet, and “yes” is answered with the same sentence (and
marked “Not an approval”); a stop phrase (“stop”, “stopp”, “توقف” …, contracts
`VOICE_LIMITS.stopPhrases`) or Esc ends voice mode, never the task. States are only ever real:
`thinking` while the task works, `speaking` while synthesis plays, `reconnecting` while the stream is
down (the task is then polled). Each utterance has one Idempotency-Key for all its retries
(`VOICE_LIMITS.reconnectDelaysMs`); after the last retry the words wait in the focused text field.
Barge-in is recognition-based (speech that is not the echo of the sentence being spoken): browser
speech synthesis is not covered by WebRTC echo cancellation, so a microphone-level trigger would
interrupt JARVIS with its own voice. What a callee says is recognised speech: shown in its own
direction, labelled as their words, flagged when it tried to instruct an assistant, never a link or
an instruction. Phone numbers are one LTR run in every sentence (`server-message.ts` isolates
`{number}`). Unit tests: `test/voice-conversation.test.ts` (engine, with the fakes of
`test/support/fake-speech.ts`), `test/phase-d.test.ts`; visual + behaviour specs:
`e2e/visual/phase-d.spec.ts` (fixtures in `e2e/support/phase-d.ts`; a fake Web Speech API in
`e2e/support/fake-speech.ts` and a live SSE server in `e2e/support/live-stream.ts`).

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
`phase-c.spec.ts` covers connecting Google through the real OAuth redirect against the mock
provider (PKCE S256 checked by the provider, session-bound single-use state), Home "Upcoming", a
calendar event after approval, a Gmail summary with an injected instruction ignored, an email sent
once through the Gmail API, scenario 9 (expired grant → Reconnect → Retry), scenario 3 (two fixture
merchants compared with screenshots), scenario 7 (purchases off, over the limit), scenario 10 (one
order with evidence; an interrupted checkout reconciled without a second order), scenario 1 (a
booking with confirmation + ICS, saved to the calendar) and a CAPTCHA handed over. It needs the
mock providers with their control channel (`node tools/mock-providers/server.mjs --no-seed`,
`MOCK_CONTROL_PORT`, `E2E_MOCK_CONTROL_URL`), the fixture site (`E2E_FIXTURE_URL`) and a running
browser worker; the API and workers get `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_BASE_URL_OVERRIDE`,
`BROWSER_FIXTURE_ORIGIN` and `BROWSER_ALLOW_PRIVATE_HOSTS` (development only).
`phase-d.spec.ts` covers a call from the approval sheet (exact number, script, cost) to the live
call card (the AI disclosure first) and the collected times, scenario 4 (busy and no answer →
FAILED with the localized reason → Retry → a new attempt), a forged webhook refused with 403
without any change, do-not-call (the callee opts out → the next call is refused → the entry is
removed in Settings › Privacy), and a voice conversation on the test-only fake speech service (two
spoken turns, barge-in, an approval only by click, "stop" ends it). It needs the mock Twilio + call
simulator (`node tools/mock-twilio/server.mjs`, control channel `E2E_TWILIO_CONTROL_URL`) and, on
the API and worker, `TWILIO_*`, `TWILIO_BASE_URL_OVERRIDE` and `PUBLIC_WEBHOOK_BASE_URL` (the
API's own origin; development only), with `CALL_ALLOWED_HOURS` covering the time of the run.
