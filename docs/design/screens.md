# Screens

Specification of the Milestone 1 screens for web and iOS (Milestone 1 (in progress)). Data comes from
the contracts in `packages/contracts`; every state shown must map to stored or live server state.
Tokens and components: [design system](design-system.md). Review: [review process](review-process.md).

Common rules for every screen:

- **Loading:** skeletons matching the final layout (no fake text); keep previous data visible while
  refetching.
- **Error:** inline message with the API's user-safe `error.message`, a retry action and the
  `requestId` behind a "Details" disclosure.
- **Offline (device has no network):** banner "You're offline — changes will not be sent"; mutations
  disabled; cached data marked as possibly stale. When the stream reconnects, refetch and replay with
  `Last-Event-ID`.
- **Assistant unavailable** (worker unhealthy): banner "JARVIS is unavailable — tasks will wait"; task
  submission still works (tasks queue) and the UI says they are queued.
- **Responsive:** < 900 px bottom tab bar (Home, Tasks, Memory, Settings) and full-screen sheets;
  ≥ 900 px start-side sidebar (248 px) and content max 760 px (1080 px for Task Center and Admin).
- **RTL:** logical layout; `dir="ltr"` islands for URLs, emails, hashes, Message-IDs.
- **Accessibility:** one `h1` per screen; landmarks (`nav`, `main`); visible focus; every control
  ≥ 44 px; live regions only for meaningful changes.

## Sign-in

| Aspect         | Specification                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal      | Get into JARVIS securely                                                                                                                                                                           |
| Hierarchy      | Product name → email → password → Sign in → note "Accounts are by invitation"                                                                                                                      |
| Primary action | Sign in (ink button)                                                                                                                                                                               |
| Secondary      | Language switch (en/de/ar)                                                                                                                                                                         |
| States         | Idle; submitting (button busy, fields disabled); error `UNAUTHENTICATED` → "Email or password is incorrect" (no hint which); `RATE_LIMITED` → "Too many attempts. Try again in a minute."; offline |
| Responsive     | Single centred column (max 400 px) at all sizes                                                                                                                                                    |
| RTL            | Fields and labels mirror; email and password inputs stay `dir="ltr"`                                                                                                                               |
| Accessibility  | Labels bound to inputs; `autocomplete="username"` / `"current-password"`; errors announced and linked with `aria-describedby`; no CAPTCHA                                                          |
| Data           | `POST /v1/auth/login` (`platform: web`, or `ios` with `deviceName`)                                                                                                                                |

## Home

| Aspect         | Specification                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal      | Ask for something; see what needs attention                                                                                                                                                     |
| Hierarchy      | Greeting + Presence → command bar (with voice button) → pending approvals → active tasks → recent results → suggestions                                                                         |
| Primary action | Submit a request                                                                                                                                                                                |
| Secondary      | Open an approval; open a task; voice; follow a suggestion (connect web/email, try a command)                                                                                                    |
| States         | Empty (first use): suggestions from `HomeSnapshot.suggestions` (e.g. "Enable web access", "Connect your email"), no fake examples; offline planner banner with `planner.reason`; loading; error |
| Live           | SSE events update approvals, active tasks and Presence without reload                                                                                                                           |
| Responsive     | Mobile: command bar sticky at the bottom above the tab bar; desktop: at the top of the content column                                                                                           |
| RTL            | Command bar send button on the end side; arrows mirrored                                                                                                                                        |
| Accessibility  | Command bar is a labelled `textarea`; ⌘/Ctrl+K focuses it; new approval announced politely once                                                                                                 |
| Data           | `GET /v1/home`, `GET /v1/assistant/status`, `POST /v1/tasks` (with `Idempotency-Key`), `GET /v1/events`                                                                                         |

## Voice mode

| Aspect         | Specification                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User goal      | Dictate a request hands-free and send it                                                                                                                                                                                 |
| Hierarchy      | Live transcript (large) → Presence "Listening…" → Stop / Send / Cancel → engine note                                                                                                                                     |
| Primary action | Send transcript as a task (`source: voice`, `language`)                                                                                                                                                                  |
| Secondary      | Cancel; edit the transcript before sending; switch recognition language (`auto`, en-US, de-DE, ar-SA)                                                                                                                    |
| States         | Permission needed (explain why, then request); permission denied (how to enable); listening; processing; no speech (`no_speech`); error; unsupported browser ("Voice input is not available in this browser")            |
| Privacy        | Always shows which engine processes audio: web "Your browser's speech service (may process audio on the browser vendor's servers)"; iOS "On this iPhone" when on-device recognition is used. JARVIS never receives audio |
| Responsive     | Full-screen sheet on mobile; centred dialog (max 560 px) on desktop                                                                                                                                                      |
| RTL            | Transcript direction follows the recognised language (`dir="auto"`)                                                                                                                                                      |
| Accessibility  | Works by keyboard (Space to start/stop); transcript in a live region; reduced motion → static listening indicator; captions are the transcript itself                                                                    |
| Data           | `POST /v1/voice-sessions` → `POST /v1/tasks` (`voiceSessionId`) → `POST /v1/voice-sessions/:id/end` (outcome, `transcriptChars`)                                                                                         |

## Task Center

| Aspect         | Specification                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal      | Find and review tasks                                                                                                                              |
| Hierarchy      | Title → filter tabs (Active, Needs approval, Completed, Failed, All) → task list (title, state chip, progress n/m, risk, updated time) → load more |
| Primary action | Open a task                                                                                                                                        |
| Secondary      | Filter; approve directly from "Needs approval" rows (opens the approval sheet)                                                                     |
| States         | Empty per filter ("No failed tasks"); loading; error; end of list                                                                                  |
| Live           | Rows update state from SSE; new tasks appear at the top                                                                                            |
| Responsive     | Mobile: cards; desktop: table-like rows within 1080 px                                                                                             |
| RTL            | Progress and chevrons mirror                                                                                                                       |
| Accessibility  | Tabs as `tablist`; each row a link with accessible name "<title>, <state>, updated <time>"                                                         |
| Data           | `GET /v1/tasks?status=&cursor=&limit=`                                                                                                             |

## Task detail

| Aspect         | Specification                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User goal      | Understand what JARVIS planned, did and proved                                                                                                                                                                                                                                                   |
| Hierarchy      | Title + state chip + Presence → request (as typed) → result summary / streaming answer → pending approval callout → steps (tool, risk, policy reasons, input preview, output, evidence, attempts) → evidence list → timeline → cost (estimated vs. actual) → planner info (model/offline)        |
| Primary action | Depends on state: Review approval (awaiting), Retry (`canRetry`), none (completed)                                                                                                                                                                                                               |
| Secondary      | Cancel (`canCancel`, confirmation); copy evidence values; open source URL                                                                                                                                                                                                                        |
| States         | Queued; planning; awaiting approval; running (current step highlighted); verifying; completed; failed (error message, `retryable`); cancelled; expired; `OUTCOME_UNKNOWN` (warning: "Check your Sent folder before retrying"; retry requires an explicit checkbox → `acknowledgeUnknownOutcome`) |
| Live           | Status, steps, approvals, answer deltas via SSE; refetch on `plan.ready`, `verification.*`, `task.status_changed`                                                                                                                                                                                |
| Responsive     | Mobile: single column, steps collapsible; desktop: steps and evidence side by side ≥ 1200 px                                                                                                                                                                                                     |
| RTL            | Timeline line on the start side; evidence values (`sha256:…`, Message-ID, URLs) in LTR islands                                                                                                                                                                                                   |
| Accessibility  | Steps as an ordered list; state changes announced once; streaming answer region `aria-busy` until final                                                                                                                                                                                          |
| Data           | `GET /v1/tasks/:id`, `POST /v1/tasks/:id/cancel`, `POST /v1/tasks/:id/retry`                                                                                                                                                                                                                     |

## Approval sheet

| Aspect         | Specification                                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal      | Decide on exactly what will happen                                                                                                                                                                                                                                          |
| Hierarchy      | Summary sentence → risk badge + reasons in plain language → exact details (email: From, To — every address, Subject, full Body, scrollable) → "Suspected instructions aimed at AI were found in the source" warning if `UNTRUSTED_CONTENT` → expiry time → Approve / Reject |
| Primary action | Approve (ink) — sends `{ decision: approve, actionHash }` with an `Idempotency-Key`                                                                                                                                                                                         |
| Secondary      | Reject (outline), optional note; open the task                                                                                                                                                                                                                              |
| States         | Loading; ready; deciding (both buttons disabled); `APPROVAL_MISMATCH` → reload the approval and show "The action changed — review it again"; `APPROVAL_EXPIRED` → "This request expired" with Retry task; already decided (`INVALID_STATE`) → show result                   |
| Responsive     | Bottom sheet (mobile, radius xl, drag handle); side panel or dialog (desktop, max 640 px)                                                                                                                                                                                   |
| RTL            | Field labels mirror; addresses and body direction `auto`                                                                                                                                                                                                                    |
| Accessibility  | Focus moves into the sheet and is trapped; Esc closes without deciding; buttons have explicit names ("Approve sending this email")                                                                                                                                          |
| Data           | `GET /v1/approvals`, `POST /v1/approvals/:id/decision`                                                                                                                                                                                                                      |

## Memory

| Aspect         | Specification                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| User goal      | See and control what JARVIS remembers                                                                                   |
| Hierarchy      | Title + memory on/off state → search → add memory → list (content, kind, source "You" / "JARVIS", date) → Delete all    |
| Primary action | Add a memory                                                                                                            |
| Secondary      | Edit, delete one, delete all (destructive dialog), search                                                               |
| States         | Memory disabled (banner + link to Settings; list still visible and deletable); empty; no search results; loading; error |
| Responsive     | Single column; inline edit on desktop, edit sheet on mobile                                                             |
| RTL            | Content `dir="auto"` per memory                                                                                         |
| Accessibility  | Delete buttons named "Delete memory: <first words>"; destructive dialog requires explicit confirmation                  |
| Data           | `GET/POST /v1/memories`, `PATCH/DELETE /v1/memories/:id`, `DELETE /v1/memories`                                         |

## Connections

| Aspect         | Specification                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal      | Allow JARVIS to read the web and send email                                                                                                                         |
| Hierarchy      | Web access card (status, Enable) → Email (SMTP) card (status, sender address, last verified, last error, Connect / Test / Disconnect)                               |
| Primary action | Enable web access; Connect email                                                                                                                                    |
| Secondary      | Test, Disconnect (confirmation: "Stored credentials will be erased")                                                                                                |
| SMTP form      | Label, host, port, security (TLS 465 / STARTTLS 587; "none" only shown in development), username, password, from address, from name; Connect verifies before saving |
| States         | Not connected; active; error (`lastError`, e.g. "The mail server rejected the username or password."); verifying; `CONNECTION_FAILED` inline; rate limited          |
| Live           | `connection.changed` events update cards                                                                                                                            |
| Responsive     | Cards stack; form full-screen on mobile                                                                                                                             |
| RTL            | Host, port, addresses LTR inputs                                                                                                                                    |
| Accessibility  | Password field with show/hide toggle; errors linked to fields                                                                                                       |
| Data           | `GET /v1/connections`, `POST /v1/connections/web`, `POST /v1/connections/smtp`, `POST /v1/connections/:id/test`, `DELETE /v1/connections/:id`                       |

## Settings

| Aspect         | Specification                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal      | Make JARVIS behave the way I want                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Groups         | Profile (name, language, time zone, theme) · Assistant (planner mode and reason, worker status, version) · Voice (read responses aloud, recognition language) · Autonomy ("Send emails to myself without asking", with the exact rule explained) · Privacy (use external AI models, memory on/off) · Notifications (approval requested, completed, failed) · Spending (monthly AI budget, this month's usage) · Sessions (devices, revoke) · Data (export, delete account) |
| Primary action | Each control saves on change (`PATCH /v1/me`) with a saved indicator                                                                                                                                                                                                                                                                                                                                                                                                       |
| Secondary      | Export data (downloads JSON); Delete account (password + type `DELETE`)                                                                                                                                                                                                                                                                                                                                                                                                    |
| States         | Saving; saved; error (control reverts); budget exhausted banner; offline                                                                                                                                                                                                                                                                                                                                                                                                   |
| Responsive     | Grouped list; desktop two-column (group nav at start)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| RTL            | Toggles mirror (on = end side)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Accessibility  | Toggles are switches with labels and descriptions; destructive actions separated and confirmed                                                                                                                                                                                                                                                                                                                                                                             |
| Data           | `GET/PATCH /v1/me`, `GET /v1/usage`, `GET /v1/assistant/status`, `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`, `POST /v1/account/export`, `POST /v1/account/delete`, `POST /v1/auth/logout`                                                                                                                                                                                                                                                                     |

## Admin

| Aspect                     | Specification                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User goal (platform admin) | Know whether the system is healthy and affordable — without seeing anyone's content                                                                                                                                              |
| Hierarchy                  | Health tiles (database, worker + last heartbeat, planner mode, queue depth) → users (total, active 7 d) → tasks by status → tool reliability (executions, succeeded, failed, p50, p95) → 30-day cost → Users table → Audit table |
| Primary action             | None (read-only); refresh                                                                                                                                                                                                        |
| Secondary                  | Paginate users and audit                                                                                                                                                                                                         |
| States                     | Forbidden (non-admin: 403 screen, no admin nav item); loading; error; empty reliability (no executions yet)                                                                                                                      |
| Privacy                    | Shows emails, tenant names, roles and counts only; audit rows without metadata; a note "Admin views are audited"                                                                                                                 |
| Responsive                 | Tiles grid; tables scroll horizontally inside their container on mobile                                                                                                                                                          |
| RTL                        | Tables mirror column order; numbers stay LTR                                                                                                                                                                                     |
| Accessibility              | Tables with headers and captions; tiles have text values, not just charts                                                                                                                                                        |
| Data                       | `GET /v1/admin/overview`, `GET /v1/admin/users`, `GET /v1/admin/audit`                                                                                                                                                           |
