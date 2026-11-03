# ADR-0013: iOS app in SwiftUI; Android and macOS in Phase 6

- Status: Accepted
- Date: 2026-11-03

## Context

The owner uses JARVIS on iPhone: quick voice requests, approval on the go, Siri/Shortcuts entry
points. Native apps must reuse the same contracts and design tokens as the web.

## Decision

- **SwiftUI + Observation** (`@Observable` models), deployment target iOS 18.0, Swift 6 with complete
  strict concurrency checking.
- **XcodeGen** project spec `apps/ios/project.yml` (the `.xcodeproj` is generated with
  `xcodegen generate`, not hand-edited).
- **Auth:** bearer token from `POST /v1/auth/login` (`platform: "ios"`), stored in the Keychain
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), never in `UserDefaults`.
- **Realtime:** `URLSession` bytes stream on `GET /v1/events` with `Last-Event-ID` resume.
- **Voice:** `SFSpeechRecognizer`, with `requiresOnDeviceRecognition` where the device and locale
  support it; recognised text is submitted as a task (`source: "voice"`); audio never leaves the device
  through JARVIS. Voice sessions record metadata only (`/v1/voice-sessions`).
- **App Intents** for Siri and Shortcuts ("Ask JARVIS …"), routed through the same task API and
  approval rules — an intent can never approve an action by itself.
- **Design:** generated `Tokens.swift`, `Color+Meridian`, `Typography` (system font, Dynamic Type),
  SF Symbols names from `tokens.icons`.

Status: Milestone 1 (in progress). This environment has no Swift toolchain, so the app is not compiled
or tested here ([known limitations](../known-limitations.md)).

## Alternatives considered

- **React Native / Expo.** Code sharing with web, but weaker access to Speech, App Intents, Keychain
  and widgets, and a less native feel.
- **Kotlin Multiplatform shared core.** Attractive for Android later; premature before Android exists.
- **Web-only (PWA).** No Siri/Shortcuts, weaker background behaviour and speech.

## Consequences

- Swift models mirror `@jarvis/contracts` by hand and are checked against `docs/api/openapi.json`
  in review.
- **Phase 6:** Android in Jetpack Compose (using generated `Tokens.kt`, bearer tokens in Android
  Keystore-backed storage) and macOS via SwiftUI multiplatform, both reusing contracts and tokens.
