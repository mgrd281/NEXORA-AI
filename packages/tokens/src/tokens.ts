/**
 * Meridian — the JARVIS design language.
 *
 * Single source of truth for every platform. `scripts/build.ts` generates:
 *   - generated/tokens.css            (Web — CSS custom properties)
 *   - generated/tokens.json           (tooling / docs)
 *   - apps/ios/Jarvis/DesignSystem/Tokens.swift (iOS + macOS)
 *   - generated/Tokens.kt             (Android — Jetpack Compose)
 *
 * Principles
 *   - Ink for primary actions; the Ion accent is reserved for focus, links,
 *     live AI activity and the Presence indicator, so colour always carries meaning.
 *   - Hairline borders over shadows. Shadows exist only for floating layers.
 *   - Every text/background pair used by components meets WCAG 2.2 AA (≥ 4.5:1);
 *     see test/contrast.test.ts.
 */

export type ThemeName = 'light' | 'dark';

export const color = {
  light: {
    canvas: '#F7F7F4',
    surface: '#FFFFFF',
    surfaceSunken: '#F1F0ED',
    surfaceHover: '#ECEBE8',
    overlay: 'rgba(23, 24, 27, 0.32)',
    border: '#E0E0DD',
    borderStrong: '#CBCAC7',
    /** Boundary of interactive controls (inputs, toggles) — ≥ 3:1 per WCAG 1.4.11. */
    borderControl: '#8B8C90',
    textPrimary: '#17181B',
    textSecondary: '#595B5F',
    textTertiary: '#686A6F',
    textInverse: '#FFFFFF',
    ink: '#17181B',
    inkHover: '#2E3035',
    onInk: '#FFFFFF',
    accent: '#3959DA',
    accentHover: '#2D49C9',
    accentSoft: '#E9F0FF',
    accentOnSoft: '#304CCC',
    onAccent: '#FFFFFF',
    focusRing: '#3959DA',
    success: '#007834',
    successSoft: '#E2F9E6',
    warning: '#9A5600',
    warningSoft: '#FFEED9',
    danger: '#A43B38',
    dangerSoft: '#FFE9E6',
    dangerSolid: '#C13C3B',
    onDangerSolid: '#FFFFFF',
  },
  dark: {
    canvas: '#0E0F12',
    surface: '#161719',
    surfaceSunken: '#0A0B0D',
    surfaceHover: '#1F2023',
    overlay: 'rgba(0, 0, 0, 0.56)',
    border: '#292A2D',
    borderStrong: '#3F4042',
    borderControl: '#68696D',
    textPrimary: '#ECEDEF',
    textSecondary: '#A9ABB0',
    textTertiary: '#8A8C91',
    textInverse: '#0E0F12',
    ink: '#ECEDEF',
    inkHover: '#FFFFFF',
    onInk: '#0E0F12',
    accent: '#8EADFF',
    accentHover: '#A5BEFF',
    accentSoft: '#1A2444',
    accentOnSoft: '#9FBBFF',
    onAccent: '#0E0F12',
    focusRing: '#8EADFF',
    success: '#76CF8A',
    successSoft: '#102B17',
    warning: '#ECA851',
    warningSoft: '#331F05',
    danger: '#FF958D',
    dangerSoft: '#391917',
    dangerSolid: '#FF958D',
    onDangerSolid: '#0E0F12',
  },
} as const satisfies Record<ThemeName, Record<string, string>>;

export type ColorToken = keyof (typeof color)['light'];

/** 4-pt grid; the 8-pt steps are the defaults, 4-pt steps are for tight component internals. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 9999,
} as const;

export const font = {
  /** Web uses IBM Plex (Latin + Arabic share metrics); native apps use the platform system font. */
  sans: "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, -apple-system, 'Segoe UI', sans-serif",
  sansArabic: "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

export interface TypeStyle {
  size: number;
  lineHeight: number;
  weight: 400 | 500 | 600;
  tracking: number; // em
}

/**
 * Type scale. Sentence case everywhere (German compounds and Arabic do not
 * survive uppercase/letter-spaced labels). Arabic gets +12% line-height via :lang(ar).
 */
export const type = {
  display: { size: 30, lineHeight: 38, weight: 600, tracking: -0.02 },
  title1: { size: 24, lineHeight: 32, weight: 600, tracking: -0.015 },
  title2: { size: 19, lineHeight: 26, weight: 600, tracking: -0.01 },
  title3: { size: 16, lineHeight: 24, weight: 600, tracking: -0.005 },
  body: { size: 15, lineHeight: 24, weight: 400, tracking: 0 },
  bodyStrong: { size: 15, lineHeight: 24, weight: 500, tracking: 0 },
  callout: { size: 14, lineHeight: 20, weight: 400, tracking: 0 },
  label: { size: 13, lineHeight: 18, weight: 500, tracking: 0 },
  caption: { size: 12, lineHeight: 16, weight: 400, tracking: 0.005 },
  mono: { size: 13, lineHeight: 18, weight: 400, tracking: 0 },
} as const satisfies Record<string, TypeStyle>;

export const motion = {
  duration: { instant: 80, fast: 140, base: 200, slow: 320 },
  /** Standard easing for UI state changes; emphasized for entering surfaces. */
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1.1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
  /** Presence indicator: one revolution while planning/thinking. */
  presenceRotationMs: 1600,
} as const;

export const elevation = {
  light: {
    popover: '0 1px 2px rgba(23,24,27,0.06), 0 8px 24px rgba(23,24,27,0.10)',
    sheet: '0 2px 6px rgba(23,24,27,0.06), 0 24px 64px rgba(23,24,27,0.16)',
  },
  dark: {
    popover: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.5)',
    sheet: '0 2px 6px rgba(0,0,0,0.5), 0 24px 64px rgba(0,0,0,0.6)',
  },
} as const;

/** Mobile-first breakpoints (min-width). */
export const breakpoint = { sm: 640, md: 900, lg: 1200 } as const;

export const layout = {
  sidebarWidth: 248,
  contentMaxWidth: 760,
  wideContentMaxWidth: 1080,
  minTouchTarget: 44,
  controlHeight: { sm: 32, md: 40, lg: 48 },
  iconSize: { sm: 16, md: 20, lg: 24 },
  iconStroke: 1.75,
} as const;

export const focus = { width: 2, offset: 2 } as const;

/**
 * Task-state → semantic tone. Used identically by every client so that a state
 * always looks the same everywhere. Never rely on colour alone: clients pair it
 * with the state label and icon below.
 */
export const taskStateTone = {
  QUEUED: 'neutral',
  PLANNING: 'accent',
  AWAITING_APPROVAL: 'warning',
  RUNNING: 'accent',
  VERIFYING: 'accent',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
} as const;

/** Icon names per platform, so semantics stay aligned across icon sets. */
export const icons = {
  home: { web: 'House', sf: 'house', material: 'home' },
  tasks: { web: 'ListChecks', sf: 'checklist', material: 'checklist' },
  memory: { web: 'Brain', sf: 'brain', material: 'psychology' },
  connections: { web: 'Plug', sf: 'powerplug', material: 'power' },
  settings: { web: 'Settings', sf: 'gearshape', material: 'settings' },
  voice: { web: 'Mic', sf: 'mic', material: 'mic' },
  send: { web: 'ArrowUp', sf: 'arrow.up', material: 'arrow_upward' },
  approve: { web: 'Check', sf: 'checkmark', material: 'check' },
  reject: { web: 'X', sf: 'xmark', material: 'close' },
  QUEUED: { web: 'Clock', sf: 'clock', material: 'schedule' },
  PLANNING: {
    web: 'Route',
    sf: 'point.topleft.down.to.point.bottomright.curvepath',
    material: 'route',
  },
  AWAITING_APPROVAL: { web: 'Hand', sf: 'hand.raised', material: 'pan_tool' },
  RUNNING: { web: 'Play', sf: 'play', material: 'play_arrow' },
  VERIFYING: { web: 'ShieldCheck', sf: 'checkmark.shield', material: 'verified_user' },
  COMPLETED: { web: 'CircleCheck', sf: 'checkmark.circle', material: 'check_circle' },
  FAILED: { web: 'CircleAlert', sf: 'exclamationmark.circle', material: 'error' },
  CANCELLED: { web: 'CircleSlash', sf: 'slash.circle', material: 'block' },
  EXPIRED: { web: 'TimerOff', sf: 'timer', material: 'timer_off' },
} as const;

export const tokens = {
  color,
  space,
  radius,
  font,
  type,
  motion,
  elevation,
  breakpoint,
  layout,
  focus,
  taskStateTone,
  icons,
} as const;
export default tokens;
