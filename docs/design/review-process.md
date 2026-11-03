# Design review process

Every screen change is reviewed against the 12-step checklist below, using screenshots of the real
app (real API, real data from a test account — never mock data) across the full matrix.

## Screenshot matrix

| Dimension | Values                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme     | light, dark (`data-theme` set explicitly)                                                                                                                                                             |
| Locale    | en, de, ar (ar = RTL)                                                                                                                                                                                 |
| Viewport  | mobile 390 × 844, desktop 1440 × 900                                                                                                                                                                  |
| State     | per screen: loading (network throttled), empty, populated, error, offline, plus screen-specific states (e.g. Task detail: planning, awaiting approval, running, completed, failed, `OUTCOME_UNKNOWN`) |

10 screens × 2 themes × 3 locales × 2 viewports = 120 base screenshots, plus state variants.

## How screenshots are produced

1. Start the stack locally ([local development](../runbooks/local-development.md)): PostgreSQL, API,
   worker, web, dev mailbox, local fixture site.
2. Create a review account with `cli create-owner` (and `--admin` for the Admin screen); connect Web
   access and the dev mailbox; create real tasks through the API (offline planner commands work without
   an API key).
3. Run the Playwright suite of the web app (`pnpm e2e`, Playwright 1.63 with the bundled Chromium;
   the specs are part of the web app, Milestone 1 (in progress)). The screenshot specs iterate the matrix, set `data-theme`, the locale (via the account's `locale`) and
   the viewport, wait for network idle and for the Presence label to settle, then save full-page PNGs
   to `apps/web/test-results/` (git-ignored) using the name
   `<screen>--<state>--<theme>--<locale>--<viewport>.png`.
4. The same run executes `@axe-core/playwright` on every page in both themes; serious or critical
   violations fail the run.
5. Reviewers compare against the previous run (side by side) and record findings per checklist step.
6. iOS: screenshots from the simulator (Light/Dark, en/de/ar, iPhone 15 size and the largest Dynamic
   Type size) on a machine with Xcode; this environment has no Swift toolchain
   ([known limitations](../known-limitations.md)).

## The 12-step checklist

1. **Real state only.** Every number, status, timestamp and label maps to API data; no placeholder or
   demo content; offline mode, worker health and budget state are visible where relevant; nothing
   claims success without evidence.
2. **Hierarchy and purpose.** One clear primary action per screen; the most important information
   (pending approvals, current state) is first; secondary actions are visually quieter.
3. **Tokens only.** Colors, spacing, radius, type, shadows and motion come from Meridian variables; no
   raw hex values or magic numbers in component CSS.
4. **Typography.** Correct type styles; sentence case; no truncation of German compounds at 390 px;
   Arabic uses Plex Sans Arabic with the larger line height; mono for hashes and ids.
5. **Spacing and alignment.** 4-pt grid; consistent gutters (16 px mobile, 24–32 px desktop); content
   aligned to the start edge; no orphaned elements.
6. **Complete states.** Loading, empty, error, offline and every task/step state designed and
   reachable; error messages are the API's user-safe messages with a retry.
7. **Color and contrast.** Every text pair ≥ 4.5:1 (from the contrast table), focus and control
   boundaries ≥ 3:1, both themes; state never shown by color alone (label + icon).
8. **Keyboard and focus.** Logical tab order; visible focus ring (2 px `focusRing`, 2 px offset);
   dialogs and sheets trap focus and restore it; shortcuts documented (⌘/Ctrl+K).
9. **Screen readers.** Landmarks, headings, accessible names for icon buttons, `aria-live` for
   Presence and approvals (polite, once), streaming answers with `aria-busy`; VoiceOver on iOS.
10. **RTL and localisation.** Arabic layout mirrors correctly; directional icons mirror, others do
    not; URLs/emails/hashes render LTR; dates/times/numbers via `Intl` in the user's time zone; all
    three locales have complete strings.
11. **Responsive and touch.** Works at 390 px and 1440 px without horizontal scroll (except data
    tables inside their container); touch targets ≥ 44 px; bottom tab bar vs. sidebar switch at 900 px.
12. **Motion and Presence.** Durations from tokens; `prefers-reduced-motion` removes animation; the
    Presence indicator shows only real states (§6 of the [design system](design-system.md)) and its
    label is always available.

## Recording results

For each review round, record in the pull request: matrix coverage (which screenshots), findings
per checklist step with screenshot names, and the axe summary. A screen passes when all 12 steps pass
in all 12 matrix cells (2 themes × 3 locales × 2 viewports) for its populated state and the listed
special states.
