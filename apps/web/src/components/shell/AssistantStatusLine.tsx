'use client';

import type { AssistantStatus } from '@jarvis/contracts';
import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import type { TranslateFn } from '@/i18n/translate';
import { cx } from '@/lib/cx';
import styles from './AssistantStatusLine.module.css';

const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Claude' };

/** "Claude connected" / "Offline planner" — from the real planner route. */
export function plannerLabel(status: AssistantStatus | undefined, t: TranslateFn): string | null {
  if (!status) return null;
  if (status.planner.mode === 'offline') return t('common.assistant.offlinePlanner');
  const provider = status.planner.provider ? PROVIDER_NAMES[status.planner.provider] : undefined;
  return provider
    ? t('common.assistant.modelConnected', { provider })
    : t('common.assistant.modelGeneric');
}

/** Compact planner mode + worker health line; links to Settings › Assistant. */
export function AssistantStatusLine({ status }: { status: AssistantStatus | undefined }) {
  const { t } = useI18n();
  const mode = plannerLabel(status, t);
  if (!status || !mode) return <div className={styles.placeholder} aria-hidden="true" />;
  const healthy = status.worker.healthy;
  const worker = healthy
    ? t('common.assistant.workerHealthy')
    : t('common.assistant.workerUnhealthy');
  return (
    <Link
      href="/settings#assistant"
      className={styles.line}
      aria-label={t('shell.assistantStatus.open', { status: `${mode}, ${worker}` })}
      title={worker}
    >
      <span
        className={cx(styles.dot, healthy ? styles.healthy : styles.unhealthy)}
        aria-hidden="true"
      />
      <span className={styles.text}>{mode}</span>
    </Link>
  );
}
