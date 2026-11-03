import type { Catalog } from '../../types';
import type source from '../en/home';

const home: Catalog<typeof source> = {
  title: 'الرئيسية',
  greeting: {
    morning: 'صباح الخير يا {name}',
    afternoon: 'مساء الخير يا {name}',
    evening: 'مساء الخير يا {name}',
  },
  greetingAnonymous: {
    morning: 'صباح الخير',
    afternoon: 'مساء الخير',
    evening: 'مساء الخير',
  },
  status: {
    ready: 'جاهز',
    offlinePlanner: 'جاهز في الوضع الأساسي',
    approvals:
      '{count, plural, zero {لا طلبات بانتظار موافقتك} one {بحاجة إلى موافقتك} two {طلبان بانتظار موافقتك} few {# طلبات بانتظار موافقتك} many {# طلبًا بانتظار موافقتك} other {# طلب بانتظار موافقتك}}',
    working:
      '{count, plural, zero {لا مهام قيد العمل} one {يعمل على مهمة واحدة} two {يعمل على مهمتين} few {يعمل على # مهام} many {يعمل على # مهمة} other {يعمل على # مهمة}}',
    queued:
      '{count, plural, zero {لا مهام في الانتظار} one {مهمة واحدة بانتظار البدء} two {مهمتان بانتظار البدء} few {# مهام بانتظار البدء} many {# مهمة بانتظار البدء} other {# مهمة بانتظار البدء}}',
  },
  sections: {
    approvals: 'بانتظارك',
    active: 'قيد التنفيذ',
    recent: 'أحدث النتائج',
  },
  sectionCount:
    '{count, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}',
  viewAll: 'عرض الكل',
  approval: {
    review: 'مراجعة',
    reviewLabel: 'مراجعة: {title}',
    expires: 'تنتهي صلاحيته {time}',
  },
  loading: 'جارٍ تحميل الصفحة الرئيسية…',
  loadError: 'تعذّر تحميل الصفحة الرئيسية.',
  firstRun: {
    title: 'اطلب ما تريد بكلماتك',
    body: 'يخطط JARVIS للخطوات، ويفحصها وفق إعدادات الأمان لديك، ويعرض عليك كل ما يتصرف نيابةً عنك قبل أن يحدث.',
    stepPlan: 'ترى الخطة قبل تنفيذ أي شيء',
    stepApprove: 'تنتظر الرسائل والإجراءات الأخرى موافقتك',
    stepEvidence: 'تأتي كل نتيجة مع أدلتها',
    tryLabel: 'جرّب أحد هذه الطلبات',
  },
  examples: {
    summarize: 'لخّص https://www.w3.org/TR/WCAG22/',
    remember: 'تذكّر أنني أفضّل المقاعد بجانب الممر في الرحلات',
    emailMe: 'أرسل لي: الاتصال بطبيب الأسنان يوم الجمعة',
  },
  suggestionsLabel: 'اقتراحات',
  suggestionFills: 'يضع هذا الطلب في شريط الأوامر',
  suggest: {
    enableWeb: 'اسمح لـ JARVIS بقراءة صفحات الويب العامة',
    connectEmail: 'اربط بريدك الإلكتروني ليتمكن JARVIS من إرسال الرسائل',
    configureModel: 'يعمل JARVIS دون نموذج ذكاء اصطناعي — اطّلع على ما يمكنه فعله',
    summarizeAndEmail: 'لخّص صفحة ويب وأرسلها إلى بريدك',
    remember: 'أخبر JARVIS بشيء ليتذكّره',
  },
  suggestCommands: {
    summarizeAndEmail: 'لخّص https:// وأرسله لي بالبريد',
    remember: 'تذكّر أن ',
  },
};

export default home;
