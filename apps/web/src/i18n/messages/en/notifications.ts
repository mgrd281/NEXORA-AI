const notifications = {
  title: 'Notifications',
  button:
    '{count, plural, =0 {Notifications} one {Notifications, # unread} other {Notifications, # unread}}',
  markAllRead: 'Mark all as read',
  empty: 'You’re all caught up.',
  loadError: 'Notifications could not be loaded.',
  unread: 'Unread',
  kinds: {
    approval_requested: '“{taskTitle}” needs your approval',
    task_completed: '“{taskTitle}” is done',
    task_failed: '“{taskTitle}” failed',
    connection_error: 'A connection needs attention',
  },
  kindsUntitled: {
    approval_requested: 'A task needs your approval',
    task_completed: 'A task is done',
    task_failed: 'A task failed',
    connection_error: 'A connection needs attention',
  },
};

export default notifications;
