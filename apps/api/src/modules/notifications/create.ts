import type { NotificationKind, Preferences } from '@jarvis/contracts';
import type { DbContext, Trx } from '../../db/pool';
import { resolvePreferences } from '../account/me';
import { appendEvent } from '../events/events';

const PREFERENCE_FOR: Record<NotificationKind, keyof Preferences['notifications'] | null> = {
  approval_requested: 'approvalRequested',
  task_completed: 'taskCompleted',
  task_failed: 'taskFailed',
  // Broken connections always notify: the user must act for JARVIS to keep working.
  connection_error: null,
  // Phase B: a failed scheduled run is a failed task; a schedule or webhook that
  // stopped by itself always notifies (nothing runs until the user acts).
  schedule_failed: 'taskFailed',
  schedule_paused: null,
  webhook_disabled: null,
  // Phase C: an expired connection always notifies (nothing using it works until the
  // user reconnects); a reply to a watched thread is a result the user asked for.
  connection_expired: null,
  email_reply_received: 'taskCompleted',
};

/**
 * Creates an in-app notification (honouring preferences.notifications) and
 * emits `notification.created` on the realtime stream, inside the caller's
 * transaction. `data` holds localisation parameters only (e.g. taskTitle) —
 * never message bodies or secrets. Returns the notification id, or null when
 * the user turned this kind off.
 */
export async function createNotification(
  trx: Trx,
  ctx: DbContext,
  kind: NotificationKind,
  taskId: string | null,
  data: Record<string, string>,
  preferences?: Preferences,
): Promise<string | null> {
  const pref = PREFERENCE_FOR[kind];
  if (pref) {
    let prefs = preferences;
    if (!prefs) {
      const row = await trx
        .selectFrom('users')
        .select('preferences')
        .where('id', '=', ctx.userId)
        .executeTakeFirst();
      prefs = resolvePreferences(row?.preferences);
    }
    if (!prefs.notifications[pref]) return null;
  }
  const row = await trx
    .insertInto('notifications')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      kind,
      task_id: taskId,
      data: JSON.stringify(data),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendEvent(trx, ctx, {
    taskId,
    type: 'notification.created',
    data: { notificationId: row.id, kind },
  });
  return row.id;
}
