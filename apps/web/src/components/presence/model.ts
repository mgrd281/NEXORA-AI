import type { TaskStatus, TaskSummary } from '@jarvis/contracts';
import type { MessageKey } from '@/i18n/catalog';

/**
 * Visual states of the Presence ring. Each maps to a real signal — never decoration:
 *   idle         thin neutral ring          nothing running (or queued / offline planner)
 *   listening    ring scaled by mic level   voice capture is active on this device
 *   speaking     ring with moving bars      JARVIS is speaking (speech synthesis plays) here
 *   thinking     short rotating arc         a task is PLANNING or VERIFYING
 *   running      determinate arc            a task is RUNNING: completed / total steps
 *   awaiting     warning ring with a notch  an approval is pending
 *   completed    success ring + check       a task just completed (shown briefly)
 *   failed       danger ring                a task failed
 *   reconnecting dashed ring                live updates disconnected, retrying
 *   offline      dashed ring                device offline or the worker is not responding
 */
export type PresenceState =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'running'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'reconnecting'
  | 'offline';

export interface PresenceProgress {
  completed: number;
  total: number;
}

export interface PresenceDescriptor {
  state: PresenceState;
  labelKey: MessageKey;
  labelParams?: Record<string, string | number>;
  progress?: PresenceProgress;
}

/** Presence for one task, from its real status and step progress. */
export function presenceFromTask(
  task: Pick<TaskSummary, 'status' | 'progress'>,
): PresenceDescriptor {
  const status: TaskStatus = task.status;
  switch (status) {
    case 'QUEUED':
      return { state: 'idle', labelKey: 'common.presence.queued' };
    case 'PLANNING':
      return { state: 'thinking', labelKey: 'common.presence.thinking' };
    case 'VERIFYING':
      return { state: 'thinking', labelKey: 'common.presence.verifying' };
    case 'RUNNING':
      return task.progress.total > 0
        ? {
            state: 'running',
            labelKey: 'common.presence.runningProgress',
            labelParams: { completed: task.progress.completed, total: task.progress.total },
            progress: task.progress,
          }
        : { state: 'running', labelKey: 'common.presence.running', progress: task.progress };
    case 'AWAITING_APPROVAL':
      return { state: 'awaiting', labelKey: 'common.presence.awaiting' };
    case 'COMPLETED':
      return { state: 'completed', labelKey: 'common.taskStatus.COMPLETED' };
    case 'FAILED':
      return { state: 'failed', labelKey: 'common.taskStatus.FAILED' };
    case 'CANCELLED':
      return { state: 'idle', labelKey: 'common.taskStatus.CANCELLED' };
    case 'EXPIRED':
      return { state: 'idle', labelKey: 'common.taskStatus.EXPIRED' };
  }
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface AssistantPresenceInput {
  /** navigator.onLine */
  online: boolean;
  stream: StreamStatus;
  /** AssistantStatus.worker.healthy; null while unknown. */
  workerHealthy: boolean | null;
  activeTasks: readonly Pick<TaskSummary, 'status' | 'progress' | 'title'>[];
  pendingApprovals: number;
  /** A task just reached a terminal state (from a live event); shown for a moment. */
  flash: 'completed' | 'failed' | null;
  /** Voice capture is active. */
  listening: boolean;
  /** JARVIS is speaking on this device (voice conversation; synthesis really playing). */
  speaking?: boolean;
}

/**
 * The assistant-wide Presence (brand mark, mobile top bar, Home). Priority: connectivity first
 * (the user must know updates are not live), then what needs the user, then live work.
 */
export function deriveAssistantPresence(input: AssistantPresenceInput): PresenceDescriptor {
  if (!input.online) return { state: 'offline', labelKey: 'common.presence.offline' };
  if (input.stream === 'reconnecting')
    return { state: 'reconnecting', labelKey: 'common.presence.reconnecting' };
  if (input.workerHealthy === false)
    return { state: 'offline', labelKey: 'common.presence.unavailable' };
  if (input.speaking) return { state: 'speaking', labelKey: 'common.presence.speaking' };
  if (input.listening) return { state: 'listening', labelKey: 'common.presence.listening' };
  if (input.pendingApprovals > 0)
    return { state: 'awaiting', labelKey: 'common.presence.awaiting' };

  const running = input.activeTasks.find((t) => t.status === 'RUNNING');
  if (running) {
    return {
      state: 'running',
      labelKey: 'common.presence.workingOn',
      labelParams: { title: running.title },
      progress: running.progress,
    };
  }
  const thinking = input.activeTasks.find(
    (t) => t.status === 'PLANNING' || t.status === 'VERIFYING',
  );
  if (thinking) return presenceFromTask(thinking);
  if (input.flash === 'completed')
    return { state: 'completed', labelKey: 'common.presence.completed' };
  if (input.flash === 'failed') return { state: 'failed', labelKey: 'common.presence.failed' };
  if (input.activeTasks.some((t) => t.status === 'QUEUED'))
    return { state: 'idle', labelKey: 'common.presence.queued' };
  return { state: 'idle', labelKey: 'common.presence.idle' };
}
