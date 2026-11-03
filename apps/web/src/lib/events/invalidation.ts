import type { StreamEvent } from '@jarvis/contracts';
import { qk, type QueryKey } from '../api/query-keys';

/**
 * Which cached queries a realtime event makes stale. Pure, so it is unit-tested; the event
 * stream provider batches the result and calls queryClient.invalidateQueries for each key.
 * `task.answer.delta` and `heartbeat` invalidate nothing (deltas go to subscribers instead).
 */
export function queriesToInvalidate(
  event: Pick<StreamEvent, 'type' | 'taskId'> & { data?: StreamEvent['data'] },
): QueryKey[] {
  const taskKeys: QueryKey[] = event.taskId
    ? [qk.tasks.detail(event.taskId), qk.tasks.lists, qk.home]
    : [qk.tasks.lists, qk.home];

  switch (event.type) {
    case 'step.succeeded':
      // A memory saved by JARVIS must appear on an open Memory screen right away.
      return event.data?.toolId === 'memory.save' ? [...taskKeys, qk.memories.all] : taskKeys;
    case 'task.created':
    case 'task.status_changed':
    case 'plan.ready':
    case 'step.started':
    case 'step.failed':
    case 'step.blocked':
    case 'verification.passed':
    case 'verification.failed':
    case 'task.cancel_requested':
    case 'task.retried':
      return taskKeys;
    case 'approval.requested':
    case 'approval.decided':
      return [...taskKeys, qk.approvals];
    case 'notification.created':
      return [qk.notifications, qk.home];
    case 'connection.changed':
      return [qk.connections, qk.assistantStatus, qk.home];
    case 'task.answer.delta':
    case 'heartbeat':
      return [];
  }
}

/** After a reconnect, events beyond the replay window may be missing: refresh live data. */
export const RECONNECT_INVALIDATIONS: QueryKey[] = [
  qk.home,
  qk.tasks.all,
  qk.approvals,
  qk.notifications,
  qk.connections,
  qk.assistantStatus,
];
