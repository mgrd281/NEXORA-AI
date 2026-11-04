const notifications = {
  title: 'Notifications',
  button:
    '{count, plural, =0 {Notifications} one {Notifications, # unread} other {Notifications, # unread}}',
  /** After the visible "Notifications" label in the sidebar: only the count. */
  unreadSuffix: '{count, plural, one {, # unread} other {, # unread}}',
  markAllRead: 'Mark all as read',
  empty: 'You’re all caught up.',
  loadError: 'Notifications could not be loaded.',
  unread: 'Unread',
  kinds: {
    approval_requested: '“{taskTitle}” needs your approval',
    task_completed: '“{taskTitle}” is done',
    task_failed: '“{taskTitle}” failed',
    connection_error: 'A connection needs attention',
    schedule_failed: 'A scheduled run of “{scheduleTitle}” failed',
    schedule_paused:
      '{reason, select, budget {“{scheduleTitle}” is paused: this month’s AI budget is used up} other {“{scheduleTitle}” is paused after repeated failures}}',
    webhook_disabled: 'Webhook to {endpointHost} turned off after repeated failed deliveries',
  },
  kindsUntitled: {
    approval_requested: 'A task needs your approval',
    task_completed: 'A task is done',
    task_failed: 'A task failed',
    connection_error: 'A connection needs attention',
    schedule_failed: 'A scheduled run failed',
    schedule_paused: 'A schedule was paused',
    webhook_disabled: 'A webhook endpoint was turned off after repeated failed deliveries',
  },
};

export default notifications;
