import { cx } from '@/lib/cx';
import styles from './Spinner.module.css';

/**
 * Indeterminate activity for a control or region. Decorative by default (the surrounding
 * control carries aria-busy and its label); pass `label` for a standalone status.
 */
export function Spinner({
  size = 16,
  label,
  className,
}: {
  size?: 16 | 20 | 24;
  label?: string;
  className?: string;
}) {
  const svg = (
    <svg
      className={cx(styles.spinner, className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" className={styles.track} strokeWidth="2.25" />
      <circle
        cx="12"
        cy="12"
        r="9"
        className={styles.arc}
        strokeWidth="2.25"
        pathLength={100}
        strokeDasharray="30 70"
        strokeLinecap="round"
      />
    </svg>
  );
  if (!label) return svg;
  return (
    <span role="status" className={styles.labelled}>
      {svg}
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
