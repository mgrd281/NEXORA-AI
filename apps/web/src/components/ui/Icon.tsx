import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';

export type IconSize = 16 | 20 | 24;

/**
 * The only way icons are rendered: lucide outline icons at 16/20/24 px with a 1.75 stroke.
 * Decorative by default (aria-hidden); pass `label` for a standalone meaningful icon.
 * `mirror` flips directional icons (arrows, chevrons, send) in RTL.
 */
export function Icon({
  icon: Glyph,
  size = 20,
  label,
  mirror = false,
  className,
}: {
  icon: LucideIcon;
  size?: IconSize;
  label?: string;
  mirror?: boolean;
  className?: string;
}) {
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={1.75}
      absoluteStrokeWidth={false}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable={false}
      className={cx('icon', mirror && 'icon-mirror', className)}
    />
  );
}
