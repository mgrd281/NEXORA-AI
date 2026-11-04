'use client';

import type { StepStatus, TaskOutcome, TaskStatus } from '@jarvis/contracts';
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
  MessageCircleQuestionMark,
  MessageCircleReply,
  Play,
  Route,
  ShieldCheck,
  SkipForward,
  TimerOff,
} from 'lucide-react';
import { StatusPill, type Tone } from '@/components/ui/Badge';
import { useI18n } from '@/i18n/I18nProvider';
import type { TranslateFn } from '@/i18n/translate';

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

/**
 * A completed task that ended with a clarifying question waits for the user: it reads "Needs
 * your answer" (neutral accent), never "Completed" — a question is not a result, nor a failure.
 */
function asksQuestion(status: TaskStatus, outcome: TaskOutcome | null | undefined): boolean {
  return status === 'COMPLETED' && outcome === 'question';
}

/** The task's state in words, as its chip says it. */
export function taskStateLabel(
  t: TranslateFn,
  task: { status: TaskStatus; outcome?: TaskOutcome | null },
  answered = false,
): string {
  if (!asksQuestion(task.status, task.outcome)) return t(`common.taskStatus.${task.status}`);
  return answered ? t('common.outcome.answered') : t('common.outcome.question');
}

/** Task state chip: icon + localized label + tone (identical on every client). */
export function TaskStatusPill({
  status,
  outcome,
  answered = false,
  className,
}: {
  status: TaskStatus;
  /** TaskSummary.outcome: a 'question' reads "Needs your answer". */
  outcome?: TaskOutcome | null;
  /** The question was answered by a later request of its conversation: it reads "Answered". */
  answered?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  if (asksQuestion(status, outcome) && answered) {
    return (
      <StatusPill
        tone="neutral"
        icon={MessageCircleReply}
        label={t('common.outcome.answered')}
        className={className}
      />
    );
  }
  if (asksQuestion(status, outcome)) {
    return (
      <StatusPill
        tone="accent"
        icon={MessageCircleQuestionMark}
        label={t('common.outcome.question')}
        className={className}
      />
    );
  }
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
