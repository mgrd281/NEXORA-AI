'use client';

import type { StepStatus, TaskStatus } from '@jarvis/contracts';
import { taskStateTone } from '@jarvis/tokens';
import type { LucideIcon } from 'lucide-react';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  Hand,
  Play,
  Route,
  ShieldCheck,
  SkipForward,
  TimerOff,
} from 'lucide-react';
import { StatusPill, type Tone } from '@/components/ui/Badge';
import { useI18n } from '@/i18n/I18nProvider';

/** Web icons per task state (tokens.icons). */
export const TASK_STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  QUEUED: Clock,
  PLANNING: Route,
  AWAITING_APPROVAL: Hand,
  RUNNING: Play,
  VERIFYING: ShieldCheck,
  COMPLETED: CircleCheck,
  FAILED: CircleAlert,
  CANCELLED: CircleSlash,
  EXPIRED: TimerOff,
};

export function taskTone(status: TaskStatus): Tone {
  return taskStateTone[status];
}

/** Task state chip: icon + localized label + tone (identical on every client). */
export function TaskStatusPill({ status, className }: { status: TaskStatus; className?: string }) {
  const { t } = useI18n();
  return (
    <StatusPill
      tone={taskTone(status)}
      icon={TASK_STATUS_ICON[status]}
      label={t(`common.taskStatus.${status}`)}
      className={className}
    />
  );
}

const STEP_TONE: Record<StepStatus, Tone> = {
  PENDING: 'neutral',
  AWAITING_APPROVAL: 'warning',
  RUNNING: 'accent',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  SKIPPED: 'neutral',
  CANCELLED: 'neutral',
  BLOCKED: 'danger',
};

const STEP_ICON: Record<StepStatus, LucideIcon> = {
  PENDING: CircleDashed,
  AWAITING_APPROVAL: Hand,
  RUNNING: Play,
  SUCCEEDED: CircleCheck,
  FAILED: CircleAlert,
  SKIPPED: SkipForward,
  CANCELLED: CircleSlash,
  BLOCKED: Ban,
};

/** Step state chip for plan / execution lists. */
export function StepStatusPill({ status, className }: { status: StepStatus; className?: string }) {
  const { t } = useI18n();
  return (
    <StatusPill
      tone={STEP_TONE[status]}
      icon={STEP_ICON[status]}
      label={t(`common.stepStatus.${status}`)}
      className={className}
    />
  );
}
