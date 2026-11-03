import type { Catalog } from '../../types';
import type source from '../en/composer';

const composer: Catalog<typeof source> = {
  label: 'اسأل JARVIS',
  placeholder: 'اطلب من JARVIS أن ينجز شيئًا…',
  send: 'إرسال الطلب',
  sending: 'جارٍ الإرسال…',
  voice: 'قل طلبك بصوتك',
  keyEnter: 'Enter',
  keyShift: 'Shift',
  hintSend: 'للإرسال',
  hintNewLine: 'لسطر جديد',
  tooLong:
    '{count, plural, zero {لا أحرف زائدة} one {حرف واحد زائد عن الحد} two {حرفان زائدان عن الحد} few {# أحرف زائدة عن الحد} many {# حرفًا زائدًا عن الحد} other {# حرف زائد عن الحد}}',
  characterCount: '{count} من {max} حرف',
  sent: 'أُرسل الطلب.',
  queued: 'أُرسل الطلب. JARVIS غير متاح حاليًا، لذا سينتظر الطلب في قائمة الانتظار.',
  offline: {
    title: 'المخطِّط دون اتصال',
    body: 'دون نموذج ذكاء اصطناعي، يفهم JARVIS هذه الطلبات:',
    summarize: 'لخّص <رابط> — أضف «وأرسله لي بالبريد» لتصلك النتيجة بالبريد',
    remember: 'تذكّر أن <شيء ما>',
    emailMe: 'أرسل لي: <نص>',
    needsWeb: 'يتطلب الوصول إلى الويب',
    needsEmail: 'يتطلب اتصالًا بالبريد الإلكتروني',
    memoryOff: 'الذاكرة متوقفة',
    settingsLink: 'إعدادات المساعد',
  },
};

export default composer;
