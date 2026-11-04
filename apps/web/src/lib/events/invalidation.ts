import type { StreamEvent } from '@jarvis/contracts';
import { qk, type QueryKey } from '../api/query-keys';

/**
 * Which cached queries a realtime event makes stale. Pure, so it is unit-tested; the event
 * stream provider batches the result and calls queryClient.invalidateQueries for each key.
 * `task.answer.delta` and `heartbeat` invalidate nothing (deltas go to subscribers instead).
 * Task events also refresh conversation threads (each turn shows its task's live state); the
 * ones that start or end a task refresh schedules too (a run's task, the schedule's last run).
 */
export function queriesToInvalidate(
  event: Pick<StreamEvent, 'type' | 'taskId'> & { data?: StreamEvent['data'] },
): QueryKey[] {
  const taskKeys: QueryKey[] = event.taskId
    ? [qk.tasks.detail(event.taskId), qk.tasks.lists, qk.home, qk.conversations.all]
    : [qk.tasks.lists, qk.home, qk.conversations.all];

  switch (event.type) {
    case 'step.succeeded':
      // A memory saved by JARVIS must appear on an open Memory screen right away.
      return event.data?.toolId === 'memory.save'
        ? [...taskKeys, qk.memories.all]
        : event.data?.toolId === 'schedule.create'
          ? [...taskKeys, qk.schedules.all]
          : taskKeys;
    case 'task.created':
    case 'task.status_changed':
      return [...taskKeys, qk.schedules.all];
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
      // Connections decide what can run (skills, capabilities) and Home's "Upcoming".
      return [qk.connections, qk.assistantStatus, qk.home, qk.skills, qk.calendar.all];
    case 'conversation.message': {
      const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : event.taskId;
      return taskId
        ? [qk.conversations.all, qk.tasks.detail(taskId), qk.tasks.lists]
        : [qk.conversations.all, qk.tasks.lists];
    }
    case 'conversation.changed':
      return [qk.conversations.all, qk.tasks.all, qk.home];
    case 'schedule.changed':
      return [qk.schedules.all];
    case 'webhook.delivery_failed':
    case 'webhook.endpoint_changed':
      return [qk.webhooks.all];
    // Phase C: a browser session belongs to a task (only its detail lists them; the task's own
    // status changes arrive as task events) — a shopping run emits several per minute, so they
    // must not refetch Home, lists and threads each time. Orders and bookings show in their task
    // and in Settings › Spending; watches in Settings › Reply tracking.
    case 'browser_session.changed':
      return event.taskId ? [qk.tasks.detail(event.taskId)] : [];
    case 'order.changed':
      return [...taskKeys, qk.orders.all];
    case 'booking.changed':
      return [...taskKeys, qk.bookings.all];
    case 'email_watch.changed':
      return [qk.emailWatches];
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
  qk.conversations.all,
  qk.schedules.all,
  qk.webhooks.all,
  qk.calendar.all,
  qk.emailWatches,
  qk.orders.all,
  qk.bookings.all,
];
