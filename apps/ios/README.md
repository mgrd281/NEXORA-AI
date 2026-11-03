# JARVIS for iPhone

Native SwiftUI client for the JARVIS API: sign in, ask in text or by voice, follow tasks
live, review and approve exactly what JARVIS will do, manage memory, sessions and
preferences. English, German and Arabic (right-to-left), light and dark, Dynamic Type,
VoiceOver and Reduce Motion are supported throughout.

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

## Tests

```sh
xcodebuild test -project Jarvis.xcodeproj -scheme Jarvis \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

| Suite | Covers |
| --- | --- |
| `ModelDecodingTests` | Real JSON fixtures shaped like the contracts: `TaskDetail` (steps, approvals, events, evidence), `HomeSnapshot`, `ApiErrorBody`, `Me`, `LoginResponse`, pages, stream events; timestamp forms; unknown enum values decoding to `.unknown` |
| `SSEParserTests` | Server framing, multi-line `data`, comments/heartbeats, ids and resume position, `retry`, CR/LF/CRLF, BOM, UTF-8, reconnect back-off |
| `PresenceStateTests` | Mapping of voice, connection, approvals, tasks and recent outcomes to Presence states; animation and VoiceOver labels |
| `RequestBuildingTests` | URLs, headers (bearer, `Idempotency-Key`, `Content-Type` only with a body), request bodies, API address policy, task state machine |

## Verification without Xcode

These run with Node from the repository root and need no Apple tooling:

```sh
# Fixtures parse with the Zod contract schemas, exactly (no stripped keys or defaults)
pnpm --filter @jarvis/api exec tsx ../ios/scripts/validate-fixtures.ts
# Every localizable Swift literal has en/de/ar; specifiers and App Shortcut phrases match
node apps/ios/scripts/lint-strings.mjs
# Balanced delimiters, no try!/as!/fatalError/print in app code
node apps/ios/scripts/check-swift.mjs
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
