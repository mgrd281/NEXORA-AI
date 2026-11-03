# ADR-0011: Meridian design system with tokens as the single source

- Status: Accepted
- Date: 2026-11-03

## Context

JARVIS runs on web, iOS and later Android and macOS, in light and dark, in English, German and Arabic
(RTL). A premium, trustworthy feel depends on consistency; accessibility is a requirement, not a
polish item.

## Decision

- **One token source:** `packages/tokens/src/tokens.ts` (color for both themes, space, radius, type,
  motion, elevation, breakpoints, layout, focus, task-state tones, icon names per platform).
  `pnpm tokens:build` generates `generated/tokens.css` (CSS custom properties, light/dark,
  `prefers-reduced-motion`), `generated/tokens.json`, `generated/Tokens.kt` and
  `apps/ios/Jarvis/DesignSystem/Tokens.swift`. Generated files are not edited by hand.
- **Color roles:** ink (near-black/near-white) for primary actions; the Ion accent (`accent`) is
  reserved for focus, links, live AI activity and the Presence indicator, so the accent always means
  "the assistant is doing something" or "you can go here". Status colors are always paired with a
  label and an icon.
- **Accessibility:** every text/background pair used by components meets WCAG 2.2 AA (≥ 4.5:1); focus
  rings and control boundaries ≥ 3:1. Verified in `packages/tokens/test/contrast.test.ts`; rendered
  pages are checked with axe-core in Playwright (web app, Milestone 1 (in progress)).
- **Typography:** IBM Plex Sans + IBM Plex Sans Arabic (shared metrics) on the web, self-hosted via
  `next/font`; the platform system font on native apps (SF Pro on Apple platforms). Sentence case
  everywhere.
- **Presence indicator** reflects real state only (worker healthy, planner mode, task actually
  planning/running/waiting); it never animates to suggest work that is not happening.

Full specification: [design system](../design/design-system.md).

## Alternatives considered

- **Off-the-shelf component library (Material, Radix Themes, Tailwind UI).** Fast, but generic, and
  RTL/Arabic typography and our state semantics would need overriding everywhere.
- **Per-platform design systems.** Drift between web and iOS is exactly what we want to avoid.
- **Style Dictionary.** Capable, but a small typed TypeScript generator is enough and keeps tokens
  type-checked where they are used.

## Consequences

- A token change is one edit plus a regenerate; contrast tests fail the build if a pair drops below
  AA.
- Components may use only tokens (no raw hex values); review checks this
  ([review process](../design/review-process.md)).
