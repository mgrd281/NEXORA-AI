import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './EmptyState.module.css';
import { Icon } from './Icon';

/** One icon, one sentence, at most one action. No illustrations. */
export function EmptyState({
  icon,
  message,
  action,
  className,
}: {
  icon: LucideIcon;
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.root, className)}>
      <span className={styles.icon}>
        <Icon icon={icon} size={20} />
      </span>
      <p className={styles.message}>{message}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
