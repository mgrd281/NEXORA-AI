import type { Catalog } from '../../types';
import type source from '../en/notifications';

const notifications: Catalog<typeof source> = {
  title: 'الإشعارات',
  button:
    '{count, plural, =0 {الإشعارات} one {الإشعارات، إشعار واحد غير مقروء} two {الإشعارات، إشعاران غير مقروءين} few {الإشعارات، # إشعارات غير مقروءة} many {الإشعارات، # إشعارًا غير مقروء} other {الإشعارات، # إشعار غير مقروء}}',
  markAllRead: 'تعليم الكل كمقروء',
  empty: 'لا جديد لديك.',
  loadError: 'تعذّر تحميل الإشعارات.',
  unread: 'غير مقروء',
  kinds: {
    approval_requested: 'مهمة «{taskTitle}» بحاجة إلى موافقتك',
    task_completed: 'اكتملت مهمة «{taskTitle}»',
    task_failed: 'فشلت مهمة «{taskTitle}»',
    connection_error: 'أحد الاتصالات يحتاج إلى انتباهك',
  },
  kindsUntitled: {
    approval_requested: 'مهمة بحاجة إلى موافقتك',
    task_completed: 'اكتملت إحدى المهام',
    task_failed: 'فشلت إحدى المهام',
    connection_error: 'أحد الاتصالات يحتاج إلى انتباهك',
  },
};

export default notifications;
