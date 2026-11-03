import type { Catalog } from '../../types';
import type source from '../en/auth';

const auth: Catalog<typeof source> = {
  title: 'تسجيل الدخول إلى JARVIS',
  email: 'البريد الإلكتروني',
  password: 'كلمة المرور',
  showPassword: 'إظهار كلمة المرور',
  hidePassword: 'إخفاء كلمة المرور',
  submit: 'تسجيل الدخول',
  submitting: 'جارٍ تسجيل الدخول…',
  inviteOnly: 'الحسابات متاحة بالدعوة فقط خلال مرحلة ألفا الخاصة.',
  sessionEnded: 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.',
  language: 'اللغة',
  errors: {
    invalidCredentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    rateLimited: 'محاولات كثيرة جدًا. حاول مرة أخرى بعد دقيقة.',
    offline: 'أنت غير متصل بالإنترنت. تحقّق من الاتصال وحاول مرة أخرى.',
    generic: 'حدث خطأ ما. حاول مرة أخرى.',
    emailRequired: 'أدخل بريدك الإلكتروني.',
    emailInvalid: 'أدخل بريدًا إلكترونيًا صالحًا.',
    passwordRequired: 'أدخل كلمة المرور.',
  },
};

export default auth;
