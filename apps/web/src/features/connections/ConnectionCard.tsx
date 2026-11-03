'use client';

import type { ConnectionStatus } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, CircleCheck, CircleDashed, TimerOff } from 'lucide-react';
import { forwardRef, useId, type ReactNode } from 'react';
import { StatusPill, type Tone } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './connections.module.css';

const STATUS: Record<ConnectionStatus | 'none', { tone: Tone; icon: LucideIcon }> = {
  active: { tone: 'success', icon: CircleCheck },
  error: { tone: 'danger', icon: CircleAlert },
  expired: { tone: 'warning', icon: TimerOff },
  revoked: { tone: 'neutral', icon: CircleDashed },
  none: { tone: 'neutral', icon: CircleDashed },
};

export function ConnectionStatusPill({ status }: { status: ConnectionStatus | null }) {
  const { t } = useI18n();
  const s = STATUS[status ?? 'none'];
  return (
    <StatusPill
      tone={s.tone}
      icon={s.icon}
      label={status ? t(`connections.status.${status}`) : t('connections.status.notConnected')}
    />
  );
}

/**
 * One quiet card per connection type: icon, title and summary, status on the end side, then
 * the body and a footer with metadata and actions. The heading is focusable so focus has a
 * sensible place to land after the card changes state.
 */
export const ConnectionCard = forwardRef<
  HTMLHeadingElement,
  {
    icon: LucideIcon;
    title: string;
    summary: string;
    status: ConnectionStatus | null;
    children?: ReactNode;
    footer?: ReactNode;
  }
>(function ConnectionCard({ icon, title, summary, status, children, footer }, headingRef) {
  const titleId = useId();
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <header className={styles.header}>
        <span className={styles.iconTile} aria-hidden="true">
          <Icon icon={icon} size={20} />
        </span>
        <div className={styles.titles}>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.title}>
            {title}
          </h2>
          <p className={styles.summary}>{summary}</p>
        </div>
        <div className={styles.status}>
          <ConnectionStatusPill status={status} />
        </div>
      </header>
      {children && <div className={styles.body}>{children}</div>}
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </section>
  );
});
