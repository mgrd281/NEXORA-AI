import type { Catalog } from '../../types';
import type source from '../en/voice';

const voice: Catalog<typeof source> = {
  title: 'طلب صوتي',
  stop: 'إيقاف الاستماع',
  resume: 'الاستماع مجددًا',
  send: 'إرسال',
  sendLabel: 'إرسال هذا الطلب',
  sending: 'جارٍ الإرسال…',
  cancel: 'إلغاء',
  typeInstead: 'الكتابة بدلًا من ذلك',
  tryAgain: 'إعادة المحاولة',
  transcriptLabel: 'ما سمعه JARVIS',
  transcriptEmpty: 'ابدأ الكلام — ستظهر كلماتك هنا.',
  language: 'لغة التعرّف على الكلام',
  languages: {
    enUS: 'English (US)',
    deDE: 'Deutsch (Deutschland)',
    arSA: 'العربية (السعودية)',
  },
  states: {
    requesting: 'اسمح بالوصول إلى الميكروفون لإملاء طلبك.',
    listening: 'يستمع…',
    paused: 'متوقف مؤقتًا. أرسل طلبك أو استمع مجددًا.',
    noSpeech: 'لم يُكتشف أي كلام.',
    noSpeechHelp: 'حاول مرة أخرى بالقرب من الميكروفون، أو اكتب طلبك.',
    denied: 'الوصول إلى الميكروفون محظور.',
    deniedHelp:
      'للإملاء، اسمح باستخدام الميكروفون لهذا الموقع من إعدادات الموقع في متصفحك، ثم حاول مرة أخرى.',
    unsupported: 'الإدخال الصوتي غير متاح في هذا المتصفح.',
    unsupportedHelp:
      'يمكنك كتابة طلبك بدلًا من ذلك. يعمل الإدخال الصوتي في الإصدارات الحديثة من Chrome وEdge وSafari.',
    noMicrophone: 'لم يُعثر على ميكروفون.',
    noMicrophoneHelp: 'وصّل ميكروفونًا وحاول مرة أخرى، أو اكتب طلبك.',
    error: 'تعذّر الوصول إلى خدمة التعرّف على الكلام في المتصفح.',
    errorHelp: 'تحقّق من الاتصال وحاول مرة أخرى، أو اكتب طلبك.',
    sending: 'جارٍ إرسال طلبك…',
  },
  privacy:
    'تحوّل خدمة التعرّف على الكلام في متصفحك الصوت إلى نص، وقد تعالج الصوت على خوادم الشركة المطوّرة للمتصفح. لا يتلقى JARVIS أي صوت.',
  spaceHint: 'اضغط مفتاح المسافة لإيقاف الاستماع أو استئنافه.',
};

export default voice;
