import type { Catalog } from '../../types';
import type source from '../en/connections';

const connections: Catalog<typeof source> = {
  title: 'الاتصالات',
  description: 'ما يستطيع JARVIS الوصول إليه نيابةً عنك. يمكنك سحب الإذن في أي وقت.',
  loading: 'جارٍ تحميل الاتصالات…',
  web: {
    title: 'الوصول إلى الويب',
    summary: 'يسمح بأن يقرأ JARVIS صفحات الويب العامة عندما يحتاج إليها طلب ما.',
    allowsTitle: 'ما يتيحه ذلك',
    allows: {
      read: 'يقرأ صفحات الويب العامة عبر http وhttps. القراءة فقط: لا يملأ نماذج ولا يسجّل الدخول ولا يشتري شيئًا.',
      privateNetworks:
        'لا يصل أبدًا إلى الشبكات الخاصة. عناوين localhost وشبكات المنزل والعمل والعناوين الداخلية للخدمات السحابية محظورة دائمًا.',
      noBrowser:
        'يجلب خادم JARVIS الصفحات بنفسه، دون متصفحك أو ملفات تعريف الارتباط أو كلمات المرور.',
    },
    enable: 'تفعيل الوصول إلى الويب',
    enabled: 'الوصول إلى الويب مفعّل.',
    disconnect: 'قطع الاتصال',
    disconnected: 'الوصول إلى الويب متوقف. لم يعد بإمكان JARVIS قراءة صفحات الويب.',
    since: 'فُعّل {time}',
  },
  email: {
    title: 'البريد الإلكتروني',
    summary: 'يسمح بأن يرسل JARVIS الرسائل من بريدك عبر SMTP.',
    setupHint:
      'أدخل إعدادات SMTP الخاصة بمزوّد بريدك. يسجّل JARVIS الدخول للتحقق منها قبل حفظ أي شيء.',
    sendsAs: 'يرسل باسم',
    lastVerified: 'آخر تحقق {time}',
    neverVerified: 'لم يُتحقق منه بعد',
    lastErrorTitle: 'فشل آخر تحقق',
    permissionsTitle: 'ما يستطيع JARVIS فعله',
    permissions: {
      send: 'إرسال الرسائل باسم {address}. تنتظر كل رسالة موافقتك، إلا إذا سمحت في الإعدادات بالرسائل المرسلة إليك.',
      noRead: 'لا يمكنه قراءة صندوق الوارد: بروتوكول SMTP للإرسال فقط.',
    },
    test: 'اختبار الاتصال',
    testOk: 'قبِل خادم البريد الاتصال.',
    testFailed: 'فشل اختبار الاتصال.',
    update: 'تغيير الإعدادات',
    cancelUpdate: 'الإبقاء على الإعدادات الحالية',
    disconnect: 'قطع الاتصال',
    disconnectDialog: {
      title: 'قطع اتصال البريد الإلكتروني؟',
      body: 'لن يتمكن JARVIS بعد ذلك من إرسال الرسائل باسم {address}.',
      erase: 'تُمحى كلمة المرور المحفوظة من الخادم فورًا. لإعادة الاتصال ستُدخلها مرة أخرى.',
      confirm: 'قطع الاتصال ومحو كلمة المرور',
    },
    disconnected: 'قُطع اتصال البريد الإلكتروني ومُحيت كلمة المرور المحفوظة.',
    connected: 'اتصل البريد الإلكتروني باسم {address}.',
    form: {
      title: 'إعدادات SMTP',
      label: 'الاسم',
      labelHint: 'الاسم الذي يظهر به صندوق البريد هذا في JARVIS.',
      host: 'خادم SMTP',
      hostPlaceholder: 'smtp.example.com',
      port: 'المنفذ',
      security: 'الأمان',
      securityOptions: {
        tls: 'TLS (المنفذ 465)',
        starttls: 'STARTTLS (المنفذ 587)',
        none: 'بلا تشفير (للتطوير المحلي فقط)',
      },
      securityHints: {
        tls: 'مشفّر من البداية. الخيار الموصى به.',
        starttls: 'يرقّي الاتصال إلى TLS قبل تسجيل الدخول.',
        none: 'غير مشفّر. لا يقبله الخادم إلا لخادم بريد على الجهاز نفسه أثناء التطوير.',
      },
      username: 'اسم المستخدم',
      usernameHint:
        'غالبًا عنوان بريدك الإلكتروني كاملًا. اتركه فارغًا إذا كان الخادم لا يتطلب تسجيل الدخول.',
      password: 'كلمة المرور',
      passwordHint:
        'يشترط كثير من المزوّدين كلمة مرور خاصة بالتطبيقات. تُحفظ مشفّرة ولا تُعرض مرة أخرى.',
      showPassword: 'إظهار كلمة المرور',
      hidePassword: 'إخفاء كلمة المرور',
      fromAddress: 'عنوان المرسل',
      fromName: 'اسم المرسل',
      fromNameHint: 'اختياري. يظهر للمستلمين بجانب العنوان.',
      submit: 'التحقق والاتصال',
      verifying: 'جارٍ تسجيل الدخول إلى {host}…',
      failedTitle: 'تعذّر على JARVIS الاتصال بهذه الإعدادات',
      errors: {
        label: 'أدخل اسمًا لصندوق البريد هذا.',
        host: 'أدخل اسم مضيف خادم SMTP.',
        port: 'أدخل منفذًا بين 1 و65535.',
        fromAddress: 'أدخل عنوان بريد إلكتروني صالحًا.',
      },
    },
  },
  status: {
    active: 'متصل',
    error: 'يحتاج إلى مراجعة',
    expired: 'منتهي الصلاحية',
    revoked: 'غير متصل',
    notConnected: 'غير متصل',
  },
};

export default connections;
