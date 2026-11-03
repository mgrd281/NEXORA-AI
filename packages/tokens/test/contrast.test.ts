import { describe, expect, it } from 'vitest';
import { color, type ThemeName } from '../src/tokens';

function lum(hex: string) {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** Every foreground/background pair that components actually render. */
const pairs: [fg: keyof (typeof color)['light'], bg: keyof (typeof color)['light']][] = [
  ['textPrimary', 'canvas'],
  ['textPrimary', 'surface'],
  ['textPrimary', 'surfaceHover'],
  ['textPrimary', 'surfaceRaised'],
  ['textPrimary', 'surfaceSunken'],
  ['textSecondary', 'canvas'],
  ['textSecondary', 'surface'],
  ['textSecondary', 'surfaceHover'],
  ['textSecondary', 'surfaceRaised'],
  ['textSecondary', 'surfaceSunken'],
  ['textTertiary', 'canvas'],
  ['textTertiary', 'surface'],
  ['textTertiary', 'surfaceSunken'],
  ['textTertiary', 'surfaceRaised'],
  ['onInk', 'ink'],
  ['onInk', 'inkHover'],
  ['accent', 'canvas'],
  ['accent', 'surface'],
  ['onAccent', 'accent'],
  ['accentOnSoft', 'accentSoft'],
  ['success', 'surface'],
  ['success', 'successSoft'],
  ['warning', 'surface'],
  ['warning', 'warningSoft'],
  ['danger', 'surface'],
  ['danger', 'dangerSoft'],
  ['onDangerSolid', 'dangerSolid'],
];

describe.each<ThemeName>(['light', 'dark'])('%s theme contrast (WCAG 2.2 AA)', (theme) => {
  it.each(pairs)('%s on %s ≥ 4.5:1', (fg, bg) => {
    expect(contrast(color[theme][fg], color[theme][bg])).toBeGreaterThanOrEqual(4.5);
  });
  it('focus ring is ≥ 3:1 against canvas and surface (non-text contrast)', () => {
    expect(contrast(color[theme].focusRing, color[theme].canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(color[theme].focusRing, color[theme].surface)).toBeGreaterThanOrEqual(3);
  });
  it('control boundaries are ≥ 3:1 against canvas and surface (WCAG 1.4.11)', () => {
    expect(contrast(color[theme].borderControl, color[theme].canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(color[theme].borderControl, color[theme].surface)).toBeGreaterThanOrEqual(3);
  });
  it('the selected segment ring is ≥ 3:1 against its track and thumb (WCAG 1.4.11)', () => {
    const c = color[theme];
    expect(contrast(c.borderControl, c.surfaceSunken)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.borderControl, c.surfaceRaised)).toBeGreaterThanOrEqual(3);
  });
  it('a well inside a card is never darker than the dark page (no punched-through look)', () => {
    if (theme !== 'dark') return;
    const c = color[theme];
    expect(lum(c.surfaceSunken)).toBeGreaterThanOrEqual(lum(c.canvas));
    expect(lum(c.surfaceSunken)).toBeLessThanOrEqual(lum(c.surface));
  });
});
