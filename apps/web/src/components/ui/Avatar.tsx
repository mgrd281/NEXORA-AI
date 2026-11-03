import { cx } from '@/lib/cx';
import styles from './Avatar.module.css';

/** Up to two initials from a display name ("Layla Haddad" → "LH"; works for Arabic names). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : '';
  // A zero-width non-joiner keeps Arabic initials as two separate letters (not one ligature).
  const joiner = /[\u0600-\u06ff]/u.test(first + last) ? '\u200c' : '';
  return `${first}${joiner}${last}`.toLocaleUpperCase();
}

/** Neutral initials avatar (no colors that could be mistaken for status). Decorative. */
export function Avatar({
  name,
  size = 32,
  className,
}: {
  name: string;
  size?: 24 | 32 | 40;
  className?: string;
}) {
  return (
    <span
      className={cx(styles.avatar, styles[`s${size}`], className)}
      aria-hidden="true"
      dir="auto"
    >
      {initials(name)}
    </span>
  );
}
