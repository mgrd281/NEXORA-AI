import type { Catalog } from '../../types';
import type source from '../en/notifications';

const notifications: Catalog<typeof source> = {
  title: 'الإشعارات',
  button:
    '{count, plural, =0 {الإشعارات} one {الإشعارات، إشعار واحد غير مقروء} two {الإشعارات، إشعاران غير مقروءين} few {الإشعارات، # إشعارات غير مقروءة} many {الإشعارات، # إشعارًا غير مقروء} other {الإشعارات، # إشعار غير مقروء}}',
  unreadSuffix:
    '{count, plural, zero {، لا إشعارات غير مقروءة} one {، إشعار واحد غير مقروء} two {، إشعاران غير مقروءين} few {، # إشعارات غير مقروءة} many {، # إشعارًا غير مقروء} other {، # إشعار غير مقروء}}',
  markAllRead: 'تعليم الكل كمقروء',
  empty: 'لا جديد لديك.',
  loadError: 'تعذّر تحميل الإشعارات.',
  unread: 'غير مقروء',
  kinds: {
    approval_requested: 'مهمة «{taskTitle}» بحاجة إلى موافقتك',
    task_completed: 'اكتملت مهمة «{taskTitle}»',
    task_failed: 'فشلت مهمة «{taskTitle}»',
    connection_error: 'أحد الاتصالات يحتاج إلى انتباهك',
    schedule_failed: 'فشل تنفيذ مجدول لـ«{scheduleTitle}»',
    schedule_paused:
      '{reason, select, budget {أُوقف «{scheduleTitle}» مؤقتًا لأن ميزانية الذكاء الاصطناعي لهذا الشهر نفدت} other {أُوقف «{scheduleTitle}» مؤقتًا بعد إخفاقات متكررة}}',
    webhook_disabled: 'أُوقف الويب هوك إلى {endpointHost} بعد إخفاقات متكررة في التسليم',
    connection_expired: 'انتهت صلاحية اتصالك بـ {provider}: أعد الاتصال',
    email_reply_received: 'ردّ {fromAddress} على «{subject}»',
  },
  kindsUntitled: {
    approval_requested: 'مهمة بحاجة إلى موافقتك',
    task_completed: 'اكتملت إحدى المهام',
    task_failed: 'فشلت إحدى المهام',
    connection_error: 'أحد الاتصالات يحتاج إلى انتباهك',
    schedule_failed: 'فشل تنفيذ مجدول',
    schedule_paused: 'أُوقف جدول مؤقتًا',
    webhook_disabled: 'أُوقفت نقطة نهاية ويب هوك بعد إخفاقات متكررة في التسليم',
    connection_expired: 'انتهت صلاحية اتصال: أعد الاتصال',
    email_reply_received: 'وصل رد في سلسلة رسائل يتابعها JARVIS',
  },
};

export default notifications;
