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
│   │   │                       schedules/recurrence, time zones; Phase C: Connections (OAuth),
│   │   │                       Calendar, Email, Commerce (money, evidence, browser sessions,
│   │   │                       offers, carts, orders, bookings); Phase D: Calls (call sessions,
│   │   │                       turns, outcomes, do-not-call, phone verification), VoiceLimits)
│   │   ├── Networking          APIClient (actor) + typed endpoints, ApiError/NetworkError,
│   │   │                       SSE line splitter + parser, EventStream (reconnecting SSE)
│   │   └── Storage             KeychainStore, CredentialStore
│   ├── DesignSystem            Tokens.swift (generated), Color+Meridian, Typography (Dynamic Type),
│   │                           Icons (shared icon map), Components, StatusPresentation,
│   │                           PresenceState (pure mapping) + PresenceView (Canvas/TimelineView),
│   │                           PhaseDPresentation (call enums, wall-clock times of a call)
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
│   │   ├── Voice               VoiceModeSheet; dictation: VoiceCaptureView/Model, SpeechSession,
│   │   │                       ResponseSpeaker; conversation (Phase D): VoiceText (pure text rules),
│   │   │                       VoiceConversationController (pure state machine over speech seams),
│   │   │                       ConversationSpeech (SFSpeechRecognizer / AVSpeechSynthesizer /
│   │   │                       AVAudioSession adapters), VoiceConversationModel/View
│   │   ├── Calls               Phase D: call card (timeline, transcript, outcome, evidence),
│   │   │                       call screen (every turn, live), Calls list
│   │   ├── Memory              MemoryView, MemoryModel
│   │   ├── Connections         OAuthFlow (redirect policy, callback forwarding, ASWebAuthentication-
│   │   │                       Session), ConnectionsModel/View, ConnectResultView (resumable
│   │   │                       retries), ReconnectButton
│   │   ├── Activity            Orders, bookings (paged, read-only records + cards), reply tracking
│   │   ├── Shared              Evidence download / thumbnails / Quick Look, external-link policy,
│   │   │                       CalendarText (times in the event's own zone)
│   │   └── Settings            SettingsView/Model, SessionsView, SkillsView (read-only),
│   │                           TimeZonePickerView (zones the server accepts), retention,
│   │                           SpendingView (monthly purchase limit); Phase D: VoicesView,
│   │                           PhoneSettingsView (number + verification by call), DoNotCallView
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

## Phase C: connections, calendars, browser agent, commerce

- **OAuth on iPhone (ADR-0016).** The server runs the authorization code flow with PKCE
  (S256): state bound to this app's session, single use, 10 minutes; verifier sealed on the
  server; code exchanged with the client secret on the server. The app (`OAuthFlow.swift`)
  only (1) asks `POST /v1/connections/oauth/start` with the provider, the capabilities the
  user ticked (least privilege, incremental with `connectionId`) and the configured https
  redirect URI, (2) opens the returned URL — https only — in SwiftUI's
  `WebAuthenticationSession` with `.https(host:path:)` and an ephemeral browser session,
  (3) forwards the redirect's `state` / `code` | `error` / `error_description` / `iss`
  verbatim to `POST /v1/connections/oauth/callback`. A redirect to another host or path, a
  short or missing state, neither or both of code and error, or any repeated parameter is
  refused locally and nothing is sent. Cancelling the sheet connects nothing and shows no
  error. What must be configured outside the code (redirect URI, server allow-list,
  Google/Microsoft redirect registration, Associated Domains + apple-app-site-association) is
  listed in the README and at the top of `OAuthFlow.swift`; without the redirect URI the
  Connect buttons are disabled and say so.
- **Expired connections (scenario 9).** `Connection.status == .expired` with its
  `statusReason` shows why and **Reconnect** (the same capabilities as before, plus one a
  failed step named in `CONNECTION_SCOPE_MISSING { capability }`). A task that failed with
  `CONNECTION_EXPIRED { provider }` offers Reconnect in place; the callback's
  `resumableTaskIds` are offered for **Retry** (one idempotency key per task per result
  sheet, so a double tap replays). Nothing is shown as connected unless the server's callback
  answer says so.
- **Home "Upcoming".** Rendered only when `HomeSnapshot.upcoming` is not nil (spec §4A);
  `connection.changed` events refetch Home. Events are grouped by day in the account's zone;
  times are formatted with the event's own zone (`Date.IntervalFormatStyle(timeZone:)` — no
  hour arithmetic), adding the zone's short name when its offset differs from the viewer's.
  Each calendar that didn't answer is named with its fix.
- **Approvals.** `ApprovalDetails` decodes `calendar_event`, `booking`, `purchase` and
  `form_submission` and the email `mode` / `via` / `cc` / `inReplyTo`; every field the server
  bound to the action hash is on screen (times in the stored zone, every attendee and whether
  they are emailed, every form field with personal ones marked, items / quantities / totals /
  delivery / payment / the monthly limit). Unknown kinds, actions, modes or routes from a
  newer server stay non-approvable. The approve button names the consequence ("Approve and
  buy", "Approve and save draft").
- **Evidence.** Screenshots, extracts and ICS files are downloaded with the session
  (`GET /v1/evidence/:id/content`, owner only), written to a per-file temporary folder with
  complete file protection, shown in Quick Look and deleted when it closes; screenshot
  thumbnails are kept in a small in-memory cache that is cleared on sign-out. Evidence titles
  are localized by `EvidenceCode`.
- **Step outputs are previews.** `TaskStep.output` is the server's redacted preview (not a
  frozen contract), so the comparison table, cart, slots and mail / calendar text are read
  defensively (`StepPreview`): a missing field shows nothing rich, never a guess. Order and
  booking cards come from `GET /v1/orders/:id` / `GET /v1/bookings/:id`, not the preview.
  Text written by others (mail, invitations, product titles, a site's terms) is shown
  bidi-isolated and labelled as such, with the injection warning when the server flagged it.
- **Money.** Amounts are integer micro-units (`Money`) formatted with the currency's usual
  decimals without ever rounding away a stated fraction; money parameters of sentences and
  errors ("USD 129.99") are parsed exactly and shown in the app's locale. Currencies are never
  converted.
- **Purchase limit.** `PATCH /v1/me` with only `preferences.spending.monthlyPurchaseLimitUsd`
  (the AI budget keeps its stored value); 0 = purchases off (the default, also for older
  servers); raising it asks for confirmation; the screen shows the value the server saved.
- **Statuses with a real `unknown`.** `OrderStatus` and `BookingStatus` have a contract value
  `unknown` (the outcome is unknown); it decodes to `.outcomeUnknown`, and a value from a newer
  server to `.unrecognized`, so the two can never be confused (enforced by
  `scripts/check-contract-copy.ts`).

## Phase D: voice conversation and phone calls

- **Voice conversation (ADR-0019).** `VoiceModeSheet` opens dictation or a conversation
  (`preferences.voice.conversationMode`; either can be switched in the sheet). The conversation
  is `VoiceConversationController`, a pure `@MainActor` state machine (a port of the web
  controller) over five seams: recognizer, synthesizer, clock, permission request and submit —
  the tests drive it with fakes and a manual clock. Listen → the configured pause
  (`endOfSpeechSilenceMs`, 600–4000 ms) → the recognizer is asked for its final result
  (`endAudio`; a 1.5 s grace falls back to what it showed) → the first utterance is
  `POST /v1/tasks`, later ones follow-ups in the same conversation, each with its own
  Idempotency-Key kept across retries (`VOICE_LIMITS.reconnectDelaysMs`; then "Couldn't send",
  words in the text field). The reply is spoken sentence by sentence as `task.answer.delta`
  arrives (`NLTokenizer(.sentence)`, chunks ≤ 300 characters split at commas), else the result
  line / question / error the task screen shows (`VoiceConversationModel.replyLine`).
- **Barge-in.** `AVAudioSession` `.playAndRecord`, mode `.voiceChat`, options `.duckOthers`,
  `.defaultToSpeaker`, `.allowBluetooth` (named `.allowBluetoothHFP` in newer SDKs). Recognition
  keeps running while JARVIS speaks; recognised words that aren't the echo of what is being said
  stop speaking at once (`stopSpeaking(at: .immediate)`), the interrupted caption is marked and
  `bargeIns` counted. Loudness alone (≥ 0.55 for 300 ms) interrupts only on headphones —
  AVSpeechSynthesizer's output isn't the voice-processing reference, so on the loudspeaker the
  text echo guard decides. SFSpeechRecognizer runs are cumulative, so a fresh run starts when
  JARVIS starts and stops speaking and after a barge-in: its echo never becomes part of a
  request (`VoiceText.removingEchoPrefix` drops what slipped in).
- **Honest states.** Listening (live level), Working (only while the task is really queued /
  planning / running / verifying, from the stream), Speaking (a new Presence state, only while
  synthesis plays), Waiting for your approval, Reconnecting (stream down or a request retried),
  Paused (an interruption). Approvals are never given by voice: the approval sheet opens on its
  own, JARVIS says so, and "yes" is answered with the same sentence (captioned "Not an
  approval"). Other words while a task works or waits go to the text field ("Not sent").
- **Interruptions and routes.** Audio-session interruptions (calls, Siri) and the app leaving
  the foreground pause listening and speaking, keep heard words in the text field and resume
  when the system says so; unplugging headphones stops speaking; a route or media-services
  change restarts the audio engine (the run fails and is restarted, counted as a reconnect).
  Recognition errors restart with the contract's delays, then "Speech recognition stopped
  working"; runs that end at once back off instead of looping.
- **Termination and access.** End (toolbar), Esc (hardware keyboard), a stop phrase of the
  recognition language (`VOICE_LIMITS.stopPhrases`, compared normalised), "Type instead", idle
  (announced 10 s before `idleEndSeconds`), leaving the sheet. None cancels a task. Space toggles
  the microphone (not while typing). Every line is captioned (You / JARVIS, typed, interrupted,
  not sent); VoiceOver hears state changes as announcements (not JARVIS's sentences, which the
  voice already speaks). Metadata only: `POST /v1/voice-sessions { mode: conversation,
  conversationId }` and `…/end { outcome, turns, bargeIns, reconnects, endReason,
  transcriptChars }`.
- **Settings › Voice:** conversation mode, speaking rate (0.5–2×), the pause that ends what you
  say, and a voice per language with a sample (`AVSpeechSynthesisVoice` identifiers; a voice
  this iPhone lacks falls back to the system voice). Only changed fields are sent; a voice is
  reset with an explicit null.
- **Phone-call approvals.** `ApprovalDetails.phone_call` shows everything bound to the action
  hash: the number (readable, exact E.164 and country, always left-to-right), who is called, on
  whose behalf, the caller id, the call's language, purpose, goal, **the script verbatim** in the
  call's own writing direction, how JARVIS talks (scripted / model), the date and window, every
  detail it may share (marked personal), the calling hours of the callee's zone, the longest
  call, recording, voicemail, transfer (to the masked verified number), binding and the cost
  bound ("Approve and call"; Decline places no call). Unknown purpose / dialog / recording /
  voicemail values make it non-approvable here.
- **Calls on the task screen.** One card per attempt: status or result badge (icon + label),
  live state, why it didn't reach its goal (the call's own failure reason with its facts),
  outcome with what was collected (their words, marked as recognised), notes (opt-out,
  injection ignored, low confidence …), disclosure time, recording consent, transfer, duration,
  price, the provider's call id, the status timeline, and what was said — JARVIS's lines
  verbatim; the other person's isolated, tinted and labelled "as recognised", flagged turns
  warned. `call.turn` / `call.status_changed` refetch it (live captions). A recording is offered
  only with consent. Scenario 4: a busy line or no answer fails the task with its sentence and
  the task's Retry places a new attempt; `CALL_STATE_UNKNOWN` needs "Retry anyway" with
  call-specific copy (JARVIS reconciles with the provider first). `DO_NOT_CALL` links to the
  list.
- **Settings › Phone.** The account's number (typed with its country code; Arabic-Indic digits
  and `00` accepted; the server validates again), Remove (explicit null), verification by a call
  that reads a code (status from `phone_verification.changed`, tries left, expiry), the
  do-not-call list (masked; removing one the callee asked for warns first) and Calls (filter by
  result, paged).

## Presence

`PresenceState.derive(from:now:)` is a pure function of real inputs, in priority order:
speaking (synthesis playing) › listening (voice capture active) › reconnecting (stream dropped, data may be stale) ›
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

## Voice (dictation)

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
- Swift 6 strict concurrency throughout. The `@unchecked Sendable` types are `SpeechSession`
  and `ConversationAudioEngine` (mutable state touched only from the main actor; callbacks use
  only the thread-safe continuation), the boxes that hand the recognition request to the
  real-time audio tap (the conversation's is lock-protected), and the synthesizer delegate
  that forwards callbacks through an `AsyncStream`.
- A call's other party is untrusted: their words are shown isolated and marked, never as
  instructions; calls are approved by a tap only.

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

- All 73 JSON test fixtures parse with the matching Zod schemas from `@jarvis/contracts`
  and round-trip unchanged; the eight `unknown-values*.json` fixtures are rejected exactly at
  their deliberately unknown enum fields and union variants; `me-before-phase-b.json` parses
  with only the contract defaults for `retention`, `skills`,
  `spending.monthlyPurchaseLimitUsd` and the four Phase D voice preferences
  (`scripts/validate-fixtures.ts`).
- Every Swift enum (54) and nested enum (10, plus the send-only voice-session outcome)
  mirrors its contract enum (plus `unknown`, or `unrecognized` where `unknown` is a contract
  value: `OrderStatus`, `BookingStatus`, `CallStatus`, `AnsweredBy`); all 118
  `ServerMessageKey`s render from catalog entries whose en/de/ar equal the API's canonical
  templates; every `TaskErrorReason`, `PolicyReason`, non-webhook `ApiErrorReason` and
  `EvidenceCode` has copy; every app endpoint (59) is a contract route and every Phase C and
  D route has one; `VoiceLimits` and the `CallLimits` the app uses equal `VOICE_LIMITS` /
  `CALL_LIMITS`, including all 14 stop phrases (`scripts/check-contract-copy.ts`).
- The String Catalogs are valid JSON with translated en/de/ar values for every key, matching
  format specifiers, and coverage of every localizable literal in the Swift sources
  (`scripts/lint-strings.mjs`).
- Every Swift file parses with the tree-sitter Swift grammar 0.7.1
  (`scripts/check-swift.mjs --tree-sitter <dir>`, grammar installed outside the repository),
  and `scripts/check-swift.mjs` finds balanced delimiters and no
  `try!`/`as!`/`fatalError`/`print` in app code.

**Not verified:** compilation and type-checking, the Swift Testing suites (Phase D adds
`VoiceConversationTests`, `PhaseDDecodingTests`, `PhaseDLogicTests`), running the app
in the Simulator, VoiceOver/Dynamic Type/RTL rendering, speech recognition, Siri phrase
matching, and XcodeGen project generation. These need a Mac with Xcode 16+; the first
build may surface compiler errors that static checks cannot catch. Phase C adds: the
`ASWebAuthenticationSession` round trip (needs the redirect URI, Associated Domains and a
provider console registration — none exist in this repository's environment), and the
SwiftUI `WebAuthenticationSession.authenticate(using:callback:preferredBrowserSession:
additionalHeaderFields:)` signature (iOS 17.4 SDK) as written. View builders were kept at
ten children or fewer so they don't depend on the variadic `ViewBuilder`. Phase D adds: real
speech recognition and synthesis in a conversation (end-of-utterance timing, `endAudio` final
results, echo on the loudspeaker in `.voiceChat` mode, barge-in latency), audio interruptions
and route changes on a device, VoiceOver announcements while JARVIS speaks, and live calls
against the server's Twilio adapter.

## Not in this slice

Push notifications, an in-app notifications list (so `connection_expired` and
`email_reply_received` show up on Home / in Connections and Reply tracking, not as a list),
setting up SMTP mailboxes or web access (on the web; Google and Microsoft connect here),
webhook management and switching skills on or off (both on the web; the app shows the
skills catalog read-only), changing the monthly AI budget (shown read-only next to the
purchase limit), editing a schedule's end (`until`/`count`) or several days of the month
(kept as they are; changed on the web), offline caching, and an iPad layout.
