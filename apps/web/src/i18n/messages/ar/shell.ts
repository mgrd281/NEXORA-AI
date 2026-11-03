import type { Catalog } from '../../types';
import type source from '../en/shell';

const shell: Catalog<typeof source> = {
  brand: 'JARVIS — الرئيسية',
  nav: {
    label: 'التنقل الرئيسي',
    home: 'الرئيسية',
    tasks: 'المهام',
    memory: 'الذاكرة',
    connections: 'الاتصالات',
    settings: 'الإعدادات',
    admin: 'الإدارة',
  },
  tasksBadge:
    '{count, plural, zero {لا موافقات بانتظارك} one {موافقة واحدة بانتظارك} two {موافقتان بانتظارك} few {# موافقات بانتظارك} many {# موافقة بانتظارك} other {# موافقة بانتظارك}}',
  account: {
    menu: 'الحساب',
    signOut: 'تسجيل الخروج',
    signingOut: 'جارٍ تسجيل الخروج…',
    signOutFailed: 'تعذّر تسجيل الخروج. حاول مرة أخرى.',
    settings: 'الإعدادات',
    admin: 'الإدارة',
    shortcuts: 'اختصارات لوحة المفاتيح',
  },
  assistantStatus: {
    label: 'حالة المساعد',
    open: 'حالة المساعد: {status}. افتح إعدادات المساعد.',
  },
  banners: {
    offline: 'أنت غير متصل بالإنترنت — لن تُرسَل التغييرات.',
    unavailable: 'JARVIS غير متاح حاليًا — ستنتظر المهام في قائمة الانتظار.',
    reconnecting: 'التحديثات المباشرة متوقفة مؤقتًا. جارٍ إعادة الاتصال…',
  },
  shortcuts: {
    title: 'اختصارات لوحة المفاتيح',
    focusComposer: 'اسأل JARVIS من أي صفحة',
    focusComposerHere: 'الانتقال إلى حقل الطلب في هذه الصفحة',
    showShortcuts: 'عرض اختصارات لوحة المفاتيح',
    send: 'إرسال طلب',
    newLine: 'سطر جديد في الطلب',
    closeOverlay: 'إغلاق نافذة أو لوحة',
    singleKey: 'اختصارات بمفتاح واحد',
    singleKeyHint:
      'استخدم / و? دون مفتاح إضافي. أوقفها إذا كنت تستخدم الإدخال الصوتي أو أدوات أخرى تكتب نيابةً عنك.',
  },
  placeholder: {
    building: 'هذه الشاشة قيد الإنشاء.',
  },
  pageTitles: {
    task: 'مهمة',
    signIn: 'تسجيل الدخول',
    components: 'المكوّنات',
    notFound: 'الصفحة غير موجودة',
  },
  notFound: {
    title: 'هذه الصفحة غير موجودة',
    body: 'ربما يكون الرابط معطّلًا، أو نُقلت الصفحة.',
    home: 'الانتقال إلى الرئيسية',
  },
  loading: 'جارٍ تحميل مساحة العمل…',
};

export default shell;
