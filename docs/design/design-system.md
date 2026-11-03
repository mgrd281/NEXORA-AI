# Meridian design system

Meridian is the design language of JARVIS on every platform. Source of truth:
`packages/tokens/src/tokens.ts`; generated outputs: `packages/tokens/generated/tokens.css`,
`generated/tokens.json`, `generated/Tokens.kt`, `apps/ios/Jarvis/DesignSystem/Tokens.swift`
(`pnpm tokens:build`). All tables below were generated from `tokens.ts` values; if they disagree with
the file, the file wins. Decision record: [ADR-0011](../adr/0011-meridian-design-system.md).

## 1. Principles

1. **Calm, precise, honest.** Quiet surfaces; information first; the interface never claims progress
   that is not happening.
2. **Ink acts, Ion signals.** Primary actions are ink (near-black on light, near-white on dark). The
   Ion accent is reserved for focus, links, live AI activity and the Presence indicator, so blue
   always means "JARVIS is doing something" or "you can go here".
3. **Hairlines over shadows.** Borders separate; shadows only for floating layers (popovers, sheets).
4. **Never colour alone.** Every state has a label and an icon besides its tone.
5. **One grid.** 4-pt grid, 8-pt defaults; generous line heights for Latin, German and Arabic.
6. **Direction-agnostic.** Layout uses logical directions (start/end); Arabic mirrors without
   special-case components.
7. **Accessible by construction.** Every rendered text pair ≥ 4.5:1; focus and control boundaries
   ≥ 3:1; 44 px touch targets; reduced motion honoured.

## 2. Color

CSS variables are defined on `:root` (light, default), under
`@media (prefers-color-scheme: dark)` for `:root:not([data-theme='light'])`, and under
`:root[data-theme='dark']` (explicit choice wins over the OS).

| Token           | CSS variable              | Light                    | Dark                  |
| --------------- | ------------------------- | ------------------------ | --------------------- |
| `canvas`        | `--color-canvas`          | `#F7F7F4`                | `#0E0F12`             |
| `surface`       | `--color-surface`         | `#FFFFFF`                | `#161719`             |
| `surfaceSunken` | `--color-surface-sunken`  | `#F1F0ED`                | `#0A0B0D`             |
| `surfaceHover`  | `--color-surface-hover`   | `#ECEBE8`                | `#1F2023`             |
| `overlay`       | `--color-overlay`         | `rgba(23, 24, 27, 0.32)` | `rgba(0, 0, 0, 0.56)` |
| `border`        | `--color-border`          | `#E0E0DD`                | `#292A2D`             |
| `borderStrong`  | `--color-border-strong`   | `#CBCAC7`                | `#3F4042`             |
| `borderControl` | `--color-border-control`  | `#8B8C90`                | `#68696D`             |
| `textPrimary`   | `--color-text-primary`    | `#17181B`                | `#ECEDEF`             |
| `textSecondary` | `--color-text-secondary`  | `#595B5F`                | `#A9ABB0`             |
| `textTertiary`  | `--color-text-tertiary`   | `#686A6F`                | `#8A8C91`             |
| `textInverse`   | `--color-text-inverse`    | `#FFFFFF`                | `#0E0F12`             |
| `ink`           | `--color-ink`             | `#17181B`                | `#ECEDEF`             |
| `inkHover`      | `--color-ink-hover`       | `#2E3035`                | `#FFFFFF`             |
| `onInk`         | `--color-on-ink`          | `#FFFFFF`                | `#0E0F12`             |
| `accent`        | `--color-accent`          | `#3959DA`                | `#8EADFF`             |
| `accentHover`   | `--color-accent-hover`    | `#2D49C9`                | `#A5BEFF`             |
| `accentSoft`    | `--color-accent-soft`     | `#E9F0FF`                | `#1A2444`             |
| `accentOnSoft`  | `--color-accent-on-soft`  | `#304CCC`                | `#9FBBFF`             |
| `onAccent`      | `--color-on-accent`       | `#FFFFFF`                | `#0E0F12`             |
| `focusRing`     | `--color-focus-ring`      | `#3959DA`                | `#8EADFF`             |
| `success`       | `--color-success`         | `#007834`                | `#76CF8A`             |
| `successSoft`   | `--color-success-soft`    | `#E2F9E6`                | `#102B17`             |
| `warning`       | `--color-warning`         | `#9A5600`                | `#ECA851`             |
| `warningSoft`   | `--color-warning-soft`    | `#FFEED9`                | `#331F05`             |
| `danger`        | `--color-danger`          | `#A43B38`                | `#FF958D`             |
| `dangerSoft`    | `--color-danger-soft`     | `#FFE9E6`                | `#391917`             |
| `dangerSolid`   | `--color-danger-solid`    | `#C13C3B`                | `#FF958D`             |
| `onDangerSolid` | `--color-on-danger-solid` | `#FFFFFF`                | `#0E0F12`             |

### Color roles

| Role               | Tokens                                                                         | Use                                                                       |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Background         | `canvas`, `surface`, `surfaceSunken`, `surfaceHover`, `overlay`                | Page, cards/sheets, inset areas (code, evidence), hover rows, modal scrim |
| Separation         | `border`, `borderStrong`, `borderControl`                                      | Hairlines, emphasized dividers, input/toggle boundaries                   |
| Text               | `textPrimary`, `textSecondary`, `textTertiary`, `textInverse`                  | Body, supporting text, metadata/timestamps, text on inverse surfaces      |
| Primary action     | `ink`, `inkHover`, `onInk`                                                     | Primary buttons (Approve, Send, Sign in)                                  |
| Ion accent         | `accent`, `accentHover`, `accentSoft`, `accentOnSoft`, `onAccent`, `focusRing` | Links, focus, live activity (planning/running/verifying), Presence        |
| Status             | `success*`, `warning*`, `danger*`                                              | Completed, awaiting approval / near limit, failed / destructive           |
| Destructive action | `dangerSolid`, `onDangerSolid`                                                 | Delete account, Delete all memories, Disconnect (confirmation step)       |

### Contrast results (WCAG 2.2)

Computed with the WCAG relative-luminance formula, the same pairs as
`packages/tokens/test/contrast.test.ts` (which fails the build below the threshold).

| Foreground on background          | Light   | Dark    | Required          |
| --------------------------------- | ------- | ------- | ----------------- |
| `textPrimary` on `canvas`         | 16.54:1 | 16.36:1 | 4.5:1             |
| `textPrimary` on `surface`        | 17.75:1 | 15.31:1 | 4.5:1             |
| `textPrimary` on `surfaceHover`   | 14.89:1 | 13.91:1 | 4.5:1             |
| `textSecondary` on `canvas`       | 6.34:1  | 8.34:1  | 4.5:1             |
| `textSecondary` on `surface`      | 6.80:1  | 7.81:1  | 4.5:1             |
| `textSecondary` on `surfaceHover` | 5.71:1  | 7.09:1  | 4.5:1             |
| `textTertiary` on `canvas`        | 5.04:1  | 5.70:1  | 4.5:1             |
| `textTertiary` on `surface`       | 5.41:1  | 5.33:1  | 4.5:1             |
| `textTertiary` on `surfaceSunken` | 4.75:1  | 5.85:1  | 4.5:1             |
| `onInk` on `ink`                  | 17.75:1 | 16.36:1 | 4.5:1             |
| `onInk` on `inkHover`             | 13.20:1 | 19.17:1 | 4.5:1             |
| `accent` on `canvas`              | 5.41:1  | 8.74:1  | 4.5:1             |
| `accent` on `surface`             | 5.81:1  | 8.18:1  | 4.5:1             |
| `onAccent` on `accent`            | 5.81:1  | 8.74:1  | 4.5:1             |
| `accentOnSoft` on `accentSoft`    | 6.06:1  | 7.99:1  | 4.5:1             |
| `success` on `surface`            | 5.62:1  | 9.45:1  | 4.5:1             |
| `success` on `successSoft`        | 5.07:1  | 8.02:1  | 4.5:1             |
| `warning` on `surface`            | 5.67:1  | 8.79:1  | 4.5:1             |
| `warning` on `warningSoft`        | 4.99:1  | 7.68:1  | 4.5:1             |
| `danger` on `surface`             | 6.44:1  | 8.49:1  | 4.5:1             |
| `danger` on `dangerSoft`          | 5.53:1  | 7.50:1  | 4.5:1             |
| `onDangerSolid` on `dangerSolid`  | 5.28:1  | 9.07:1  | 4.5:1             |
| `focusRing` on `canvas`           | 5.41:1  | 8.74:1  | 3:1 (non-text)    |
| `focusRing` on `surface`          | 5.81:1  | 8.18:1  | 3:1 (non-text)    |
| `borderControl` on `canvas`       | 3.13:1  | 3.50:1  | 3:1 (WCAG 1.4.11) |
| `borderControl` on `surface`      | 3.36:1  | 3.27:1  | 3:1 (WCAG 1.4.11) |

Lowest text pair: 4.75:1 (light, `textTertiary` on `surfaceSunken`); 5.33:1 (dark). `border` and
`borderStrong` are decorative separators and are not used as the only boundary of a control.
Any new pair used by a component must be added to the contrast test.

## 3. Typography

- **Web:** IBM Plex Sans with IBM Plex Sans Arabic (shared metrics), IBM Plex Mono for evidence,
  hashes and ids; self-hosted via `next/font`.
  - `--font-sans`: `'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, -apple-system, 'Segoe UI', sans-serif`
  - `--font-sans-arabic`: `'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif`
  - `--font-mono`: `'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace`
- **Native:** the platform system font (SF Pro / SF Arabic on Apple platforms), scaled with Dynamic
  Type; sizes below are the default (Large) size.
- **Sentence case everywhere**; no uppercase or letter-spaced labels (German compounds and Arabic do
  not survive them). Arabic gets +12 % line height via `:lang(ar)`.

| Style                                 | Size / line (px) | Weight | Tracking | Use                                    |
| ------------------------------------- | ---------------- | ------ | -------- | -------------------------------------- |
| `display` (`--type-display-*`)        | 30 / 38          | 600    | -0.02em  | Home greeting, empty-state headlines   |
| `title1` (`--type-title1-*`)          | 24 / 32          | 600    | -0.015em | Page titles                            |
| `title2` (`--type-title2-*`)          | 19 / 26          | 600    | -0.01em  | Section titles, sheet titles           |
| `title3` (`--type-title3-*`)          | 16 / 24          | 600    | -0.005em | Card titles, step titles               |
| `body` (`--type-body-*`)              | 15 / 24          | 400    | 0em      | Body text, answers, email body preview |
| `bodyStrong` (`--type-body-strong-*`) | 15 / 24          | 500    | 0em      | Emphasis, list primary text            |
| `callout` (`--type-callout-*`)        | 14 / 20          | 400    | 0em      | Supporting text, descriptions          |
| `label` (`--type-label-*`)            | 13 / 18          | 500    | 0em      | Buttons, form labels, chips            |
| `caption` (`--type-caption-*`)        | 12 / 16          | 400    | 0.005em  | Timestamps, metadata                   |
| `mono` (`--type-mono-*`)              | 13 / 18          | 400    | 0em      | Hashes, Message-IDs, URLs in evidence  |

## 4. Spacing, radius, layout

4-pt grid; the 8-pt steps are the defaults, 4-pt steps for tight component internals.

| Step         | px  | rem  |
| ------------ | --- | ---- |
| `--space-0`  | 0   | 0    |
| `--space-1`  | 4   | 0.25 |
| `--space-2`  | 8   | 0.5  |
| `--space-3`  | 12  | 0.75 |
| `--space-4`  | 16  | 1    |
| `--space-5`  | 20  | 1.25 |
| `--space-6`  | 24  | 1.5  |
| `--space-8`  | 32  | 2    |
| `--space-10` | 40  | 2.5  |
| `--space-12` | 48  | 3    |
| `--space-16` | 64  | 4    |

| Radius          | px   | Use                                   |
| --------------- | ---- | ------------------------------------- |
| `--radius-xs`   | 4    | Chips inside dense lists, code        |
| `--radius-sm`   | 6    | Inputs, small buttons                 |
| `--radius-md`   | 10   | Buttons, cards                        |
| `--radius-lg`   | 14   | Sheets, large cards                   |
| `--radius-xl`   | 20   | Command bar, approval sheet on mobile |
| `--radius-full` | 9999 | Pills, avatars, Presence              |

| Layout token                                   | Value                                       |
| ---------------------------------------------- | ------------------------------------------- |
| Breakpoints (min-width)                        | `sm` 640 px, `md` 900 px, `lg` 1200 px      |
| Sidebar width (`--sidebar-width`)              | 248 px (from `md`)                          |
| Content max width (`--content-max`)            | 760 px; wide (`--content-wide-max`) 1080 px |
| Minimum touch target (`--touch-min`)           | 44 px                                       |
| Control heights (`--control-sm/md/lg`)         | 32 / 40 / 48 px                             |
| Icon sizes                                     | 16 / 20 / 24 px, stroke 1.75                |
| Focus ring (`--focus-width`, `--focus-offset`) | 2 px, offset 2 px, `focusRing` color        |

Elevation (only floating layers):

| Layer              | Light                                                            | Dark                                                     |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `--shadow-popover` | `0 1px 2px rgba(23,24,27,0.06), 0 8px 24px rgba(23,24,27,0.10)`  | `0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.5)`  |
| `--shadow-sheet`   | `0 2px 6px rgba(23,24,27,0.06), 0 24px 64px rgba(23,24,27,0.16)` | `0 2px 6px rgba(0,0,0,0.5), 0 24px 64px rgba(0,0,0,0.6)` |

## 5. Motion and reduced motion

| Token                 | Value                          | Use                                             |
| --------------------- | ------------------------------ | ----------------------------------------------- |
| `--duration-instant`  | 80 ms                          | Press feedback                                  |
| `--duration-fast`     | 140 ms                         | Hover, toggles, chip changes                    |
| `--duration-base`     | 200 ms                         | Expand/collapse, list insertions                |
| `--duration-slow`     | 320 ms                         | Sheets entering                                 |
| `--ease-standard`     | `cubic-bezier(0.2, 0, 0, 1)`   | State changes                                   |
| `--ease-emphasized`   | `cubic-bezier(0.3, 0, 0, 1.1)` | Entering surfaces                               |
| `--ease-exit`         | `cubic-bezier(0.4, 0, 1, 1)`   | Leaving surfaces                                |
| `--presence-rotation` | 1600 ms                        | One Presence revolution while planning/thinking |

`prefers-reduced-motion: reduce` sets every `--duration-*` to `0ms` in the generated CSS. With reduced
motion the Presence indicator does not rotate; it shows its state with a static ring and the text
label. Native apps follow the system "Reduce Motion" setting the same way. No motion is required to
understand any state.

## 6. Presence

Presence is the small indicator of what JARVIS is doing right now. It reflects real state only, derived
from `GET /v1/assistant/status` and the active tasks / SSE events — never animated for decoration.

| State           | Shown when (real signal)                                      | Visual                                        | Label (en)                                |
| --------------- | ------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| Ready           | Worker healthy, no active task                                | Static `accent` dot                           | "Ready"                                   |
| Offline planner | `planner.mode = offline`                                      | Static ring in `textTertiary` + reason        | "Offline mode — no AI model (reason)"     |
| Planning        | A task in `PLANNING`                                          | Ring rotating (1600 ms), `accent`             | "Planning…"                               |
| Working         | A task in `RUNNING` or `VERIFYING`                            | Ring rotating, `accent`                       | "Working on <title>"                      |
| Waiting for you | A task in `AWAITING_APPROVAL`                                 | Static `warning` dot                          | "Needs your approval"                     |
| Listening       | Voice capture active on this device                           | Pulsing `accent` (static with reduced motion) | "Listening…"                              |
| Unavailable     | Worker unhealthy (no heartbeat < 30 s) or stream disconnected | Static `danger` dot                           | "JARVIS is unavailable — tasks will wait" |

The label is always present for assistive technology (`aria-live="polite"` on change, not on every
tick).

## 7. Task-state tones and icons

Tones are identical on every client (`tokens.taskStateTone`); always paired with the label and icon.

| State               | Tone    | Web (lucide)  | SF Symbol                                           | Material        |
| ------------------- | ------- | ------------- | --------------------------------------------------- | --------------- |
| `QUEUED`            | neutral | `Clock`       | `clock`                                             | `schedule`      |
| `PLANNING`          | accent  | `Route`       | `point.topleft.down.to.point.bottomright.curvepath` | `route`         |
| `AWAITING_APPROVAL` | warning | `Hand`        | `hand.raised`                                       | `pan_tool`      |
| `RUNNING`           | accent  | `Play`        | `play`                                              | `play_arrow`    |
| `VERIFYING`         | accent  | `ShieldCheck` | `checkmark.shield`                                  | `verified_user` |
| `COMPLETED`         | success | `CircleCheck` | `checkmark.circle`                                  | `check_circle`  |
| `FAILED`            | danger  | `CircleAlert` | `exclamationmark.circle`                            | `error`         |
| `CANCELLED`         | neutral | `CircleSlash` | `slash.circle`                                      | `block`         |
| `EXPIRED`           | neutral | `TimerOff`    | `timer`                                             | `timer_off`     |

## 8. Iconography

Outline icons, 1.75 stroke, 16/20/24 px, aligned to text baseline; icons never stand alone for an
action without an accessible name. Navigation and action icons:

| Key           | Web (lucide) | SF Symbol   | Material       |
| ------------- | ------------ | ----------- | -------------- |
| `home`        | `House`      | `house`     | `home`         |
| `tasks`       | `ListChecks` | `checklist` | `checklist`    |
| `memory`      | `Brain`      | `brain`     | `psychology`   |
| `connections` | `Plug`       | `powerplug` | `power`        |
| `settings`    | `Settings`   | `gearshape` | `settings`     |
| `voice`       | `Mic`        | `mic`       | `mic`          |
| `send`        | `ArrowUp`    | `arrow.up`  | `arrow_upward` |
| `approve`     | `Check`      | `checkmark` | `check`        |
| `reject`      | `X`          | `xmark`     | `close`        |

Directional icons (arrows, chevrons, "back") mirror in RTL; icons with inherent direction in the
real world (clock, play, checkmark, brand logos) do not.

## 9. RTL rules

- Set `dir="rtl"` and `lang="ar"` on `<html>` for Arabic (`RTL_LOCALES` in contracts); native apps
  rely on the system layout direction.
- Use logical CSS properties only: `margin-inline-*`, `padding-inline-*`, `inset-inline-*`,
  `border-inline-*`, `text-align: start/end`. No `left`/`right` in component CSS.
- Mirror layout, progress direction, sidebar side and directional icons; do not mirror numbers,
  clocks, media controls, code, URLs, email addresses, hashes.
- Mixed-direction content (an English URL inside Arabic text, an Arabic title inside an English list):
  wrap user content in `<bdi>` / `dir="auto"`; render URLs, emails and hashes in `dir="ltr"` spans.
- Numbers: Western Arabic digits by default for ar (consistent with input and hashes); dates and times
  through `Intl.DateTimeFormat` with the user's locale and time zone.
- Arabic text uses `--font-sans-arabic` via `:lang(ar)` and +12 % line height; never italicise Arabic;
  no letter-spacing.
- German: allow hyphenation (`hyphens: auto` with `lang="de"`) for long compounds in narrow columns;
  test the longest strings at 390 px.

## 10. Component inventory

| Component                  | Purpose                                                            | Key states                                                                          | Notes                                            |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| App shell                  | Sidebar (≥ 900 px) / bottom tab bar (< 900 px), Presence in header | —                                                                                   | Sidebar on the start side                        |
| Command bar                | Type or dictate a request                                          | idle, typing, listening, submitting, disabled (offline + unsupported hint)          | Submit with Enter; ⌘/Ctrl+K focuses              |
| Voice button + Voice sheet | Dictation                                                          | idle, permission needed, listening, processing, error, unsupported                  | Shows engine and privacy note                    |
| Presence indicator         | Real assistant state                                               | see §6                                                                              | `aria-live` label                                |
| Task card                  | Task in lists                                                      | per task state                                                                      | Title, state chip, progress `n/m`, updated time  |
| State chip                 | Task/step state                                                    | 9 task states, 8 step states                                                        | Tone + icon + label                              |
| Step list                  | Plan and execution                                                 | pending, awaiting approval, running, succeeded, failed, skipped, cancelled, blocked | Tool, risk badge, policy reasons on expand       |
| Risk badge                 | LOW / MEDIUM / HIGH / CRITICAL                                     | —                                                                                   | Text label always                                |
| Approval sheet             | Exact action + decide                                              | loading, ready, deciding, expired, mismatch (reload), decided                       | Full email preview; Approve (ink) and Reject     |
| Evidence list              | Proof of results                                                   | —                                                                                   | Mono for hashes/IDs; copy buttons                |
| Timeline                   | Event history                                                      | live, replaying                                                                     | Relative + absolute time                         |
| Result card                | Result summary + answer                                            | streaming, final                                                                    | Streaming text with `aria-busy`                  |
| Connection card            | Web access / SMTP                                                  | not connected, active, error, testing                                               | Last verified time, last error                   |
| SMTP form                  | Connect mailbox                                                    | editing, verifying, error                                                           | Security select (TLS/STARTTLS)                   |
| Memory row                 | Memory item                                                        | view, edit, deleting                                                                | Source (you / JARVIS)                            |
| Settings groups            | Preferences                                                        | saved, saving, error                                                                | Toggles with `borderControl`                     |
| Banner                     | System messages (offline mode, worker unavailable, budget)         | info, warning, danger                                                               | Never dismissible when it reflects ongoing state |
| Toast                      | Transient confirmations                                            | success, error                                                                      | Not for anything the user must act on            |
| Empty state                | First use                                                          | —                                                                                   | Real suggestion from `HomeSnapshot.suggestions`  |
| Skeleton                   | Loading                                                            | —                                                                                   | No fake content shapes beyond layout             |
| Dialog (destructive)       | Delete account, delete all memories, disconnect                    | —                                                                                   | Requires explicit confirmation; `dangerSolid`    |
| Admin stat tile / table    | Aggregates                                                         | —                                                                                   | No content columns                               |
