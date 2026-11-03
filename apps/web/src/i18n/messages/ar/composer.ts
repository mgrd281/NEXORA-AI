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
    title: 'الوضع الأساسي',
    body: 'يعمل JARVIS دون نموذج ذكاء اصطناعي ويفهم هذه الطلبات.',
    summarize: 'تلخيص رابط',
    remember: 'تذكّر شيئًا',
    emailMe: 'إرسال بريد إلى نفسك',
    fills: 'يضع مثالًا لطلب في الحقل',
    templates: {
      summarize: 'لخّص {slot} وأرسله إليّ بالبريد',
      remember: 'تذكّر أن {slot}',
      emailMe: 'أرسل لي: {slot}',
    },
    slots: {
      link: 'الرابط',
      something: 'شيئًا ما',
      text: 'النص',
    },
    needsWeb: 'يتطلب الوصول إلى الويب',
    needsEmail: 'يتطلب اتصالًا بالبريد الإلكتروني',
    memoryOff: 'الذاكرة متوقفة',
    settingsLink: 'عن الوضع الأساسي',
  },
};

export default composer;
