# Test the iPhone app against your Railway deployment

Arabic version: [ios-testing.ar.md](ios-testing.ar.md). Deploy the server first:
[deploy-railway.md](deploy-railway.md) (you need its **API domain**, §7, and your **owner
account**, §10). Background on the app: [apps/ios/README.md](../../apps/ios/README.md) and
[apps/ios/ARCHITECTURE.md](../../apps/ios/ARCHITECTURE.md).

> **The iPhone app has never been compiled.** It was written in an environment without Xcode or a
> Swift toolchain. It has been checked structurally (JSON fixtures against the API contracts,
> enum and copy coverage, string catalogs, a Swift syntax parse), but **not type-checked, built or
> run**. Expect the first build to show compiler errors. That is normal for this stage: copy them as
> described in [§5](#5-if-the-build-fails-send-the-errors) and send them back, and they will be
> fixed. Nothing you do here can harm the server or your data.

## 1. What you need

| Item                                | Notes                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Mac with **Xcode 16 or later**    | The project uses Swift 6 language mode and the iOS 18 SDK. Open Xcode once so it installs its components                                           |
| **Homebrew** and **XcodeGen** 2.42+ | `brew install xcodegen` — the Xcode project is generated from `apps/ios/project.yml` and not committed                                             |
| An **Apple ID**                     | A free Apple ID is enough to run the app on **your own** iPhone. TestFlight or giving the app to others needs the paid **Apple Developer Program** |
| An **iPhone with iOS 18** or later  | And its USB cable for the first run                                                                                                                |
| The **API domain**                  | e.g. `https://api-production-xxxx.up.railway.app` — check it answers: `curl -s https://<api domain>/readyz` → `{"ok":true,"database":true}`        |

## 2. Point the app at your API and generate the project

```bash
cd NEXORA-AI && git pull            # the clone from the deployment guide
cd apps/ios
cat > Config/Local.xcconfig <<'EOF'
// Per-developer settings, git-ignored. "//" starts a comment in xcconfig files,
// hence $() between the two slashes of https://.
JARVIS_API_BASE_URL = https:/$()/api-production-xxxx.up.railway.app
EOF
xcodegen generate                    # writes Jarvis.xcodeproj
open Jarvis.xcodeproj
```

- Replace the host with **your API domain** — the `api` service's domain, **not** the web
  domain, without a path and without a trailing `/`.
- `Config/Local.xcconfig` is included by both the Debug and Release configurations and is ignored
  by git. The app accepts only `https` addresses (plain `http` only for `localhost`); with anything
  else it shows a configuration screen instead of the sign-in.
- Run `xcodegen generate` again after every `git pull` that changes `apps/ios` (it overwrites
  changes made in Xcode's project settings).
- Languages: if Xcode → project **Jarvis** → **Info** → **Localizations** does not list German and
  Arabic after generating, add them there once (the string catalogs already contain every
  translation).

## 3. Signing (once)

1. Xcode → **Settings** → **Accounts** → **+** → Apple ID → sign in.
2. Select the project **Jarvis** in the navigator → target **Jarvis** → **Signing & Capabilities**
   → **Team**: your name _(Personal Team)_. Leave _Automatically manage signing_ on. Do the same for
   the target **JarvisTests** if you want to run the tests.
3. If Xcode reports that the bundle identifier `ai.jarvis.app` is not available, change
   **Bundle Identifier** to something unique such as `com.yourname.jarvis`. To keep it after the
   next `xcodegen generate`, change `PRODUCT_BUNDLE_IDENTIFIER` in `apps/ios/project.yml` the same
   way.

With a free Personal Team (Apple's rules, which may change): the app stops opening after **7
days** (run it from Xcode again to reinstall), and capabilities such as **Associated Domains** are
not available (only needed for connecting Google/Microsoft from the phone, §7).

## 4. Run in the Simulator first

1. In the toolbar choose the scheme **Jarvis** and an iPhone simulator with iOS 18 or later.
2. **Product → Run** (⌘R). The first build takes a few minutes.
3. If it builds: the app opens on the sign-in screen. Sign in with the owner email and password
   from the deployment guide. Try Home, ask something, open a task, approve or decline, Settings.

If the build fails, continue with §5.

## 5. If the build fails: send the errors

**In Xcode:** open the **Issue navigator** (⌘5), click into the list, select everything (⌘A),
copy (⌘C) and paste it into a text file. Only the red **errors** matter; warnings can wait.

**Or in Terminal** (writes every distinct error to a file on your Desktop):

```bash
cd NEXORA-AI/apps/ios
xcrun simctl list devices available | grep -i iphone      # pick an installed simulator name
xcodebuild -project Jarvis.xcodeproj -scheme Jarvis \
  -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 \
  | grep -E "error:" | sort -u > ~/Desktop/jarvis-ios-errors.txt
wc -l ~/Desktop/jarvis-ios-errors.txt
```

Replace `iPhone 16` with a name from the first command if it is not installed. Send back:

1. the file `jarvis-ios-errors.txt` (or the copied list),
2. the output of `xcodebuild -version` and `sw_vers -productVersion`,
3. which step failed (generate, build, run, sign-in) and, for a crash, a screenshot.

The errors contain file names and line numbers of this repository only — no secrets. One round
of fixes often uncovers the next errors (the compiler stops at some kinds of errors), so expect
two or three rounds.

**Where errors are most likely** (from ARCHITECTURE.md and the iOS authors' notes):

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`): messages about
  `@MainActor`, `Sendable`, `nonisolated`, "sending … risks causing data races" or "main
  actor-isolated … from a nonisolated context". The `@unchecked Sendable` types (`SpeechSession`,
  `ConversationAudioEngine`, the audio-tap boxes, the speech-synthesizer delegate) are the most
  delicate.
- **Signing in to Google/Microsoft** (`Features/Connections/OAuthFlow.swift`): the SwiftUI
  `WebAuthenticationSession.authenticate(using:callback:preferredBrowserSession:additionalHeaderFields:)`
  signature (iOS 17.4 SDK) and `ASWebAuthenticationSession` callback types were written from the
  documentation without a compiler.
- **Localization**: the `.xcstrings` catalogs (`Localizable`, `InfoPlist`, `AppShortcuts`) and the
  localizations list (see §2); App Shortcuts phrases (`Intents/AskJarvisIntent.swift`, AppIntents).
- **Speech and audio** (Speech, AVFoundation) for voice mode — these compile in the Simulator but
  only really work on a device.
- SwiftUI view builders were kept to at most ten children, so "extra argument" errors there would
  be surprising — report them anyway.

## 6. Run on your iPhone

1. Connect the iPhone with the cable, unlock it and tap **Trust** on "Trust This Computer?".
2. Choose the iPhone as the run destination in Xcode. The first time, iOS asks you to enable
   **Developer Mode**: iPhone **Settings → Privacy & Security → Developer Mode → On**, restart, and
   confirm.
3. **Product → Run** (⌘R).
4. If iOS says the developer is not trusted: **Settings → General → VPN & Device Management** →
   your Apple ID → **Trust**. Run again.
5. Sign in with the owner account. Things to try: ask in text; the voice button (allow the
   microphone and speech recognition when asked); a task's live progress; an approval; Settings →
   Sessions (the iPhone appears as its own session — you can revoke it from the web).

After the first run the cable is not needed every time if Xcode lists the phone for network runs
(_Window → Devices and Simulators → Connect via network_).

## 7. What works, and what needs more set-up

| Feature                                                                     | Status for this test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in, Home, tasks, approvals, memory, conversations, schedules, settings | Should work against the deployed API once it builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Voice                                                                       | On the device (speech recognition and synthesis are Apple's)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Attachments                                                                 | Only if the server has file storage (deployment guide §13.2); otherwise the app says uploads are unavailable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Web access, SMTP email                                                      | Set up **on the web**; then they work from the app too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Google / Microsoft                                                          | Connect them **on the web**; the connection then works in the app. Connecting **from the iPhone** is off by default and **skipped for the first test**: it needs `JARVIS_OAUTH_REDIRECT_URI` / `JARVIS_OAUTH_CALLBACK_HOST` / `JARVIS_ENTITLEMENTS` in `Local.xcconfig`, the same https redirect URI registered at the provider and in `OAUTH_REDIRECT_URIS`, the **Associated Domains** capability (paid Apple Developer Program) and an `apple-app-site-association` file served from the web domain — which the web app does **not** serve yet ([apps/ios/README.md](../../apps/ios/README.md#connecting-google-and-microsoft-from-the-iphone-oauth)) |
| Phone calls                                                                 | Only if Twilio is configured on the server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 8. Later: TestFlight

Needs the Apple Developer Program: create the app in App Store Connect with your bundle
identifier, keep `JARVIS_API_BASE_URL` in `Local.xcconfig` (Release builds have no default and
refuse to start without an https address), **Product → Archive**, then **Distribute App → TestFlight**.
Not needed for testing on your own phone.

## 9. Troubleshooting

| Symptom                                                     | Fix                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xcodegen: command not found`                               | `brew install xcodegen`                                                                                                                                                        |
| The app shows a configuration screen instead of sign-in     | `JARVIS_API_BASE_URL` is missing, not https, or has a path/query. Check `Config/Local.xcconfig` (`https:/$()/host`), then **Product → Clean Build Folder** (⇧⌘K) and run again |
| "Signing for Jarvis requires a development team"            | §3 step 2                                                                                                                                                                      |
| "Failed to register bundle identifier"                      | §3 step 3                                                                                                                                                                      |
| "Untrusted Developer" / the app does not open on the iPhone | §6 step 4; after 7 days with a free account, run it from Xcode again                                                                                                           |
| Developer Mode does not appear                              | Connect the phone to Xcode once and choose it as the destination; then look again                                                                                              |
| Sign-in fails: "could not connect" / timeout                | Open `https://<api domain>/readyz` in Safari on the iPhone. If that fails, the API (or its public domain) is not up — see the deployment guide §17                             |
| Sign-in fails: wrong email or password                      | Use the owner account from `create-owner`; after 10 attempts in a minute the server answers "Too many requests" — wait a minute                                                |
| Simulator `iPhone 16` not found                             | `xcrun simctl list devices available` and use a listed name                                                                                                                    |
