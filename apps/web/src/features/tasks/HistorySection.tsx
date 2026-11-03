'use client';

import type { TaskEvent, TaskStatus } from '@jarvis/contracts';
import { ChevronDown } from 'lucide-react';
import { useId, useState, useSyncExternalStore } from 'react';
import { Card, Section } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import { useExactTimeFormat } from './format';
import styles from './History.module.css';
import { describeEvent } from './model';

const WIDE_QUERY = '(min-width: 900px)';

function subscribeWide(callback: () => void) {
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

/** Desktop layout (sidebar visible); false while server rendering. */
function useIsWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/**
 * The task's event timeline with localized descriptions and exact timestamps (account time
 * zone). Expanded on desktop, collapsed behind a disclosure on phones.
 */
export function HistorySection({ events }: { events: readonly TaskEvent[] }) {
  const { t } = useI18n();
  const wide = useIsWide();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? wide;
  const panelId = useId();
  const visible = events.filter((e) => e.type !== 'task.answer.delta');

  return (
    <Section
      title={t('tasks.history.title')}
      description={
        visible.length > 0 ? t('tasks.history.count', { count: visible.length }) : undefined
      }
      action={
        visible.length > 0 ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setExpanded(!open)}
          >
            {open ? t('tasks.history.hide') : t('tasks.history.show')}
            <Icon icon={ChevronDown} size={16} className={styles.chevron} />
          </button>
        ) : undefined
      }
    >
      {visible.length === 0 ? (
        <Card>
          <p className={styles.empty}>{t('tasks.history.empty')}</p>
        </Card>
      ) : (
        <div id={panelId} hidden={!open}>
          {open && (
            <Card padding="none">
              <Timeline events={visible} />
            </Card>
          )}
        </div>
      )}
    </Section>
  );
}

function Timeline({ events }: { events: readonly TaskEvent[] }) {
  const { t } = useI18n();
  const exact = useExactTimeFormat();
  const statusLabel = (s: TaskStatus) => t(`common.taskStatus.${s}`);
  const days = events.map((e) => exact.dayKey(new Date(e.at)));
  return (
    <ol className={styles.timeline}>
      {events.map((event, i) => {
        const d = describeEvent(event, statusLabel, t('tasks.events.unknownStep'));
        const at = new Date(event.at);
        // The full date on the first event of each day; times only after that.
        const showDate = i === 0 || days[i] !== days[i - 1];
        return (
          <li key={event.id} className={styles.event} data-tone={d.tone}>
            <span className={styles.dot} aria-hidden="true" />
            <div className={styles.body}>
              <p className={styles.text}>{t(d.key, d.params)}</p>
              {/* Server-written lines: isolated, but aligned with the timeline's direction. */}
              {d.details && d.details.length > 0 && (
                <ul className={styles.details}>
                  {d.details.map((line, i) => (
                    <li key={i}>
                      <bdi>{line}</bdi>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <time
              dateTime={at.toISOString()}
              title={exact.full(at)}
              className={cx(styles.time, 'tabular')}
            >
              {showDate ? exact.full(at) : exact.time(at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
