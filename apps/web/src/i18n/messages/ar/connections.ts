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
  oauth: {
    providers: {
      google: { summary: 'Gmail وتقويم Google.' },
      microsoft: { summary: 'بريد Outlook وتقويمه لحسابات Microsoft 365 وOutlook.com.' },
    },
    notConfigured: 'غير مُعَدّ على هذا الخادم',
    notConfiguredBody:
      'لم يُعِدّ مشغّل خادم JARVIS هذا تسجيل الدخول عبر {provider} بعد (يلزمه معرّف عميل وسرّ)، لذا لا يمكن ربط الحساب هنا.',
    chooseTitle: 'ما يُسمح لـ JARVIS بفعله',
    chooseHint:
      'اسمح بما تحتاج إليه فقط، ويمكنك إضافة المزيد لاحقًا. كل ما يكتب أو يرسل يبقى بانتظار موافقتك.',
    groups: { mail: 'البريد الإلكتروني', calendar: 'التقويم' },
    hints: {
      mailRead: 'البحث في رسائلك وقراءتها لتلخيصها ومعرفة ما يحتاج إلى رد.',
      mailCompose: 'حفظ مسودات الردود في صندوق بريدك. لا يُرسل أي شيء.',
      mailSend: 'إرسال الرسائل باسمك، في كل مرة بعد موافقتك على الرسالة نفسها.',
      calendarRead: 'الاطلاع على مواعيدك وأوقات فراغك.',
      calendarWrite:
        'إضافة المواعيد ونقلها وإلغاؤها وإرسال الدعوات، في كل مرة بعد موافقتك على التغيير.',
    },
    requiredBy: 'مُضمَّن لأن «{capability}» يحتاج إليه.',
    scopesToggle: 'الأذونات الدقيقة المطلوبة من {provider}',
    scopesGrantedToggle: 'الأذونات الدقيقة التي منحها {provider}',
    scopesIdentity: 'مُضمَّن دائمًا: معرّف حسابك وعنوانه، والبقاء متصلًا.',
    connect: 'المتابعة إلى {provider}',
    connectHint: 'تسجّل الدخول لدى {provider} وتؤكد هناك. لا يرى JARVIS كلمة مرورك أبدًا.',
    noneSelected: 'اختر شيئًا واحدًا على الأقل يُسمح لـ JARVIS بفعله.',
    account: 'الحساب',
    connected: 'رُبط {time}',
    lastChecked: 'آخر تحقق {time}',
    canDoTitle: 'ما يستطيع JARVIS فعله',
    pausedTitle: 'متوقف مؤقتًا إلى أن تعيد الربط',
    addTitle: 'السماح بالمزيد',
    addHint: 'لا يطلب JARVIS من {provider} إلا ما تختاره هنا.',
    add: 'السماح لدى {provider}',
    expired: {
      title: 'انتهت صلاحية اتصالك بـ {provider}',
      GRANT_INVALID:
        'لم يعد {provider} يقبل وصول JARVIS: فقد سُحب الإذن أو انتهت مدته. إلى أن تعيد الربط، لا يستطيع JARVIS قراءة أي شيء هناك أو تغييره.',
      TOKEN_REJECTED:
        'رفض {provider} وصول JARVIS. إلى أن تعيد الربط، لا يستطيع JARVIS قراءة أي شيء هناك أو تغييره.',
      generic: 'إلى أن تعيد الربط، لا يستطيع JARVIS قراءة أي شيء هناك أو تغييره.',
      reconnect: 'إعادة الربط',
      reconnectLabel: 'إعادة الربط لـ {provider}',
      asksFor: 'تطلب إعادة الربط الأذونات نفسها كما من قبل: {list}.',
    },
    scopeMissing: {
      title: 'سحب {provider} أحد الأذونات',
      body: 'يواصل JARVIS العمل بما لا يزال مسموحًا. اسمح بالباقي مجددًا أدناه إن احتجت إليه.',
    },
    error: {
      title: 'لا يستجيب {provider} بشكل موثوق',
      body: 'فشلت عدة طلبات متتالية. سيحاول JARVIS مجددًا مع الطلب التالي، وقد تفيد إعادة الربط إن تكرر ذلك.',
    },
    disconnect: 'قطع الاتصال',
    disconnectDialog: {
      title: 'قطع الاتصال بـ {provider}؟',
      body: 'لن يتمكن JARVIS بعد ذلك من قراءة أي شيء في {account} أو تغييره.',
      provider: 'يمحو JARVIS رموز الوصول فورًا ويطلب من {provider} سحب إذنه.',
      local_only:
        'يمحو JARVIS رموز الوصول فورًا. لا تتيح Microsoft للتطبيقات سحب إذنها بنفسها، لذا أزِل JARVIS من حسابك أيضًا:',
      localOnlyPersonal: 'الحسابات الشخصية',
      localOnlyWork: 'حسابات العمل أو الدراسة',
      watches: 'تتوقف مراقبة سلاسل الرسائل التي يتابع JARVIS الردود عليها في هذا الحساب.',
      confirm: 'قطع الاتصال ومحو الرموز',
    },
    disconnected: 'قُطع الاتصال بـ {provider} ومُحيت رموز الوصول.',
    revocation: {
      provider: 'يسحب قطع الاتصال إذن JARVIS لدى {provider}.',
      local_only: 'يمحو قطع الاتصال رموز JARVIS، ويمكنك أيضًا إزالة التطبيق لدى Microsoft.',
    },
  },
  callback: {
    title: 'ربط حساب',
    working: 'جارٍ إكمال الربط…',
    connectedTitle: 'رُبط {provider}',
    connectedBody: 'يستطيع JARVIS الآن استخدام {account} من أجل:',
    missing:
      'تُكمل هذه الصفحة ربط الحساب بعد تسجيل دخولك لدى Google أو Microsoft. ابدأ من صفحة الاتصالات.',
    failedTitle: 'لم يُربط أي شيء',
    back: 'العودة إلى الاتصالات',
    continue: 'متابعة',
    resumableTitle:
      '{count, plural, zero {لم تتوقف أي مهمة} one {توقفت مهمة واحدة لأن الاتصال كان منتهي الصلاحية} two {توقفت مهمتان لأن الاتصال كان منتهي الصلاحية} few {توقفت # مهام لأن الاتصال كان منتهي الصلاحية} many {توقفت # مهمة لأن الاتصال كان منتهي الصلاحية} other {توقفت # مهمة لأن الاتصال كان منتهي الصلاحية}}',
    resumableBody: 'عاد الاتصال للعمل، فيمكنك إعادة محاولتها الآن.',
    retry: 'إعادة المحاولة',
    retryLabel: 'إعادة المحاولة: «{title}»',
    retrying: 'جارٍ إعادة المحاولة…',
    retried: 'بدأت إعادة المحاولة',
    openTask: 'فتح المهمة',
  },
  status: {
    unconfigured: 'غير مُعَدّ',
    active: 'متصل',
    error: 'يحتاج إلى مراجعة',
    expired: 'منتهي الصلاحية',
    revoked: 'غير متصل',
    notConnected: 'غير متصل',
  },
};

export default connections;
