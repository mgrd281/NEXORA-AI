'use client';

import { ChevronDown } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './TaskDetail.module.css';

/** The requests the offline planner understands (the composer's own list, in the UI language). */
export function OfflineCommands() {
  const { t } = useI18n();
  return (
    <ul className={styles.commands}>
      <li>{t('composer.offline.summarize')}</li>
      <li>{t('composer.offline.remember')}</li>
      <li>{t('composer.offline.emailMe')}</li>
    </ul>
  );
}

/**
 * The server's own wording of an error, kept for support and the curious: collapsed, because the
 * localized title and guidance above it already say what happened and what to do.
 */
export function TechnicalDetails({ message }: { message: string }) {
  const { t } = useI18n();
  if (!message.trim()) return null;
  return (
    <details className={styles.technical}>
      <summary className={styles.technicalToggle}>
        {t('tasks.detail.technicalDetails')}
        <Icon icon={ChevronDown} size={16} className={styles.technicalChevron} />
      </summary>
      <p className={styles.technicalBody}>
        <bdi>{message}</bdi>
      </p>
    </details>
  );
}
