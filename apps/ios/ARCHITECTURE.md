# iOS architecture

The iPhone app is a thin, honest client of the JARVIS API. The server plans, enforces
policy and executes; the app shows real state, collects decisions and never pretends an
action happened.

## Module layout

```
apps/ios
├── project.yml                 XcodeGen spec (app + JarvisTests, iOS 18, Swift 6)
├── Config/                     Debug/Release xcconfig (JARVIS_API_BASE_URL), optional Local.xcconfig
├── Jarvis
│   ├── App                     JarvisApp (@main), RootView/TabView, AppModel, LiveEvents, Navigation
│   │                           (routes + shared destinations), AppConfiguration (API address policy),
│   │                           ErrorText (code, ApiErrorReason and TaskErrorReason copy)
│   ├── Core
│   │   ├── Models              Codable mirrors of packages/contracts (enums with .unknown,
│   │   │                       JSONValue, ISO 8601 decoding, task state machine, ServerMessage
│   │   │                       rendering, conversations, attachments + client checks, skills,
│   │   │                       schedules/recurrence, time zones)
│   │   ├── Networking          APIClient (actor) + typed endpoints, ApiError/NetworkError,
│   │   │                       SSE line splitter + parser, EventStream (reconnecting SSE)
│   │   └── Storage             KeychainStore, CredentialStore
│   ├── DesignSystem            Tokens.swift (generated), Color+Meridian, Typography (Dynamic Type),
│   │                           Icons (shared icon map), Components, StatusPresentation,
│   │                           PresenceState (pure mapping) + PresenceView (Canvas/TimelineView)
│   ├── Features
│   │   ├── Auth                SignInView
│   │   ├── Home                HomeView, HomeModel, CommandComposer, HomeCopy
│   │   ├── Tasks               TaskListView/Model, TaskDetailView/Model, TaskRow, TaskEventText
│   │   ├── Conversations       ConversationListView/Model, ConversationThreadView/Model, QuestionCard
│   │   ├── Attachments         AttachmentDraft (pick, check, upload with progress), tray, attach
│   │   │                       buttons, AttachedFilesView (download → Quick Look/share)
│   │   ├── Schedules           SchedulesView/Model, ScheduleDetailView, ScheduleEditorView,
│   │   │                       RecurrenceText (recurrence phrased from its fields)
│   │   ├── Approvals           ApprovalCard, ApprovalSheet (+ decision model; email, generic,
│   │   │                       schedule and memory previews; untrusted-source facts)
│   │   ├── Voice               VoiceCaptureView/Model, SpeechSession, ResponseSpeaker
│   │   ├── Memory              MemoryView, MemoryModel
│   │   └── Settings            SettingsView/Model, SessionsView, SkillsView (read-only),
│   │                           TimeZonePickerView (zones the server accepts), retention
│   ├── Intents                 AskJarvisIntent + JarvisShortcuts (Siri / Shortcuts)
│   └── Resources               Info.plist, Localizable/InfoPlist/AppShortcuts.xcstrings, Assets
├── JarvisTests                 Swift Testing suites + JSON fixtures
└── scripts                     validate-fixtures.ts, check-contract-copy.ts, lint-strings.mjs,
                                check-swift.mjs, make-app-icon.mjs
```

## Data flow

```
 SwiftUI views ──(MainActor)── screen models (@Observable) ──await──▶ APIClient (actor) ──▶ HTTPS API
      ▲                                ▲                                     │
      │                                │ debounced refetch / answer deltas    │ 401 → AppModel.sessionEnded
      │                         LiveEvents (MainActor fan-out)               ▼
      └──── AppModel (session, me, presence outcome) ◀── EventStream (detached task, URLSession.bytes)
```

- **AppModel** owns the session phase (`launching → signedIn | signedOut | restoreFailed`),
  the signed-in `Me`, the `APIClient` and `LiveEvents`. It is injected with
  `.environment(_:)`; screens read it with `@Environment(AppModel.self)`.
- **Screen models** (`HomeModel`, `TaskListModel`, `TaskDetailModel`, `MemoryModel`,
  `SettingsModel`, …) are `@MainActor @Observable` classes held in `@State`. They load
  with `await api.…`, keep the last good data on failure and expose a localized error.
- **Realtime.** `EventStream` reads `GET /v1/events` byte by byte (not `.lines`, which
  drops the blank lines that dispatch SSE events), parses with `SSEParser`, decodes
  `StreamEvent`s and reconnects with the server's `retry` doubled per failure (≤ 30 s,
  ±20 % jitter), sending `Last-Event-ID` so the server replays what was missed. A
  connection idle for 75 s (three missed heartbeats) is dropped and reopened.
  `LiveEvents` fans events out to `AsyncStream` subscribers that live exactly as long as
  the view's `.task`, tracks the resume id (persisted ids only — ephemeral `eph-…`
  deltas never move it), and bumps `openCount` on every (re)connect so screens refetch
  and close any gap. The stream stops in the background and resumes in the foreground.
- **Updates are refetches, not local guesses.** A task event schedules a debounced
  reload of the affected screen; only `task.answer.delta` text is appended locally, and
  it is replaced by the stored answer on the next load.

## Phase B: conversations, questions, files, schedules

- **Navigation.** Each tab's `NavigationStack` registers every destination once with
  `jarvisDestinations()` (task, conversation, schedule, schedules list), so a task links to
  its conversation and a conversation to its schedule from any tab. Home and Tasks use a
  type-erased `NavigationPath`.
- **Follow-ups.** The thread model keeps every turn loaded so far and merges a refetched
  newest page by task (each task keeps its position, its turns come from the freshest page),
  so loading earlier pages and live refreshes never drop or duplicate turns. A follow-up uses
  one idempotency key per (conversation, text, files); `409 CONVERSATION_BUSY` is explained
  from `error.details.reason`, and the composer is disabled while `canFollowUp` is false.
- **Clarifying questions** are completed tasks with `outcome: "question"`: the badge says
  "Needs your answer", and answering is a follow-up in the same conversation.
- **Attachments.** Files are read from the Files picker (security-scoped, size checked before
  reading), checked like the server checks them (extension list, PDF magic, DOCX zip naming
  `word/document.xml`, UTF-8 text without NUL), uploaded as one multipart part named `file`
  with a per-task progress delegate, and named by id in the request. The server stays
  authoritative (it sniffs again). Downloads go to a per-file temporary folder with complete
  file protection and are deleted when Quick Look closes. File names are user content and are
  shown bidi-isolated.
- **Schedules.** Recurrences are phrased on the device from their fields (no server prose):
  plural forms come from `DateComponentsFormatter`, weekday names from the calendar, times are
  formatted in the schedule's own zone. The editor shows the server's preview
  (`POST /v1/schedules/preview`) of the next runs; nothing is saved until Create/Save.
- **Server sentences.** `ServerMessage { key, params }` (titles, objectives, step titles,
  approval summaries, result lines, questions, also `titleMessage` inside events) render in
  the app's language from catalog keys `server.<key>`; an unknown key or a missing parameter
  falls back to the server's text. Task and step errors show the `TaskErrorReason` sentence
  (with parameters), else the code's sentence — never the server's English `message`.

## Presence

`PresenceState.derive(from:now:)` is a pure function of real inputs, in priority order:
listening (voice capture active) › reconnecting (stream dropped, data may be stale) ›
awaiting (a pending approval) › running (step progress `completed/total`, indeterminate
while unknown) › planning (queued/planning) › completed/failed (an outcome observed on
the stream in the last 6 s, never a replayed old one) › idle. `PresenceView` draws it in a
`Canvas` inside a `TimelineView` that runs only for states that move on their own; with
Reduce Motion nothing rotates or pulses (static arcs, level shown as intensity). It is a
single VoiceOver element with a state label.

## Approvals and side effects

- `ApprovalSheet` shows exactly what the server will execute — for email the sender,
  every recipient, subject and full body — plus localized policy reasons and expiry.
- Approve/Decline sends the approval's `actionHash`, binding the decision to what was on
  screen. An approval whose `details.kind` this build cannot display decodes to
  `.unknown` and **cannot be approved here**.
- Idempotency keys: task creation reuses one key per distinct request text (a re-send
  after a lost response replays); retry reuses one key per intent, including the
  acknowledgement flag; decisions use `approval-<id>-<decision>`, so a double tap replays.
- Retrying after `OUTCOME_UNKNOWN` requires an explicit "Retry anyway" in an alert that
  explains the action may already have happened; cancel and retry are offered only when
  the server says `canCancel` / `canRetry`, each behind a confirmation.
- Siri ("Ask JARVIS") only creates tasks. Approvals always happen in the app.

## Voice

`SpeechSession` (deliberately not actor-isolated) runs `AVAudioEngine` →
`SFSpeechAudioBufferRecognitionRequest` with `requiresOnDeviceRecognition` whenever the
recognizer `supportsOnDeviceRecognition`; otherwise the UI states that Apple's speech
service recognises the audio. The tap computes an RMS level that drives Presence. Results
flow through an `AsyncStream` to the main-actor `VoiceCaptureModel`. The locale is the
`recognitionLocale` preference, or the app language for `auto`. Permission-denied
(speech or microphone, with an "Open Settings" button), restricted, unavailable and
no-speech states are explicit. The transcript is editable and is only sent when the user
taps Send (`source: "voice"`, `language`, and the `voiceSessionId` from the best-effort
voice-session metadata endpoints). With "Speak responses" on, the final result of a voice
task created on this device is read aloud with the on-device system voice (never while
capturing).

## Security and privacy

- The bearer token lives only in the Keychain (`kSecClassGenericPassword`,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: not synced to iCloud, not restored
  to another device). It is never logged or written to `UserDefaults`.
- Bearer tokens are only sent over HTTPS; plain HTTP is accepted for loopback only (the
  ATS exception in Info.plist covers `localhost` only). The app refuses to start with any
  other insecure or missing API address.
- Any 401 on an authenticated request removes the local credential and returns to
  sign-in. Sign out revokes the session server-side (`POST /v1/auth/logout`) and always
  removes the local credential; if the server cannot be reached the user is told the
  session will expire or can be revoked from another device.
- Audio never goes to JARVIS; only text the user confirms is sent.
- Server messages are treated as data: user-facing copy comes from the String Catalog,
  keyed by error/reason codes; unknown keys are hidden rather than shown raw.
- Swift 6 strict concurrency throughout. The two `@unchecked Sendable` types are
  `SpeechSession` (mutable state touched only from the main actor; callbacks use only the
  thread-safe continuation) and a tiny box that hands the recognition request to the
  real-time audio tap.

## Localization and accessibility

- String Catalogs with English source keys; every key has en, de and ar
  (`scripts/lint-strings.mjs` enforces this and that every localizable Swift literal has
  an entry). Localized strings interpolate only `String` values (numbers are formatted
  first), so every placeholder is `%@`; translations reorder with `%1$@`/`%2$@`.
- RTL comes from the environment (`layoutDirection`), with leading/trailing layout and
  auto-mirroring symbols (`chevron.forward`). Dates, numbers and currency use the
  locale's formatters.
- Meridian type sizes scale with Dynamic Type via `@ScaledMetric` relative to the closest
  system text style; layouts switch to vertical stacks with `ViewThatFits`.
- Status is never colour alone (icon + label + tone); headings carry `.isHeader`; touch
  targets are at least 44 pt; decorative symbols are hidden from VoiceOver.

## What is verified and what is not

Verified in this repository's Linux environment (no Xcode, no Swift toolchain):

- All JSON test fixtures parse with the matching Zod schemas from `@jarvis/contracts`
  and round-trip unchanged; the four `unknown-values*.json` fixtures are rejected exactly at
  their deliberately unknown enum fields and union variants; `me-before-phase-b.json` parses
  with only the contract defaults for `retention` and `skills` (`scripts/validate-fixtures.ts`).
- Every Swift enum mirrors its contract enum (plus `unknown`); every `ServerMessageKey`
  renders from a catalog entry whose en/de/ar equal the API's canonical templates; every
  `TaskErrorReason`, `PolicyReason` and non-webhook `ApiErrorReason` has copy
  (`scripts/check-contract-copy.ts`).
- The String Catalogs are valid JSON with translated en/de/ar values for every key, matching
  format specifiers, and coverage of every localizable literal in the Swift sources
  (`scripts/lint-strings.mjs`).
- Every Swift file parses with the tree-sitter Swift grammar 0.7.1
  (`scripts/check-swift.mjs --tree-sitter <dir>`, grammar installed outside the repository),
  and `scripts/check-swift.mjs` finds balanced delimiters and no
  `try!`/`as!`/`fatalError`/`print` in app code.

**Not verified:** compilation and type-checking, the Swift Testing suites, running the app
in the Simulator, VoiceOver/Dynamic Type/RTL rendering, speech recognition, Siri phrase
matching, and XcodeGen project generation. These need a Mac with Xcode 16+; the first
build may surface compiler errors that static checks cannot catch.

## Not in this slice

Push notifications, an in-app notifications list, connecting services (done on the web;
the app lists connections read-only), webhook management and switching skills on or off
(both on the web; the app shows the skills catalog read-only), editing a schedule's end
(`until`/`count`) or several days of the month (kept as they are; changed on the web),
offline caching, and an iPad layout.
