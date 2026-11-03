'use client';

import type { LucideIcon } from 'lucide-react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { describeError } from '@/lib/api/errors';
import { cx } from '@/lib/cx';
import styles from './Banner.module.css';
import { Button } from './Button';
import { Icon } from './Icon';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

const ICONS: Record<BannerTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/**
 * Inline system message. Banners that reflect ongoing state (offline, unavailable) are not
 * dismissible. `live` announces it when it appears (assertive for danger, polite otherwise).
 */
export function Banner({
  tone = 'info',
  title,
  children,
  action,
  icon,
  live = false,
  className,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  live?: boolean;
  className?: string;
}) {
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={cx(styles.banner, styles[tone], className)} role={role}>
      <span className={styles.icon}>
        <Icon icon={icon ?? ICONS[tone]} size={20} />
      </span>
      <div className={styles.body}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.text}>{children}</div>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}

/**
 * Error banner for a failed request: friendly localized message, an optional retry, and the
 * API's message plus request ID behind a "Details" disclosure.
 */
export function ErrorBanner({
  error,
  onRetry,
  retrying,
  title,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  title?: ReactNode;
  className?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const d = describeError(error, i18n);
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(d.detail || d.requestId);
  return (
    <Banner
      tone="danger"
      live
      title={title ?? d.message}
      className={className}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            {t('common.actions.retry')}
          </Button>
        ) : undefined
      }
    >
      {title ? <p>{d.message}</p> : null}
      {hasDetails && (
        <div className={styles.details}>
          <button
            type="button"
            className={styles.detailsToggle}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {t('errors.details')}
          </button>
          {open && (
            <div className={styles.detailsBody}>
              {d.detail && <p>{d.detail}</p>}
              {d.requestId && (
                <dl className={styles.detailsList}>
                  <dt>{t('errors.requestId')}</dt>
                  <dd className="t-mono ltr">{d.requestId}</dd>
                </dl>
              )}
            </div>
          )}
        </div>
      )}
    </Banner>
  );
}
