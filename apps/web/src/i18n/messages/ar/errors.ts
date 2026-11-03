import type { Catalog } from '../../types';
import type source from '../en/errors';

const errors: Catalog<typeof source> = {
  codes: {
    UNAUTHENTICATED: 'انتهت جلستك. سجّل الدخول مرة أخرى.',
    FORBIDDEN: 'ليست لديك صلاحية الوصول إلى هذا.',
    NOT_FOUND: 'هذا العنصر غير موجود أو تم حذفه.',
    VALIDATION_FAILED: 'بعض البيانات ناقصة أو غير صالحة.',
    CONFLICT: 'تغيّر هذا في هذه الأثناء. حدّث الصفحة وحاول مرة أخرى.',
    RATE_LIMITED: 'طلبات كثيرة جدًا. انتظر قليلًا وحاول مرة أخرى.',
    IDEMPOTENCY_MISMATCH: 'أُرسل هذا الطلب سابقًا ببيانات مختلفة. ابدأه من جديد.',
    INVALID_STATE: 'لا يمكن تنفيذ هذا في الحالة الحالية.',
    APPROVAL_EXPIRED: 'انتهت صلاحية طلب الموافقة هذا.',
    APPROVAL_MISMATCH: 'تغيّر الإجراء بعد عرضه. راجعه مرة أخرى.',
    CONNECTION_REQUIRED: 'يتطلب هذا اتصالًا لم يُعدّ بعد.',
    CONNECTION_FAILED: 'تعذّر على JARVIS الاتصال بهذه الإعدادات.',
    MODEL_NOT_CONFIGURED: 'يتطلب هذا نموذج ذكاء اصطناعي، ولم يُعدّ أي نموذج.',
    MODEL_ERROR: 'أعاد نموذج الذكاء الاصطناعي خطأً. حاول مرة أخرى لاحقًا.',
    PLANNER_UNSUPPORTED: 'لا يستطيع JARVIS تخطيط هذا الطلب دون نموذج ذكاء اصطناعي.',
    POLICY_DENIED: 'لا تسمح إعداداتك أو سياسة الأمان بذلك.',
    BUDGET_EXCEEDED: 'ميزانية الذكاء الاصطناعي لهذا الشهر لا تكفي لذلك.',
    TOOL_FAILED: 'فشلت خطوة أثناء التنفيذ.',
    TOOL_TIMEOUT: 'استغرقت خطوة وقتًا طويلًا فأُوقفت.',
    OUTCOME_UNKNOWN: 'لا يستطيع JARVIS التأكد مما إذا كان هذا قد حدث. تحقّق قبل إعادة المحاولة.',
    VERIFICATION_FAILED: 'تعذّر على JARVIS التحقق من النتيجة.',
    FETCH_BLOCKED: 'عنوان الويب هذا غير مسموح به.',
    INTERNAL: 'حدث خطأ من جهتنا.',
  },
  network: 'تعذّر الوصول إلى JARVIS. تحقّق من اتصالك.',
  badResponse: 'أرسل JARVIS ردًا لا يفهمه هذا التطبيق. أعد تحميل الصفحة.',
  generic: 'حدث خطأ ما.',
  details: 'التفاصيل',
  requestId: 'معرّف الطلب',
};

export default errors;
