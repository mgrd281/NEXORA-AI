import type { Catalog } from '../../types';
import type source from '../en/memory';

const memory: Catalog<typeof source> = {
  title: 'الذاكرة',
  description: 'ما يتذكّره JARVIS عنك وكيف يستخدمه. لا يرى هذه الذكريات أحد غيرك.',
  kinds: {
    preference: 'تفضيل',
    fact: 'معلومة',
  },
  sources: {
    user: 'أنت',
    assistant: 'JARVIS',
  },
  empty: 'لم يتذكّر JARVIS أي شيء بعد.',
  disabled: 'الذاكرة متوقفة. لا يقرأ JARVIS الذكريات ولا يحفظها.',
  toggle: {
    label: 'استخدام الذاكرة',
    description:
      'يستعين JARVIS بالذكريات ذات الصلة عند تخطيط طلبك، حتى عندما يُرسل الطلب إلى نموذج ذكاء اصطناعي خارجي، ويحفظ ذكريات جديدة عندما تطلب منه أن يتذكّر شيئًا.',
  },
  retentionRule: 'تُحذف تلقائيًا، مرة يوميًا، الذكريات التي لم تتغير منذ {period}.',
  retentionKept: 'تبقى الذكريات محفوظة حتى تحذفها. اختر مدة ليُحذف القديم منها تلقائيًا.',
  disabledBanner:
    'لا يُستخدم شيء مما يلي ولا يُضاف إليه ما دامت الذاكرة متوقفة. تبقى ذكرياتك محفوظة حتى تحذفها.',
  search: {
    label: 'البحث في الذكريات',
    placeholder: 'البحث في الذكريات',
    results:
      '{count, plural, =0 {لا توجد ذكريات مطابقة.} one {ذكرى واحدة مطابقة.} two {ذكريان مطابقتان.} few {# ذكريات مطابقة.} many {# ذكرى مطابقة.} other {# ذكرى مطابقة.}}',
    resultsMore: 'أكثر من {count} ذكرى مطابقة.',
  },
  add: {
    title: 'إضافة ذكرى',
    label: 'ذكرى جديدة',
    placeholder: 'شيء ينبغي أن يعرفه JARVIS أو يراعيه',
    kindLegend: 'نوع الذكرى',
    kindHint: {
      fact: 'شيء صحيح عنك، مثل مكان عملك.',
      preference: 'الطريقة التي تفضّلها، مثل المقعد بجانب الممر في الطائرة.',
    },
    save: 'حفظ الذكرى',
    saved: 'حُفظت الذكرى',
    count: '{count} / {max}',
    required: 'اكتب الذكرى أولًا.',
    tooLong: 'الحد الأقصى {max} حرف.',
  },
  list: {
    title: 'ذكرياتك',
    addedByYou: 'أضفتها أنت',
    savedByJarvis: 'حفظها JARVIS',
    viewTask: 'عرض المهمة',
    added: 'أُضيفت {time}',
    edited: 'عُدّلت {time}',
    loading: 'جارٍ تحميل الذكريات…',
    loadMore: 'عرض المزيد',
    emptyFull:
      'لم يتذكّر JARVIS أي شيء بعد. أضف معلومة أو تفضيلًا في الأعلى، أو اطلب من JARVIS أن يتذكّر شيئًا.',
    noResults: 'لا توجد ذكريات تطابق «{query}».',
    clearSearch: 'مسح البحث',
  },
  item: {
    editLabel: 'تعديل الذكرى: {preview}',
    deleteLabel: 'حذف الذكرى: {preview}',
    editField: 'الذكرى',
    save: 'حفظ التغييرات',
    updated: 'حُدّثت الذكرى',
    deleted: 'حُذفت الذكرى',
  },
  deleteDialog: {
    title: 'حذف هذه الذكرى؟',
    body: 'سينساها JARVIS، ولا يمكن التراجع عن ذلك.',
    confirm: 'حذف الذكرى',
  },
  deleteAll: {
    title: 'حذف كل الذكريات',
    description: 'سينسى JARVIS كل ما في هذه الصفحة. تبقى مهامك واتصالاتك وإعداداتك كما هي.',
    button: 'حذف كل الذكريات…',
    dialogTitle: 'حذف كل الذكريات؟',
    counting: 'جارٍ عدّ ذكرياتك…',
    countFailed: 'تعذّر على JARVIS عدّ ذكرياتك.',
    body: '{count, plural, =0 {لا توجد ذكريات لحذفها.} one {سيؤدي هذا إلى حذف ذكراك الوحيدة نهائيًا.} two {سيؤدي هذا إلى حذف ذكرييك كلتيهما نهائيًا.} few {سيؤدي هذا إلى حذف ذكرياتك الـ# جميعها نهائيًا.} many {سيؤدي هذا إلى حذف ذكرياتك الـ# جميعها نهائيًا.} other {سيؤدي هذا إلى حذف ذكرياتك الـ# جميعها نهائيًا.}}',
    consequence: 'لن يستخدمها JARVIS بعد ذلك، ولا يمكن التراجع عن هذا.',
    confirm:
      '{count, plural, =0 {حذف الذكريات} one {حذف ذكرى واحدة} two {حذف ذكريين} few {حذف # ذكريات} many {حذف # ذكرى} other {حذف # ذكرى}}',
    done: '{count, plural, =0 {لم تُحذف أي ذكرى.} one {حُذفت ذكرى واحدة.} two {حُذفت ذكريان.} few {حُذفت # ذكريات.} many {حُذفت # ذكرى.} other {حُذفت # ذكرى.}}',
  },
};

export default memory;
