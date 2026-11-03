import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import styles from './ListRow.module.css';

/** A list of rows separated by hairlines (put inside a Card with padding="none"). */
export function ListGroup({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  /** Accessible name for the list. */
  label?: string;
}) {
  return (
    <ul className={cx(styles.group, className)} aria-label={label}>
      {children}
    </ul>
  );
}

export interface ListRowProps {
  /** Leading visual: an Icon, Avatar or Presence. */
  leading?: ReactNode;
  title: ReactNode;
  /** One line of supporting text (truncated). */
  description?: ReactNode;
  /** Metadata on the end side (time, count, status). */
  meta?: ReactNode;
  /** Makes the row a link; shows a chevron unless `chevron={false}`. */
  href?: string;
  /** Makes the row a button. */
  onClick?: () => void;
  chevron?: boolean;
  /** Overrides the accessible name of the link/button. */
  accessibleName?: string;
  className?: string;
  /**
   * Title and description are user-generated: each keeps its own direction (dir="auto"), so
   * it truncates at its own end, while still aligning to the row's start edge.
   */
  autoDir?: boolean;
}

/** One row in a ListGroup: static, a link (href) or a button (onClick). */
export function ListRow({
  leading,
  title,
  description,
  meta,
  href,
  onClick,
  chevron,
  accessibleName,
  className,
  autoDir,
}: ListRowProps) {
  const showChevron = chevron ?? Boolean(href);
  const body = (
    <>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span className={styles.main}>
        <span className={styles.title} dir={autoDir ? 'auto' : undefined}>
          {title}
        </span>
        {description && (
          <span className={styles.description} dir={autoDir ? 'auto' : undefined}>
            {description}
          </span>
        )}
      </span>
      {meta && <span className={styles.meta}>{meta}</span>}
      {showChevron && (
        <span className={styles.chevron}>
          <Icon icon={ChevronRight} size={16} mirror />
        </span>
      )}
    </>
  );
  return (
    <li className={cx(styles.item, className)}>
      {href ? (
        <Link
          href={href}
          className={cx(styles.row, styles.interactive)}
          aria-label={accessibleName}
        >
          {body}
        </Link>
      ) : onClick ? (
        <button
          type="button"
          className={cx(styles.row, styles.interactive)}
          onClick={onClick}
          aria-label={accessibleName}
        >
          {body}
        </button>
      ) : (
        <div className={styles.row}>{body}</div>
      )}
    </li>
  );
}
