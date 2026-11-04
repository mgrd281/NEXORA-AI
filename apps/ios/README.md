# JARVIS for iPhone

Native SwiftUI client for the JARVIS API: sign in, ask in text or by voice, follow tasks
live, review and approve exactly what JARVIS will do, manage memory, sessions and
preferences. Phase B adds conversations with follow-ups, clarifying questions, attached
documents (PDF, Word, text, Markdown, CSV), schedules, a read-only skills catalog,
automatic-deletion (retention) settings and a time-zone picker. Phase C adds Google and
Microsoft connections (connect, reconnect, allow more, disconnect), Home "Upcoming", the
calendar-event, booking, purchase and form approvals, email drafts, browser-agent
evidence, comparisons, orders, bookings, reply tracking and the monthly purchase limit.
English, German and Arabic (right-to-left), light and dark, Dynamic Type, VoiceOver and
Reduce Motion are supported throughout. Webhooks and SMTP / web-access connections are
managed on the web only.

> **Build status: not yet compiled.** This code was written in an environment without
> Xcode or a Swift toolchain. It has been checked structurally (see
> [Verification](#verification-without-xcode)) but the first `xcodebuild` run may surface
> compiler errors. See [ARCHITECTURE.md](ARCHITECTURE.md#what-is-verified-and-what-is-not).

## Requirements

- macOS with **Xcode 16 or later** (Swift 6 language mode, iOS 18 SDK)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.42 or later — `brew install xcodegen`
- The JARVIS API running locally (Node 22, PostgreSQL 16) — see the repository README

## Generate the project

The Xcode project is generated from `project.yml` and is not committed.

```sh
cd apps/ios
xcodegen generate
open Jarvis.xcodeproj
```

Targets: **Jarvis** (app, bundle id `ai.jarvis.app`, iOS 18.0, iPhone) and
**JarvisTests** (Swift Testing, hosted in the app). Set your team under
*Signing & Capabilities* to run on a device.

## Run against the local API

1. From the repository root, set up the database and an owner account (once):

   ```sh
   bash scripts/ensure-postgres.sh          # if PostgreSQL is not running
   pnpm db:setup && pnpm db:migrate
   JARVIS_OWNER_PASSWORD='choose-a-long-password' \
     pnpm --filter @jarvis/api cli create-owner --email you@example.com --name "Your Name"
   ```

2. Start the API and the worker (two terminals):

   ```sh
   pnpm --filter @jarvis/api dev          # http://localhost:4000
   pnpm --filter @jarvis/api dev:worker
   ```

3. Run the **Jarvis** scheme on an iOS Simulator and sign in with the owner account.

The Debug configuration points at `http://localhost:4000`, which the Simulator resolves to
your Mac. `Info.plist` has an App Transport Security exception for `localhost` only.

### API address

`JARVIS_API_BASE_URL` is a build setting (Config/Debug.xcconfig, Config/Release.xcconfig)
copied into `Info.plist`. Override it without touching tracked files in
`Config/Local.xcconfig` (git-ignored, included by both configurations):

```
// Config/Local.xcconfig
JARVIS_API_BASE_URL = https:/$()/jarvis.example.net
```

(`//` starts a comment in xcconfig files, hence `$()` between the slashes.)

The app refuses to start against an address it cannot trust: anything other than HTTPS is
rejected, except plain HTTP to `localhost`/`127.0.0.1`. Release builds have no default and
show a configuration screen until an HTTPS address is set. A physical iPhone cannot reach
`localhost` on your Mac — use an HTTPS tunnel or a deployed API.

### Connecting Google and Microsoft from the iPhone (OAuth)

The authorization code flow with PKCE runs on the **server** (ADR-0016): the app asks
`POST /v1/connections/oauth/start` for the provider's page, opens it in
`ASWebAuthenticationSession` (ephemeral: no cookies shared with Safari), receives the
provider's redirect to the shared **https** redirect URI and forwards its query parameters
verbatim to `POST /v1/connections/oauth/callback` with its own bearer session. No client
secret, PKCE verifier or token is ever on the device. Out of the box this is **off** (the
Connect buttons are disabled and say to connect on the web — the connection then works
here too). To turn it on, all of this is needed and none of it can be done from code:

1. `Config/Local.xcconfig`:

   ```
   JARVIS_OAUTH_REDIRECT_URI = https:/$()/jarvis.example.net/connections/callback
   JARVIS_OAUTH_CALLBACK_HOST = jarvis.example.net
   JARVIS_ENTITLEMENTS = Config/Jarvis.entitlements
   ```

   https only, no port, query or fragment (`ASWebAuthenticationSession`'s
   `.https(host:path:)` callback matches host and path).
2. The API's `OAUTH_REDIRECT_URIS` contains exactly that URI (else
   `REDIRECT_URI_NOT_ALLOWED`). It is normally the web app's own callback page.
3. The URI is an authorized redirect URI of the server's OAuth clients (the confidential
   "Web application" client — not an iOS client): Google Cloud Console → APIs & Services →
   Credentials; Microsoft Entra admin center → App registrations → Authentication → "Web".
4. Associated Domains: enable the capability on the App ID (Apple Developer account),
   keep `webcredentials:$(JARVIS_OAUTH_CALLBACK_HOST)` in `Config/Jarvis.entitlements`, and
   serve `https://<host>/.well-known/apple-app-site-association` listing
   `<Team ID>.ai.jarvis.app` under `webcredentials.apps`. Without it the system does not
   hand the https callback to the app.

A custom URL scheme is deliberately not used: the redirect URI is the web client's, and any
app can claim a custom scheme.

## Tests

```sh
xcodebuild test -project Jarvis.xcodeproj -scheme Jarvis \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

| Suite | Covers |
| --- | --- |
| `ModelDecodingTests` | Real JSON fixtures shaped like the contracts: `TaskDetail` (steps, approvals, events, evidence), `HomeSnapshot`, `ApiErrorBody`, `Me`, `LoginResponse`, pages, stream events; timestamp forms; unknown enum values decoding to `.unknown` |
| `PhaseBDecodingTests` | Conversations (thread turns, history page), clarifying questions, attachments, skills, schedules (detail, runs, preview), time zones, schedule and memory approvals with untrusted-source facts, conversation stream events, `ApiErrorReason` copy, preferences from an older server (defaults), and values from a newer server decoding to `.unknown` |
| `PhaseBLogicTests` | Follow-up, retention, schedule and skill request bodies; client-side file checks (size, extension, content sniffing, file-name sanitising); the multipart upload body; thread page merging; server-sentence and error-reason rendering with fallbacks; recurrence wording; the schedule editor |
| `SSEParserTests` | Server framing, multi-line `data`, comments/heartbeats, ids and resume position, `retry`, CR/LF/CRLF, BOM, UTF-8, reconnect back-off |
| `PresenceStateTests` | Mapping of voice, connection, approvals, tasks and recent outcomes to Presence states; animation and VoiceOver labels |
| `RequestBuildingTests` | URLs, headers (bearer, `Idempotency-Key`, `Content-Type` only with a body), request bodies, API address policy, task state machine |
| `PhaseCDecodingTests` | Providers and OAuth connections (expired, capabilities, granted scopes), OAuth start / callback results, Home "Upcoming" and calendar events, email watches, orders and bookings (the contract's own `unknown` status vs. a newer value), evidence, browser sessions with handover, the purchase / calendar-event / booking / form approvals and email drafts, skills with connection options, the purchase limit (0 from older servers), the tool-output shapes (free/busy, mail summaries, comparison with reliability signals, prepared cart, booking slots and confirmation), and newer values decoding to `.unknown` / `.unrecognized` (never approvable) |
| `PhaseCLogicTests` | The OAuth redirect URI policy and callback forwarding (exact host and path, state length, code xor error, repeated parameters refused), the provider page policy, OAuth and purchase-limit request bodies, money parameters ("USD 129.99"), error and server-sentence rendering with providers, capabilities and amounts, links the app opens, step previews, times in the event's own zone and Upcoming day headings |

## Verification without Xcode

These run with Node from the repository root and need no Apple tooling:

```sh
# Fixtures parse with the Zod contract schemas, exactly (no stripped keys or defaults);
# unknown-value fixtures fail only where intended; an older server's payload gets only
# the contract defaults (63 fixtures, one for every Phase C schema the app decodes)
pnpm --filter @jarvis/api exec tsx ../ios/scripts/validate-fixtures.ts
# Swift enums (and nested Phase C enums) mirror the contract enums; server sentences match
# the API's en/de/ar templates; every task-error, policy, API-error reason and evidence code
# has copy; every Phase C route has an endpoint
pnpm --filter @jarvis/api exec tsx ../ios/scripts/check-contract-copy.ts
# Every localizable Swift literal has en/de/ar; specifiers, default values and App
# Shortcut phrases match
node apps/ios/scripts/lint-strings.mjs
# Balanced delimiters, no try!/as!/fatalError/print in app code; with --tree-sitter, a
# full syntax parse (tree-sitter-swift installed outside the repository, see the script)
# and no SwiftUI view-builder block with more than ten children
node apps/ios/scripts/check-swift.mjs [--tree-sitter <node_modules dir>]
# Regenerate the app icon (1024×1024 PNG, no dependencies)
node apps/ios/scripts/make-app-icon.mjs
```

## Language

The app's language follows iOS: *Settings → Apps → JARVIS → Language* (or the system
language). It can differ from the language set on your JARVIS account, which the server
uses for its own messages. Strings live in String Catalogs:
`Jarvis/Resources/Localizable.xcstrings` (UI), `InfoPlist.xcstrings` (permission prompts)
and `AppShortcuts.xcstrings` (Siri phrases). `CFBundleLocalizations` in Info.plist lists
en, de and ar. If, after `xcodegen generate`, Xcode's *Project → Info → Localizations*
does not list German and Arabic, add them there once (the catalogs already contain every
translation; XcodeGen derives that list from `.lproj` folders, which this project does not
use).

## Siri and Shortcuts

"Ask JARVIS" (also "Frag JARVIS", "اسأل JARVIS") creates a task with your signed-in
session and tells you its title and status. It never approves anything — actions that need
approval wait for you in the app.

## Phase B on iPhone

- **Conversations** (tab): history with search, a schedule badge and an in-progress
  indicator; the thread shows each request, its task (live) and JARVIS's answer, result or
  question. The composer at the bottom sends a follow-up (`POST /v1/conversations/:id/messages`)
  with text, voice or files; while a task of the conversation is still active it is disabled
  and says which task to wait for. A finished task's screen has **Follow up**, which opens
  its conversation with the composer ready.
- **Clarifying questions**: a completed task with `outcome: "question"` reads "Needs your
  answer" (never "Completed"); the question is shown in the app's language when the server
  composed it, with what is missing, and **Reply** (plus **Attach the file** when a document
  is missing).
- **Attachments**: the paper clip opens the Files picker (PDF, DOCX, TXT, MD, CSV). Each file
  is checked on the device first (10 MB, at most 5 per request, extension and content must
  agree), uploaded with progress, and can be removed (deleted on the server) or retried.
  Sending waits until uploads finish. Attached files open in Quick Look (download with the
  signed-in session; only the owner can) and can be shared from there. When the server
  reports uploads as unavailable, the button is disabled and says so.
- **Schedules** (Tasks › Schedules, or Settings): list with status and next run in the
  schedule's own zone, pause/resume/delete, detail with upcoming runs and run history linking
  to tasks, and an editor (daily, weekly on chosen days, monthly on one day or the last day;
  interval, time, zone from the server's list) with the server's live preview of the next
  runs. Rules the editor can't represent exactly (several days of a month, values from a
  newer server) are kept: only the name and request can change here, and the screen says to
  change the timing on the web. Creating your own schedule is always offered (below the
  per-account cap); the scheduling skill only governs whether JARVIS proposes schedules from
  requests, as on the web.
- **Settings**: Skills (read-only catalog with real availability and the reason when a skill
  can't run; switching happens on the web), automatic deletion of memories and task history,
  and the account time zone (only zones the server accepts).

## Phase C on iPhone

- **Connections** (Settings › Connected services, or from a failed task / Home): Google and
  Microsoft cards from `GET /v1/connections/providers` — "Not configured on this server"
  when the server has no client for it; capability toggles in plain language with the
  exact scopes behind a disclosure; **Continue to Google/Microsoft** (see the OAuth set-up
  above); an expired connection shows why (`statusReason`) and **Reconnect**, asking for the
  same permissions as before; **Allow at …** adds capabilities incrementally; **Disconnect**
  says what happens at the provider (Google revokes; Microsoft is local-only, with where to
  remove the app). After connecting, the server's answer is shown — never assumed — with
  **Retry** for every task that had stopped because the connection expired (scenario 9).
  SMTP and web access are listed read-only (set up on the web).
- **Home "Upcoming"** appears only when the server sends `upcoming` (a calendar grants
  calendar.read): events grouped by day in your zone, times in the event's own zone (its
  zone name is added when it differs), all-day events, a calendar that is expired or didn't
  answer named with its fix (Reconnect / Connections). Tapping an event opens it at the
  provider (https links only).
- **Approvals**: `calendar_event` (title, time and zone — also in yours when different —
  location, description, calendar account, every guest and whether they are emailed, what an
  update or cancellation replaces, the free/busy re-check), `booking` (service, site, slot in
  the site's zone, every form field with personal ones marked, price or "states no price",
  binding with the site's terms as shown, the screenshot JARVIS relied on), `purchase`
  (merchant, items with quantities and unit prices, subtotal, shipping, tax, total, delivery
  method, estimate and address, payment method, the monthly limit bar, the cart screenshot;
  **Approve and buy**), `form_submission`, and email drafts (**Approve and save draft**,
  "nothing is sent") and the sending route (`via`). A kind or value this build doesn't know is
  still never approvable.
- **Task detail**: the browser agent's sessions (site, operation, status, why it stopped,
  **Continue on the site** for CAPTCHA / sign-in / bot walls, pages / requests / blocked
  counts, screenshot thumbnails and evidence files opened in Quick Look), comparisons
  (offers ranked by known total with shipping, "Lowest known total", mixed currencies never
  converted, each shop's outcome), carts (and **Open the cart on the shop** where checkout
  isn't supported), free appointments as the site showed them, mail and calendar text marked
  as written by others (with the injection warning), drafts and reply tracking, and the
  order / booking records the steps made (status, totals, reference, evidence). Every new
  failure reason has copy and, where there is one, its next action (Reconnect, Open purchase
  limit, Continue on the site, Open the cart, Check your orders / bookings).
- **Settings › Spending**: the monthly purchase limit (0 = purchases off, the default; whole
  dollars up to $10,000; raising it asks for confirmation and only the limit is sent), the AI
  budget shown separately, and the **Orders** and **Bookings** history. **Reply tracking**
  lists watched threads with **Stop watching**.
