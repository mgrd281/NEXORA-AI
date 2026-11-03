'use client';

import { useId, type ElementType, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Card.module.css';

/** A quiet surface with a hairline border. `padding="none"` for lists that bleed to the edge. */
export function Card({
  children,
  padding = 'md',
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  padding?: 'none' | 'sm' | 'md';
  className?: string;
  as?: ElementType;
}) {
  return <Tag className={cx(styles.card, styles[`pad-${padding}`], className)}>{children}</Tag>;
}

/**
 * A titled section (landmark-free `<section>` labelled by its heading) with an optional action
 * on the end side and an optional description.
 */
export function Section({
  title,
  description,
  action,
  children,
  headingLevel = 2,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
  id?: string;
}) {
  const headingId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={cx(styles.section, className)} aria-labelledby={headingId} id={id}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <Heading id={headingId} className={headingLevel === 2 ? styles.title2 : styles.title3}>
            {title}
          </Heading>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {action && <div className={styles.action}>{action}</div>}
      </div>
      {children}
    </section>
  );
}
