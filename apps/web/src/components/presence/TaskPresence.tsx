'use client';

import type { TaskSummary } from '@jarvis/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { presenceFromTask } from './model';
import { Presence, type PresenceSize } from './Presence';

/** Presence for a single task (task detail header, rows): real status + step progress. */
export function TaskPresence({
  task,
  size = 24,
  showLabel = false,
  live = false,
}: {
  task: Pick<TaskSummary, 'status' | 'progress'>;
  size?: PresenceSize;
  showLabel?: boolean;
  live?: boolean;
}) {
  const { t } = useI18n();
  const p = presenceFromTask(task);
  return (
    <Presence
      state={p.state}
      progress={p.progress}
      size={size}
      label={t(p.labelKey, p.labelParams)}
      showLabel={showLabel}
      live={live}
    />
  );
}
