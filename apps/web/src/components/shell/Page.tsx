import { Hammer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { cx } from '@/lib/cx';
import styles from './Page.module.css';

/**
 * Standard screen frame: one h1, optional description and actions, and a content column of
 * --content-max (reading) or --content-wide-max (lists, tables).
 */
export function Page({
  title,
  description,
  actions,
  leading,
  width = 'reading',
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Content before the title on the same line (e.g. a Presence ring). */
  leading?: ReactNode;
  width?: 'reading' | 'wide';
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(styles.page, width === 'wide' && styles.wide, className)}
      data-page-width={width}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          {leading}
          <div className={styles.titles}>
            <h1 className={styles.title}>{title}</h1>
            {description && <p className={styles.description}>{description}</p>}
          </div>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** Honest placeholder for a screen that is not built yet. */
export function PlaceholderScreen({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <Page title={title}>
      {children}
      <Card padding="none">
        <EmptyState icon={Hammer} message={message} />
      </Card>
    </Page>
  );
}
