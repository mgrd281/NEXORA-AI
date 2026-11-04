import type { Catalog } from '../../types';
import type source from '../en/conversations';

const conversations: Catalog<typeof source> = {
  list: {
    description: 'تجمع كل محادثة طلبًا مع أسئلة المتابعة والإجابات عليه.',
    label: 'المحادثات',
    searchLabel: 'البحث في المحادثات',
    searchPlaceholder: 'ابحث في العناوين والطلبات',
    loading: 'جارٍ تحميل المحادثات…',
    loadingMore: 'جارٍ تحميل مزيد من المحادثات…',
    loadError: 'تعذّر تحميل محادثاتك.',
    loadMoreError: 'تعذّر تحميل مزيد من المحادثات.',
    empty: 'لا توجد محادثات بعد. كل طلب ترسله إلى JARVIS يبدأ محادثة.',
    noResults: 'لا توجد محادثات تطابق «{query}».',
    clearSearch: 'مسح البحث',
    requests:
      '{count, plural, zero {لا طلبات} one {طلب واحد} two {طلبان} few {# طلبات} many {# طلبًا} other {# طلب}}',
    active: 'قيد التنفيذ',
    fromSchedule: 'مجدولة',
    accessibleName: '{title}، {requests}، آخر تحديث {time}',
    shown:
      '{count, plural, zero {لا محادثات معروضة} one {محادثة واحدة معروضة} two {محادثتان معروضتان} few {# محادثات معروضة} many {# محادثة معروضة} other {# محادثة معروضة}}',
    allShown: 'هذا كل شيء.',
  },
  thread: {
    title: 'المحادثة',
    earlierTitle: 'في وقت سابق من هذه المحادثة',
    laterTitle: 'منذ ذلك الحين',
    showEarlier: 'عرض الطلبات السابقة',
    loadError: 'تعذّر تحميل بقية هذه المحادثة.',
    you: 'أنت',
    jarvis: 'JARVIS',
    turnLabel: 'الطلب {position}',
    openTask: 'فتح المهمة',
    requests:
      '{count, plural, zero {لا طلبات} one {طلب واحد} two {طلبان} few {# طلبات} many {# طلبًا} other {# طلب}}',
  },
  followUp: {
    title: 'المتابعة',
    label: 'متابعة إلى JARVIS',
    placeholder: 'اكتب متابعة، مثل «أرسله لي»…',
    answerPlaceholder: 'اكتب إجابتك…',
    hint: 'يرى JARVIS الطلبات والنتائج السابقة في هذه المحادثة، ويتعامل مع النتائج على أنها معلومات لا تعليمات.',
    send: 'إرسال المتابعة',
    sent: 'أُرسلت المتابعة.',
    busy: 'يمكنك المتابعة بعد انتهاء الطلب الأخير.',
    busyApproval: 'الطلب الأخير بانتظار موافقتك. وافق عليه أو ارفضه، ثم تابع.',
    busyGeneric: 'يمكنك المتابعة بعد انتهاء الطلب الحالي.',
    openBusy: 'فتحه',
    reviewBusy: 'مراجعته',
  },
  question: {
    title: 'لدى JARVIS سؤال',
    hint: 'أجب هنا وسيكمل JARVIS في هذه المحادثة. لم يُنفَّذ أي شيء بعد.',
    answerLabel: 'إجابتك',
    attach: 'إرفاق الملف',
    answered: 'أجبت عن هذا في الأسفل.',
    missing: {
      email_content: 'محتوى الرسالة',
      recipient: 'عنوان بريد إلكتروني',
      url: 'رابطًا',
      document: 'ملفًا',
      schedule_time: 'موعدًا',
      target_language: 'لغة',
      previous_result: 'ما يجب إرساله أو حفظه',
      details: 'مزيدًا من التفاصيل',
      date_time: 'تاريخًا ووقتًا',
      contact_details: 'بيانات الاتصال الخاصة بك',
      product: 'المنتج المقصود',
      site: 'الموقع المقصود',
    },
  },
  delete: {
    button: 'حذف المحادثة…',
    title: 'هل تريد حذف هذه المحادثة؟',
    body: '{count, plural, zero {تُحذف المحادثة. لا يمكن التراجع عن ذلك.} one {يُحذف طلبها ونتيجته والملفات المرفقة. لا يمكن التراجع عن ذلك.} two {يُحذف طلباها مع نتائجهما والملفات المرفقة. لا يمكن التراجع عن ذلك.} few {تُحذف طلباتها الـ# مع نتائجها والملفات المرفقة. لا يمكن التراجع عن ذلك.} many {تُحذف طلباتها الـ# مع نتائجها والملفات المرفقة. لا يمكن التراجع عن ذلك.} other {تُحذف طلباتها الـ# مع نتائجها والملفات المرفقة. لا يمكن التراجع عن ذلك.}}',
    scheduleNote: 'يبقى الجدول الذي ينفّذها، وسيبدأ تنفيذه التالي محادثة جديدة.',
    confirm: 'حذف المحادثة',
    deleted: 'حُذفت المحادثة.',
  },
  details: {
    conversation: 'المحادثة',
  },
};

export default conversations;
