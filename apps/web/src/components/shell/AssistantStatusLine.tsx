'use client';

import type { AssistantStatus } from '@jarvis/contracts';
import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import type { TranslateFn } from '@/i18n/translate';
import { cx } from '@/lib/cx';
import styles from './AssistantStatusLine.module.css';

const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Claude' };

/** "Claude connected" / "Basic mode" — from the real planner route. */
export function plannerLabel(status: AssistantStatus | undefined, t: TranslateFn): string | null {
  if (!status) return null;
  if (status.planner.mode === 'offline') return t('common.assistant.offlinePlanner');
  const provider = status.planner.provider ? PROVIDER_NAMES[status.planner.provider] : undefined;
  return provider
    ? t('common.assistant.modelConnected', { provider })
    : t('common.assistant.modelGeneric');
}

type Tone = 'ok' | 'neutral' | 'danger';

/**
 * Compact assistant status; links to Settings › Assistant. The text and the dot say the same
 * thing (never colour alone): "Claude connected" (green) when a model plans with a running
 * worker, "Basic mode" (neutral) without a model, "Worker not responding" (red) when nothing
 * can run, whatever the planner.
 */
export function AssistantStatusLine({ status }: { status: AssistantStatus | undefined }) {
  const { t, f } = useI18n();
  const mode = plannerLabel(status, t);
  if (!status || !mode) return <div className={styles.placeholder} aria-hidden="true" />;
  const healthy = status.worker.healthy;
  const worker = healthy
    ? t('common.assistant.workerHealthy')
    : t('common.assistant.workerUnhealthy');
  const tone: Tone = !healthy ? 'danger' : status.planner.mode === 'offline' ? 'neutral' : 'ok';
  const text = healthy ? mode : worker;
  return (
    <Link
      href="/settings#assistant"
      className={styles.line}
      aria-label={t('shell.assistantStatus.open', { status: f.list([mode, worker], 'unit') })}
    >
      <span className={cx(styles.dot, styles[tone])} aria-hidden="true" />
      <span className={styles.text}>{text}</span>
    </Link>
  );
}
