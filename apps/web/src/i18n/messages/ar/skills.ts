import type { Catalog } from '../../types';
import type source from '../en/skills';

const skills: Catalog<typeof source> = {
  description:
    'ما يستطيع JARVIS فعله، وما تسمح به منه. عند إيقاف مهارة لا يخطّط JARVIS لإجراءاتها ولا ينفّذها. المهارات لا تمنح أي صلاحيات: تظل سياسة الأمان تفحص كل خطوة، وكل ما ينطوي على خطورة يسألك أولًا.',
  loading: 'جارٍ تحميل المهارات…',
  loadError: 'تعذّر تحميل المهارات.',
  listLabel: 'المهارات',
  plannedTitle: 'لاحقًا',
  plannedDescription: 'موصوفة في خطة المنتج لكنها لم تُبنَ بعد، ولا يمكن تشغيلها.',
  status: {
    on: 'مفعّلة',
    off: 'متوقفة',
    needsConnection: 'تحتاج إلى اتصال',
    unavailable: 'غير متاحة',
    planned: 'مخطط لها',
    core: 'مفعّلة دائمًا',
  },
  reasons: {
    PLANNED: 'لم تُبنَ بعد.',
    DISABLED_BY_USER: 'متوقفة. لن يخطّط JARVIS لإجراءاتها ولن ينفّذها.',
    CONNECTION_REQUIRED: 'تحتاج إلى {connections}.',
    MODEL_REQUIRED: 'تحتاج إلى نموذج ذكاء اصطناعي، ولا يتوفر أي نموذج حاليًا.',
    MEMORY_DISABLED: 'الذاكرة متوقفة.',
    STORAGE_NOT_CONFIGURED: 'تخزين الملفات غير مُعَدّ على هذا الخادم.',
    PROVIDER_NOT_CONFIGURED: 'لا يوجد اتصال بـ Google أو Microsoft مُعدّ على هذا الخادم.',
    BROWSER_UNAVAILABLE: 'وكيل المتصفح لا يعمل على هذا الخادم.',
    TELEPHONY_NOT_CONFIGURED: 'لم تُعدّ المكالمات الهاتفية على هذا الخادم.',
  },
  connections: {
    web: 'الوصول إلى الويب',
    smtp: 'اتصال بريد إلكتروني',
    google: 'حساب Google',
    microsoft: 'حساب Microsoft',
  },
  connect: 'فتح الاتصالات',
  risk: {
    LOW: 'تقرأ أو تُعِدّ أشياء لك فقط، لذا تعمل دون أن تسألك.',
    MEDIUM: 'تتصرف نيابةً عنك، لذا يسألك JARVIS أولًا.',
    HIGH: 'قد تكون لها عواقب حقيقية، لذا يسألك JARVIS دائمًا أولًا.',
    CRITICAL: 'ستكون لها عواقب خطيرة، وهذا ما لا يفعله JARVIS أبدًا.',
  },
  model: {
    required: 'تحتاج إلى نموذج ذكاء اصطناعي.',
    optional: 'تستخدم نموذج ذكاء اصطناعي عند توفره.',
    none: 'تعمل دون نموذج ذكاء اصطناعي.',
  },
  core: 'جزء من طريقة تخطيط JARVIS وطرحه للأسئلة، لذا لا يمكن إيقافها.',
  memoryNote: 'هو نفس مفتاح «استخدام الذاكرة» في صفحة الذاكرة.',
  turnedOn: 'فُعّلت مهارة {name}.',
  turnedOff: 'أُوقفت مهارة {name}.',
  names: {
    'web-research': 'البحث على الويب',
    'email-management': 'البريد الإلكتروني',
    'calendar-management': 'التقويم',
    'appointment-booking': 'حجز المواعيد',
    'phone-calling': 'المكالمات الهاتفية',
    'shopping-assistant': 'التسوق',
    'document-analysis': 'المستندات',
    'task-scheduling': 'الجدولة',
    'personal-memory': 'الذاكرة',
    'device-automation': 'أتمتة الأجهزة',
    translation: 'الترجمة',
    'workflow-planning': 'التخطيط والأسئلة',
  },
  descriptions: {
    'web-research': 'تقرأ صفحات الويب العامة التي ترسل روابطها وتلخّصها.',
    'email-management': 'تكتب الرسائل وترسلها من صندوق بريدك المتصل، كل رسالة بعد موافقتك.',
    'calendar-management': 'تقرأ تقويمك وتقترح تغييرات عليه أو تجريها.',
    'appointment-booking': 'تحجز المواعيد لدى الجهات نيابةً عنك.',
    'phone-calling': 'تُجري مكالمات نيابةً عنك وتوضّح أنها ذكاء اصطناعي.',
    'shopping-assistant': 'تقارن المنتجات وتُعِدّ عمليات الشراء لتؤكدها أنت.',
    'document-analysis': 'تقرأ الملفات التي ترفقها (PDF وWord والنصوص وCSV) وتلخّصها.',
    'task-scheduling': 'تنفّذ الطلبات نيابةً عنك كل يوم أو أسبوع أو شهر.',
    'personal-memory': 'تتذكر الحقائق والتفضيلات التي تشاركها وتستخدمها عند التخطيط.',
    'device-automation': 'تتحكم في التطبيقات والأجهزة نيابةً عنك.',
    translation: 'تترجم النصوص والنتائج والمستندات إلى لغات أخرى.',
    'workflow-planning':
      'تخطّط لكل طلب، وتجيب عن الأسئلة، وتسأل عندما ينقص شيء، وتعيد استخدام النتائج السابقة في المحادثة.',
  },
};

export default skills;
