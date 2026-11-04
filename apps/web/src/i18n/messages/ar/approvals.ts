import type { Catalog } from '../../types';
import type source from '../en/approvals';

const approvals: Catalog<typeof source> = {
  title: {
    email: 'راجع هذه الرسالة',
    generic: 'راجع هذا الإجراء',
    schedule: 'راجع هذا الجدول',
    memory: 'راجع ما سيتذكّره JARVIS',
  },
  fields: {
    from: 'من',
    to: 'إلى',
    subject: 'الموضوع',
    body: 'الرسالة',
    noSubject: '(بلا موضوع)',
    scheduleTitle: 'الاسم',
    request: 'ما يُطلب في كل تنفيذ',
    repeats: 'التكرار',
    nextRuns: 'مواعيد التنفيذ القادمة',
    timeZone: 'المنطقة الزمنية',
    rule: 'القاعدة (RFC 5545)',
    memoryContent: 'سيُحفظ',
    memoryKind: 'النوع',
    source: 'مأخوذ من',
  },
  recipients:
    '{count, plural, zero {لا مستلمين} one {مستلم واحد} two {مستلمان} few {# مستلمين} many {# مستلمًا} other {# مستلم}}',
  summary: {
    email: 'إرسال «{subject}» إلى {recipients}',
  },
  why: 'لماذا يطلب JARVIS موافقتك',
  reasons: {
    RISK_LOW: 'هذا إجراء منخفض الخطورة.',
    RISK_MEDIUM: 'خطورة هذا الإجراء متوسطة، لذا يطلب JARVIS موافقتك قبل تنفيذه.',
    RISK_HIGH: 'هذا إجراء عالي الخطورة، ويطلب JARVIS موافقتك دائمًا قبل تنفيذه.',
    RISK_CRITICAL: 'صُنّف هذا الإجراء على أنه حرج الخطورة.',
    RECIPIENT_SELF: 'تُرسَل الرسالة إلى عنوانك فقط.',
    RECIPIENT_EXTERNAL: 'تُرسَل الرسالة إلى أشخاص غيرك.',
    MANY_RECIPIENTS: 'للرسالة أكثر من ثلاثة مستلمين.',
    BUDGET_NEAR_LIMIT: 'قد تتجاوز تكلفة هذه الخطوة ما تبقّى من ميزانية الذكاء الاصطناعي الشهرية.',
    UNTRUSTED_CONTENT:
      'يستخدم محتوى من صفحة ويب تتضمن نصًا يبدو كتعليمات موجّهة إلى الذكاء الاصطناعي.',
    AUTO_APPROVED_SELF: 'تسمح إعداداتك بإرسال الرسائل إلى نفسك دون سؤالك.',
    SKILL_DISABLED: 'المهارة اللازمة لذلك متوقفة في الإعدادات.',
    SKILL_COST_LIMIT: 'قد تتجاوز التكلفة الحد المحدد لهذه المهارة.',
    MEMORY_FROM_CONTENT: 'النص مأخوذ من نتيجة سابقة، لذا تقرر أنت بالضبط ما يحتفظ به JARVIS.',
    UNTRUSTED_MEMORY:
      'النص مأخوذ من محتوى حاول توجيه تعليمات إلى مساعدي الذكاء الاصطناعي، لذا لا يمكن حفظه.',
    FUTURE_RUNS: 'ينشئ هذا طلبات تُنفَّذ لاحقًا من تلقاء نفسها، لذا يسألك JARVIS قبل إنشائه.',
    unknown: 'وضعت سياسة الأمان علامة على هذا الإجراء ({code}).',
  },
  untrusted: {
    chip: 'مصدر غير موثوق',
    title: 'حاول نص في {host} إعطاء تعليمات لمساعدي الذكاء الاصطناعي.',
    titleNoHost: 'حاول نص في أحد المصادر المستخدمة إعطاء تعليمات لمساعدي الذكاء الاصطناعي.',
    leftOut: 'استبعد JARVIS هذا النص من الملخص.',
    leftOutCount:
      '{count, plural, zero {لم يستبعد JARVIS أي جملة من الملخص.} one {استبعد JARVIS هذه الجملة من الملخص.} two {استبعد JARVIS هاتين الجملتين من الملخص.} few {استبعد JARVIS هذه الجمل الـ# من الملخص.} many {استبعد JARVIS هذه الجمل الـ# من الملخص.} other {استبعد JARVIS هذه الجمل الـ# من الملخص.}}',
    mayInclude: 'قد تظهر أجزاء منه في الرسالة.',
    check: 'راجع الرسالة قبل الموافقة.',
  },
  expires: 'تنتهي صلاحيته {time}',
  note: {
    add: 'إضافة ملاحظة',
    label: 'ملاحظة',
    hint: 'تُحفظ مع قرارك ولا تُرسَل إلى أحد.',
  },
  approve: {
    email: 'الموافقة والإرسال',
    generic: 'موافقة',
    schedule: 'الموافقة والإنشاء',
    memory: 'الموافقة والحفظ',
  },
  approveLabel: {
    email: 'الموافقة والإرسال لهذه الرسالة',
    generic: 'الموافقة على هذا الإجراء',
    schedule: 'الموافقة والإنشاء لهذا الجدول',
    memory: 'الموافقة والحفظ في الذاكرة',
  },
  decline: 'رفض',
  declineLabel: {
    email: 'رفض إرسال هذه الرسالة',
    generic: 'رفض هذا الإجراء',
    schedule: 'رفض إنشاء هذا الجدول',
    memory: 'رفض الحفظ في الذاكرة',
  },
  results: {
    approved: 'تمت الموافقة. يتابع JARVIS تنفيذ المهمة.',
    rejected: 'تم الرفض. لن ينفّذ JARVIS هذا الإجراء.',
  },
  errors: {
    mismatch: 'تغيّر الإجراء — راجعه مرة أخرى.',
    expired: 'انتهت صلاحية هذا الطلب. أعد تشغيل المهمة للحصول على طلب جديد.',
    alreadyDecided: 'سبق اتخاذ قرار بشأن هذه الموافقة.',
  },
  decided: {
    APPROVED: 'وافقت على هذا {time}.',
    REJECTED: 'رفضت هذا {time}.',
    EXPIRED: 'انتهت صلاحية هذا الطلب {time}.',
    CANCELLED: 'أُلغي هذا الطلب.',
    SUPERSEDED: 'استُبدل هذا الطلب بطلب أحدث.',
  },
  scheduleNote:
    'لا يُوافَق على أي شيء مسبقًا: يُخطَّط لكل تنفيذ ويُفحص على حدة، وكل ما يحتاج إلى موافقتك سيسألك حينها.',
  memorySource: 'نتيجة مهمة سابقة',
  memoryNote: 'يحتفظ JARVIS بهذا النص كما هو تمامًا، ويمكنك تعديله أو حذفه لاحقًا في الذاكرة.',
  openTask: 'فتح المهمة',
  task: 'المهمة',
};

export default approvals;
