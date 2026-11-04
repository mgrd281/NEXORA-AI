import type { Catalog } from '../../types';
import type source from '../en/schedules';

const schedules: Catalog<typeof source> = {
  description:
    'طلبات ينفّذها JARVIS نيابةً عنك وفق جدول. يُخطَّط لكل تنفيذ ويُفحص كأنه طلب جديد، وما يحتاج إلى موافقتك يظل يسألك.',
  new: 'جدول جديد',
  listLabel: 'الجداول',
  empty: 'لا يوجد شيء مجدول بعد. جدوِل طلبًا لينفّذه JARVIS كل يوم أو أسبوع أو شهر.',
  loading: 'جارٍ تحميل الجداول…',
  loadError: 'تعذّر تحميل جداولك.',
  limit: '{count} من {max} جداول',
  status: {
    active: 'نشط',
    paused: 'متوقف مؤقتًا',
    completed: 'منتهٍ',
  },
  pausedReason: {
    user: 'أوقفته مؤقتًا.',
    failures: 'أُوقف مؤقتًا بعد {count} عمليات تنفيذ فاشلة متتالية.',
    budget: 'أُوقف مؤقتًا لأن ميزانية الذكاء الاصطناعي لهذا الشهر نفدت.',
  },
  completedNote: 'اكتملت جميع عمليات التنفيذ.',
  next: 'التنفيذ التالي',
  lastRun: 'آخر تنفيذ',
  noRunsYet: 'لم يُنفَّذ بعد',
  runCount:
    '{count, plural, zero {لا عمليات تنفيذ} one {تنفيذ واحد} two {تنفيذان} few {# عمليات تنفيذ} many {# عملية تنفيذ} other {# عملية تنفيذ}}',
  inZone: '{time} ({zone})',
  request: 'ما يُطلب في كل تنفيذ',
  createdByAgent: 'أنشأ JARVIS هذا الجدول من طلب وافقت عليه.',
  actions: {
    pause: 'إيقاف مؤقت',
    resume: 'استئناف',
    edit: 'تعديل',
    delete: 'حذف',
    history: 'عرض عمليات التنفيذ',
    hideHistory: 'إخفاء عمليات التنفيذ',
    openConversation: 'فتح المحادثة',
  },
  actionFor: '{action}: {title}',
  toasts: {
    created: 'أُنشئ الجدول.',
    saved: 'حُفظ الجدول.',
    paused: 'أُوقف الجدول مؤقتًا، ولن يُنفَّذ حتى تستأنفه.',
    resumed: 'استُؤنف الجدول.',
    deleted: 'حُذف الجدول.',
  },
  deleteDialog: {
    title: 'هل تريد حذف هذا الجدول؟',
    body: 'سيتوقف JARVIS عن تنفيذ «{title}». تبقى المهام التي أنشأها في سجلك.',
    confirm: 'حذف الجدول',
  },
  history: {
    upcoming: 'القادم',
    upcomingNone: 'لا توجد عمليات تنفيذ قادمة.',
    recent: 'عمليات التنفيذ الأخيرة',
    recentNone: 'لم يُنفَّذ بعد.',
    loading: 'جارٍ تحميل عمليات التنفيذ…',
    loadError: 'تعذّر تحميل عمليات التنفيذ.',
    run: {
      created: 'نُفِّذ',
      skipped: 'تُخطّي',
      failed: 'تعذّر البدء',
    },
    reasons: {
      BUDGET_EXHAUSTED: 'نفدت ميزانية الذكاء الاصطناعي.',
      SCHEDULE_PAUSED: 'كان الجدول متوقفًا مؤقتًا.',
      CREATE_FAILED: 'تعذّر إنشاء المهمة.',
    },
    taskGone: 'حُذفت المهمة.',
  },
  editor: {
    createTitle: 'جدول جديد',
    editTitle: 'تعديل الجدول',
    name: 'الاسم',
    namePlaceholder: 'مثلًا: ملخص أسبوعي لقانون الذكاء الاصطناعي',
    nameRequired: 'أعطِ الجدول اسمًا.',
    request: 'ماذا ينبغي أن يفعل JARVIS في كل مرة؟',
    requestPlaceholder: 'مثلًا: لخّص https://example.com/news وأرسله لي بالبريد',
    requestHint:
      'اكتبه كطلب عادي. يُخطَّط لكل تنفيذ ويُفحص عند حدوثه، وما يحتاج إلى موافقتك يسألك حينها.',
    requestRequired: 'اكتب ما ينبغي أن يفعله JARVIS.',
    frequencyLegend: 'التكرار',
    frequency: {
      daily: 'يومي',
      weekly: 'أسبوعي',
      monthly: 'شهري',
    },
    interval: 'كم مرة',
    intervalOption: {
      daily:
        '{count, plural, zero {كل يوم} one {كل يوم} two {كل يومين} few {كل # أيام} many {كل # يومًا} other {كل # يوم}}',
      weekly:
        '{count, plural, zero {كل أسبوع} one {كل أسبوع} two {كل أسبوعين} few {كل # أسابيع} many {كل # أسبوعًا} other {كل # أسبوع}}',
      monthly:
        '{count, plural, zero {كل شهر} one {كل شهر} two {كل شهرين} few {كل # أشهر} many {كل # شهرًا} other {كل # شهر}}',
    },
    daysLegend: 'في هذه الأيام',
    daysRequired: 'اختر يومًا واحدًا على الأقل.',
    dayOfMonth: 'يوم الشهر',
    dayOfMonthHint: 'يُتخطّى الشهر الذي لا يحتوي على هذا اليوم.',
    lastDay: 'آخر يوم من الشهر',
    time: 'الوقت',
    timeZone: 'المنطقة الزمنية',
    preview: 'مواعيد التنفيذ القادمة',
    previewLoading: 'جارٍ حساب مواعيد التنفيذ القادمة…',
    previewNone: 'لن يُنفَّذ هذا الجدول أبدًا.',
    ends: 'ينتهي',
    create: 'إنشاء الجدول',
    save: 'حفظ التغييرات',
  },
  recurrence: {
    daily:
      '{count, plural, zero {يوميًا الساعة {time}} one {يوميًا الساعة {time}} two {كل يومين الساعة {time}} few {كل # أيام الساعة {time}} many {كل # يومًا الساعة {time}} other {كل # يوم الساعة {time}}}',
    weekly:
      '{count, plural, zero {كل أسبوع يوم {days} الساعة {time}} one {كل أسبوع يوم {days} الساعة {time}} two {كل أسبوعين يوم {days} الساعة {time}} few {كل # أسابيع يوم {days} الساعة {time}} many {كل # أسبوعًا يوم {days} الساعة {time}} other {كل # أسبوع يوم {days} الساعة {time}}}',
    workdays:
      '{count, plural, zero {من الاثنين إلى الجمعة الساعة {time}} one {من الاثنين إلى الجمعة الساعة {time}} two {كل أسبوعين، من الاثنين إلى الجمعة، الساعة {time}} few {كل # أسابيع، من الاثنين إلى الجمعة، الساعة {time}} many {كل # أسبوعًا، من الاثنين إلى الجمعة، الساعة {time}} other {كل # أسبوع، من الاثنين إلى الجمعة، الساعة {time}}}',
    monthly:
      '{count, plural, zero {شهريًا يوم {days} الساعة {time}} one {شهريًا يوم {days} الساعة {time}} two {كل شهرين يوم {days} الساعة {time}} few {كل # أشهر يوم {days} الساعة {time}} many {كل # شهرًا يوم {days} الساعة {time}} other {كل # شهر يوم {days} الساعة {time}}}',
    ordinal: {
      one: '{n}',
      two: '{n}',
      few: '{n}',
      other: '{n}',
    },
    lastDay: 'آخر يوم من الشهر',
    until: '{phrase}، حتى {date}',
    count:
      '{phrase}، {count, plural, zero {دون تكرار} one {مرة واحدة} two {مرتين} few {# مرات} many {# مرة} other {# مرة}} إجمالًا',
  },
};

export default schedules;
