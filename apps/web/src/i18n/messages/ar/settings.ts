import type { Catalog } from '../../types';
import type source from '../en/settings';

const settings: Catalog<typeof source> = {
  title: 'الإعدادات',
  description: 'طريقة عمل JARVIS من أجلك. تُحفظ التغييرات فور إجرائها.',
  navLabel: 'أقسام الإعدادات',
  loading: 'جارٍ تحميل الإعدادات…',
  sections: {
    profile: 'الملف الشخصي',
    language: 'اللغة والمنطقة',
    appearance: 'المظهر',
    voice: 'الصوت',
    assistant: 'المساعد والاستقلالية',
    usage: 'الاستخدام والميزانية',
    notifications: 'الإشعارات',
    security: 'الأمان',
    privacy: 'الخصوصية والبيانات',
  },
  save: {
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ',
    failed: 'تعذّر الحفظ. {reason}',
  },
  language: 'اللغة',
  index: {
    voiceOn: 'القراءة بصوت عالٍ مفعّلة',
    voiceOff: 'القراءة بصوت عالٍ متوقفة',
    notificationsOn: '{on} من {total} مفعّلة',
    devices:
      '{count, plural, zero {لا أجهزة} one {جهاز واحد} two {جهازان} few {# أجهزة} many {# جهازًا} other {# جهاز}}',
    paidOff: 'النماذج المدفوعة متوقفة',
    memoryOn: 'الذاكرة مفعّلة',
    memoryOff: 'الذاكرة متوقفة',
  },
  profile: {
    displayName: 'الاسم المعروض',
    displayNameHint: 'يظهر في JARVIS ويُستخدم في التحية.',
    displayNameRequired: 'أدخل اسمًا.',
    email: 'البريد الإلكتروني',
    emailHint: 'تسجّل الدخول بهذا العنوان، ولا يمكن تغييره من هنا.',
    memberSince: 'عضو منذ {date}',
  },
  region: {
    languageHint: 'يُطبَّق فورًا على هذا الجهاز وعلى أجهزتك الأخرى.',
    timeZone: 'المنطقة الزمنية',
    timeZoneHint: 'تُستخدم للتواريخ والأوقات ولتحديد موعد إعادة ضبط ميزانيتك الشهرية.',
    useDevice: 'استخدام المنطقة الزمنية لهذا الجهاز ({zone})',
  },
  appearance: {
    theme: 'السمة',
    systemHint: 'خيار «النظام» يتبع إعداد الوضع الفاتح أو الداكن في جهازك.',
  },
  voice: {
    speak: 'قراءة الردود بصوت عالٍ',
    speakDescription:
      'بعد الطلب المنطوق، يقرأ JARVIS النتيجة بصوت عالٍ على هذا الجهاز. لا تُقرأ الطلبات المكتوبة أبدًا.',
    recognition: 'لغة التعرّف على الكلام',
    recognitionAuto: 'مثل لغة الواجهة ({language})',
    recognitionHint: 'اللغة التي يصغي إليها JARVIS عندما تُملي طلبك.',
  },
  assistant: {
    statusTitle: 'حالة المساعد',
    planner: 'التخطيط',
    plannerModelNote:
      'يخطّط نموذج ذكاء اصطناعي خارجي للطلبات، وتُحتسب تكاليفه من ميزانيتك الشهرية.',
    reasons: {
      NO_API_KEY:
        'لم يُضبط مفتاح لنموذج ذكاء اصطناعي على الخادم، لذا يعمل JARVIS في الوضع الأساسي. يتعامل مع مجموعة ثابتة من الأوامر، لكنه لا يجيب عن الأسئلة المفتوحة.',
      USER_DISABLED_EXTERNAL_MODELS:
        'أوقفت نماذج الذكاء الاصطناعي الخارجية، لذا يعمل JARVIS في الوضع الأساسي ولا يرسل شيئًا إلى أي مزوّد.',
      BUDGET_EXHAUSTED:
        'نفدت ميزانية الذكاء الاصطناعي لهذا الشهر، لذا يعمل JARVIS في الوضع الأساسي حتى تُعاد الميزانية أو ترفعها.',
      BUDGET_ZERO:
        'ميزانيتك الشهرية للذكاء الاصطناعي 0، لذا يعمل JARVIS في الوضع الأساسي ولا يستخدم أي نموذج مدفوع.',
      unknown: 'لا يتوفر نموذج ذكاء اصطناعي الآن، لذا يعمل JARVIS في الوضع الأساسي.',
    },
    worker: 'خدمة المعالجة',
    workerHealthy: 'تعمل',
    workerUnhealthy: 'لا تستجيب',
    workerUnhealthyNote:
      'تنتظر الطلبات الجديدة في قائمة الانتظار حتى تعود خدمة المعالجة إلى العمل.',
    heartbeat: 'آخر إشارة {time}',
    noHeartbeat: 'لم تصل أي إشارة بعد',
    version: 'الإصدار',
    capabilities: 'ما يستطيعه JARVIS الآن',
    capability: {
      webFetch: 'قراءة صفحات الويب',
      email: 'إرسال البريد الإلكتروني',
      memory: 'استخدام الذاكرة',
      generalQuestions: 'الإجابة عن الأسئلة المفتوحة',
    },
    capabilityOn: 'متاح',
    capabilityOff: 'غير متاح',
    capabilityFix: {
      webFetch: 'تفعيل الوصول إلى الويب',
      email: 'ربط البريد الإلكتروني',
      memory: 'تشغيل الذاكرة',
      generalQuestions: 'يتطلب نموذج ذكاء اصطناعي',
    },
    statusFailed: 'تعذّر على JARVIS تحميل حالة المساعد.',
    externalModels: 'السماح بنماذج الذكاء الاصطناعي الخارجية',
    externalModelsDescription:
      'عند التفعيل، قد يُرسل طلبك والذكريات ذات الصلة إلى مزوّد الذكاء الاصطناعي المضبوط على هذا الخادم لتخطيطه والإجابة عنه. عند الإيقاف، لا يُرسل شيء إلى أي نموذج خارجي ويعمل JARVIS في الوضع الأساسي.',
    externalModelsInactive:
      'لم يُضبط أي مزوّد للذكاء الاصطناعي على هذا الخادم، لذا لا أثر لهذا الخيار بعد.',
    autoApprove: 'إرسال الرسائل إليّ دون سؤال',
    autoApproveDescription:
      'عند التفعيل، تُرسل الرسالة التي يكون جميع مستلميها عنوانك أنت ({email}) دون سؤالك أولًا. تبقى أي رسالة إلى شخص آخر بحاجة إلى موافقتك، وكذلك الرسالة التي يصنّفها JARVIS على أنها غير معتادة، مثل رسالة مبنية على محتوى ويب مريب.',
    budget: 'الميزانية الشهرية للذكاء الاصطناعي',
    budgetHint:
      'تتوقف تكاليف نماذج الذكاء الاصطناعي عند هذا المبلغ كل شهر، ثم ينتقل JARVIS إلى الوضع الأساسي. أدخل 0 لعدم استخدام النماذج المدفوعة أبدًا.',
    budgetHintInactive:
      'تُطبَّق بعد ضبط نموذج ذكاء اصطناعي على هذا الخادم، وعندها تتوقف تكاليف نماذج الذكاء الاصطناعي عند هذا المبلغ كل شهر. أدخل 0 لعدم استخدام النماذج المدفوعة أبدًا.',
    budgetUnit: 'USD',
    budgetInvalid: 'أدخل مبلغًا من 0 إلى 10,000.',
    usageTitle: 'هذا الشهر',
    usageSpent: '{spent} من {budget}',
    usageSpentNoBudget: 'أُنفق {spent}',
    usageMeter: 'المستهلك من ميزانية الذكاء الاصطناعي',
    usageMeterText: 'استُهلك {spent} من {budget}',
    usageNoPaid: 'النماذج المدفوعة متوقفة لأن الميزانية 0.',
    usageBreakdown: 'نماذج الذكاء الاصطناعي {ai} · الأدوات {tools}',
    usageResets: 'تُعاد في {date}',
    usageExhausted: 'نفدت ميزانية هذا الشهر. يعمل JARVIS في الوضع الأساسي حتى تُعاد الميزانية.',
    usageFailed: 'تعذّر على JARVIS تحميل استهلاك هذا الشهر.',
    tasksCompleted: 'مكتملة',
    tasksFailed: 'فاشلة أو ملغاة',
    tasksTotal: 'مهام هذا الشهر',
  },
  notifications: {
    description:
      'هذه إشعارات داخل التطبيق: تظهر تحت أيقونة الجرس في JARVIS. لا يُرسل شيء بالبريد الإلكتروني أو إلى هاتفك.',
    approvalRequested: 'طلبات الموافقة',
    approvalRequestedDescription:
      'عندما يحتاج JARVIS إلى موافقتك قبل أن يتصرّف. تنتظرك الموافقات دائمًا في «المهام» حتى لو أوقفت هذا الخيار.',
    taskCompleted: 'المهام المكتملة',
    taskCompletedDescription: 'عندما تنتهي مهمة بنجاح.',
    taskFailed: 'المهام الفاشلة',
    taskFailedDescription: 'عندما تفشل مهمة أو يتعذّر استكمالها.',
    connectionNote: 'تصلك دائمًا إشعارات مشكلات الاتصالات، كي يواصل JARVIS العمل.',
  },
  security: {
    sessionsTitle: 'الأجهزة المسجّل دخولها',
    sessionsDescription: 'سجّل خروج أي جهاز لا تعرفه أو لم تعد تستخدمه.',
    browserOn: '{browser} على {os}',
    unknownBrowser: 'متصفح غير معروف',
    unknownDevice: 'جهاز غير معروف',
    platforms: {
      web: 'الويب',
      ios: 'تطبيق iPhone أو iPad',
      android: 'تطبيق Android',
      macos: 'تطبيق Mac',
    },
    thisDevice: 'هذا الجهاز',
    lastActive: 'نشط {time}',
    signedIn: 'سجّل الدخول في {date}',
    revoke: 'تسجيل الخروج',
    revokeLabel: 'تسجيل الخروج من {device}',
    revoked: 'سُجّل الخروج من {device}.',
    signOut: 'تسجيل الخروج',
    signOutLabel: 'تسجيل الخروج من هذا الجهاز',
    signingOut: 'جارٍ تسجيل الخروج…',
    loading: 'جارٍ تحميل الأجهزة…',
    failed: 'تعذّر على JARVIS تحميل أجهزتك.',
  },
  privacy: {
    memoryTitle: 'الذاكرة',
    memoryDescription: 'شغّل الذاكرة أو أوقفها، وراجع ما يتذكّره JARVIS.',
    memoryLink: 'إدارة الذاكرة',
    exportTitle: 'تصدير بياناتك',
    exportDescription:
      'نزّل كل ما يحفظه JARVIS عنك في ملف JSON واحد: الملف الشخصي والإعدادات والمهام والموافقات والذكريات والإشعارات والاتصالات. لا تُضمَّن كلمات المرور أو المفاتيح أبدًا.',
    exportButton: 'تصدير بياناتي',
    exporting: 'جارٍ تجهيز التصدير…',
    exported: 'نُزّل الملف {file}',
    deleteTitle: 'حذف الحساب',
    deleteDescription:
      'يحذف حسابك وكل ما فيه نهائيًا: المهام والذكريات والاتصالات وكلمات المرور المحفوظة.',
    deleteButton: 'حذف الحساب…',
    deleteDialog: {
      title: 'حذف حسابك؟',
      body: 'يُحذف كل ما في حسابك فورًا ولا يمكن استعادته، وسيُسجَّل خروجك من جميع الأجهزة.',
      exportFirst: 'صدّر بياناتك أولًا إن أردت الاحتفاظ بنسخة منها.',
      password: 'كلمة المرور',
      confirmLabel: 'اكتب DELETE للتأكيد',
      confirmHint: 'اكتب الكلمة DELETE بأحرف إنجليزية كبيرة.',
      wrongPassword: 'كلمة المرور غير صحيحة.',
      confirm: 'حذف الحساب نهائيًا',
      deleting: 'جارٍ الحذف…',
    },
  },
};

export default settings;
