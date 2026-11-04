/**
 * Server-generated sentences.
 *
 * MESSAGES are sentences the server composes for the UI (offline plan and
 * step titles, approval summaries, result lines). They are stored and sent as
 * `{ key, params }` (contracts ServerMessage) so clients render them in the
 * viewer's locale; the text rendered here, in the request language, is the
 * stored fallback. CONTENT strings end up inside things JARVIS produces for
 * the user (the summary email), so they are always in the request language.
 *
 * Keep the German in "du" (see the product's address decision).
 */
import type {
  Locale,
  ServerMessage,
  ServerMessageKey,
  ServerMessageParam,
} from '@jarvis/contracts';

type Dict = Record<Locale, string>;

const MESSAGES = {
  // Offline plan titles
  'plan.summarize': {
    en: 'Summarize {host}',
    de: '{host} zusammenfassen',
    ar: 'تلخيص {host}',
  },
  'plan.summarizeEmail': {
    en: 'Summarize {host} and email it to you',
    de: '{host} zusammenfassen und dir mailen',
    ar: 'تلخيص {host} وإرساله إليك بالبريد',
  },
  'plan.remember': { en: 'Remember: {text}', de: 'Merken: {text}', ar: 'تذكّر: {text}' },
  'plan.emailSelf': {
    en: 'Email yourself: {text}',
    de: 'E-Mail an dich: {text}',
    ar: 'بريد إلى نفسك: {text}',
  },
  // Offline plan objectives
  'objective.summarize': {
    en: 'Read {url} and summarize it.',
    de: '{url} lesen und zusammenfassen.',
    ar: 'قراءة {url} وتلخيصها.',
  },
  'objective.summarizeEmail': {
    en: 'Read {url}, summarize it and email the summary to {email}.',
    de: '{url} lesen, zusammenfassen und die Zusammenfassung an {email} senden.',
    ar: 'قراءة {url} وتلخيصها وإرسال الملخص إلى {email}.',
  },
  'objective.remember': {
    en: 'Save a note to long-term memory.',
    de: 'Eine Notiz im Langzeitgedächtnis speichern.',
    ar: 'حفظ ملاحظة في الذاكرة طويلة المدى.',
  },
  'objective.emailSelf': {
    en: 'Send a note to {email}.',
    de: 'Eine Notiz an {email} senden.',
    ar: 'إرسال ملاحظة إلى {email}.',
  },
  // Offline step titles
  'step.fetch': { en: 'Read {host}', de: '{host} lesen', ar: 'قراءة {host}' },
  'step.summarize': {
    en: 'Summarize the page',
    de: 'Seite zusammenfassen',
    ar: 'تلخيص الصفحة',
  },
  'step.emailSummary': {
    en: 'Email the summary to you',
    de: 'Zusammenfassung an dich senden',
    ar: 'إرسال الملخص إليك',
  },
  'step.remember': {
    en: 'Save to memory',
    de: 'Im Gedächtnis speichern',
    ar: 'الحفظ في الذاكرة',
  },
  'step.emailNote': {
    en: 'Email the note to you',
    de: 'Notiz an dich senden',
    ar: 'إرسال الملاحظة إليك',
  },
  // Approval summaries
  'approval.email': {
    en: 'Send the email “{subject}” to {recipients}.',
    de: 'Die E-Mail „{subject}“ an {recipients} senden.',
    ar: 'إرسال البريد «{subject}» إلى {recipients}.',
  },
  'approval.generic': {
    en: 'Run “{title}” ({tool}).',
    de: '„{title}“ ausführen ({tool}).',
    ar: 'تنفيذ «{title}» ({tool}).',
  },
  'approval.recipientsMany': {
    en: '{count} recipients',
    de: '{count} Empfänger',
    ar: '{count} مستلمين',
  },
  // Result summaries
  'result.emailSent': {
    en: 'Sent “{subject}” to {recipients}.',
    de: '„{subject}“ an {recipients} gesendet.',
    ar: 'تم إرسال «{subject}» إلى {recipients}.',
  },
  'result.memorySaved': {
    en: 'Saved to memory: “{text}”.',
    de: 'Im Gedächtnis gespeichert: „{text}“.',
    ar: 'تم الحفظ في الذاكرة: «{text}».',
  },
  'result.declined': {
    en: 'You declined this action, so nothing was sent or changed: {action}',
    de: 'Du hast diese Aktion abgelehnt, daher wurde nichts gesendet oder geändert: {action}',
    ar: 'لقد رفضت هذا الإجراء، لذلك لم يتم إرسال أو تغيير أي شيء: {action}',
  },
  'result.cancelled': {
    en: 'Cancelled at your request.',
    de: 'Auf deinen Wunsch abgebrochen.',
    ar: 'تم الإلغاء بناءً على طلبك.',
  },
  'result.expired': {
    en: 'The approval request expired before you decided, so nothing was done.',
    de: 'Die Freigabeanfrage ist abgelaufen, bevor du entschieden hast; es wurde nichts ausgeführt.',
    ar: 'انتهت صلاحية طلب الموافقة قبل أن تقرر، لذلك لم يتم تنفيذ أي شيء.',
  },

  // Phase B — offline plan titles (follow-ups, documents, schedules, questions)
  'plan.emailResult': {
    en: 'Email “{title}” to you',
    de: '„{title}“ an dich mailen',
    ar: 'إرسال «{title}» إليك بالبريد',
  },
  'plan.rememberResult': {
    en: 'Remember the result of “{title}”',
    de: 'Ergebnis von „{title}“ merken',
    ar: 'تذكّر نتيجة «{title}»',
  },
  'plan.summarizeDocument': {
    en: 'Summarize {name}',
    de: '{name} zusammenfassen',
    ar: 'تلخيص {name}',
  },
  'plan.schedule': { en: 'Schedule: {title}', de: 'Zeitplan: {title}', ar: 'جدولة: {title}' },
  'plan.clarify': {
    en: 'Question about your request',
    de: 'Rückfrage zu deiner Anfrage',
    ar: 'سؤال حول طلبك',
  },
  'plan.forwardResult': {
    en: 'Send “{title}” to {recipients}',
    de: '„{title}“ an {recipients} senden',
    ar: 'إرسال «{title}» إلى {recipients}',
  },
  // Phase B — offline plan objectives
  'objective.emailResult': {
    en: 'Send the earlier result to {email}.',
    de: 'Das frühere Ergebnis an {email} senden.',
    ar: 'إرسال النتيجة السابقة إلى {email}.',
  },
  'objective.rememberResult': {
    en: 'Save the earlier result to long-term memory.',
    de: 'Das frühere Ergebnis im Langzeitgedächtnis speichern.',
    ar: 'حفظ النتيجة السابقة في الذاكرة طويلة المدى.',
  },
  'objective.summarizeDocument': {
    en: 'Read {name} and summarize it.',
    de: '{name} lesen und zusammenfassen.',
    ar: 'قراءة {name} وتلخيصه.',
  },
  'objective.schedule': {
    en: 'Create the schedule “{title}”.',
    de: 'Den Zeitplan „{title}“ anlegen.',
    ar: 'إنشاء الجدول «{title}».',
  },
  'objective.clarify': {
    en: 'Ask you for the information this request needs.',
    de: 'Dich nach den Angaben fragen, die für diese Anfrage fehlen.',
    ar: 'سؤالك عن المعلومات التي يحتاجها هذا الطلب.',
  },
  // Phase B — offline step titles
  'step.recall': {
    en: 'Get the earlier result',
    de: 'Früheres Ergebnis abrufen',
    ar: 'استرجاع النتيجة السابقة',
  },
  'step.emailResult': {
    en: 'Email it to you',
    de: 'An dich senden',
    ar: 'إرسالها إليك',
  },
  'step.summarizeDocument': {
    en: 'Summarize {name}',
    de: '{name} zusammenfassen',
    ar: 'تلخيص {name}',
  },
  'step.schedule': {
    en: 'Create the schedule',
    de: 'Zeitplan anlegen',
    ar: 'إنشاء الجدول',
  },
  'step.clarify': {
    en: 'Ask you for details',
    de: 'Bei dir nachfragen',
    ar: 'سؤالك عن التفاصيل',
  },
  'step.forwardResult': {
    en: 'Send it to {recipients}',
    de: 'An {recipients} senden',
    ar: 'إرسالها إلى {recipients}',
  },
  // Phase B — approval summaries
  'approval.schedule': {
    en: 'Create the schedule “{title}”.',
    de: 'Den Zeitplan „{title}“ anlegen.',
    ar: 'إنشاء الجدول «{title}».',
  },
  'approval.memory': {
    en: 'Save to memory: “{text}”.',
    de: 'Im Gedächtnis speichern: „{text}“.',
    ar: 'الحفظ في الذاكرة: «{text}».',
  },
  // Phase B — result lines
  'result.scheduleCreated': {
    en: 'Created the schedule “{title}”.',
    de: 'Zeitplan „{title}“ angelegt.',
    ar: 'تم إنشاء الجدول «{title}».',
  },
  'result.documentSummarized': {
    en: 'Summarized {name}.',
    de: '{name} zusammengefasst.',
    ar: 'تم تلخيص {name}.',
  },
  // Phase B — clarifying questions (assistant.clarify)
  'question.emailContent': {
    en: 'What should the email say?',
    de: 'Was soll in der E-Mail stehen?',
    ar: 'ماذا ينبغي أن تتضمن الرسالة؟',
  },
  'question.recipient': {
    en: 'Who should receive it? Write their email address.',
    de: 'Wer soll sie bekommen? Schreib die E-Mail-Adresse dazu.',
    ar: 'من ينبغي أن يستلمها؟ اكتب عنوان بريده الإلكتروني.',
  },
  'question.url': {
    en: 'Which page should I read? Paste its link.',
    de: 'Welche Seite soll ich lesen? Füge den Link ein.',
    ar: 'أي صفحة تريد أن أقرأها؟ الصق رابطها.',
  },
  'question.document': {
    en: 'Which document do you mean? Attach the file.',
    de: 'Welches Dokument meinst du? Hänge die Datei an.',
    ar: 'أي مستند تقصد؟ أرفق الملف.',
  },
  'question.scheduleTime': {
    en: 'When should this run? For example: every Monday at 9:00.',
    de: 'Wann soll das laufen? Zum Beispiel: jeden Montag um 9:00.',
    ar: 'متى ينبغي أن يتم ذلك؟ على سبيل المثال: كل يوم اثنين الساعة 9:00.',
  },
  'question.targetLanguage': {
    en: 'Which language should I translate it into?',
    de: 'In welche Sprache soll ich es übersetzen?',
    ar: 'إلى أي لغة تريد أن أترجمه؟',
  },
  'question.previousResult': {
    en: 'There is no earlier result in this conversation I could use. What should I send or save?',
    de: 'In diesem Gespräch gibt es noch kein Ergebnis, das ich verwenden kann. Was soll ich senden oder speichern?',
    ar: 'لا توجد نتيجة سابقة في هذه المحادثة يمكنني استخدامها. ماذا تريد أن أرسل أو أحفظ؟',
  },
  'question.details': {
    en: 'Can you tell me more about what you need?',
    de: 'Kannst du genauer sagen, was du brauchst?',
    ar: 'هل يمكنك أن توضح ما تحتاجه بمزيد من التفصيل؟',
  },
  // Phase C (docs/architecture/phase-c.md §6) — canonical wording; clients mirror it
  'plan.emailUnread': {
    en: 'Summarize your unread emails',
    de: 'Ungelesene E-Mails zusammenfassen',
    ar: 'تلخيص رسائلك غير المقروءة',
  },
  'plan.emailNeedsReply': {
    en: 'Find emails waiting for your reply',
    de: 'E-Mails finden, die auf deine Antwort warten',
    ar: 'العثور على الرسائل التي تنتظر ردك',
  },
  'plan.draftReply': {
    en: 'Draft a reply to {name}',
    de: 'Antwort an {name} entwerfen',
    ar: 'صياغة مسودة رد على {name}',
  },
  'plan.calendarUpcoming': {
    en: 'Check your upcoming events',
    de: 'Anstehende Termine ansehen',
    ar: 'الاطلاع على مواعيدك القادمة',
  },
  'plan.findMeetingTime': {
    en: 'Find a time to meet {who}',
    de: 'Einen Termin mit {who} finden',
    ar: 'إيجاد وقت للقاء {who}',
  },
  'plan.findSlots': {
    en: 'Find free appointments on {site}',
    de: 'Freie Termine auf {site} finden',
    ar: 'البحث عن مواعيد متاحة على {site}',
  },
  'plan.book': {
    en: 'Book {service} on {site}',
    de: '{service} auf {site} buchen',
    ar: 'حجز {service} على {site}',
  },
  'plan.compareProducts': {
    en: 'Compare offers for {query}',
    de: 'Angebote für {query} vergleichen',
    ar: 'مقارنة العروض لـ {query}',
  },
  'plan.buy': {
    en: 'Buy {product} on {site}',
    de: '{product} auf {site} kaufen',
    ar: 'شراء {product} من {site}',
  },
  'objective.emailUnread': {
    en: 'Read your unread emails and summarize them.',
    de: 'Deine ungelesenen E-Mails lesen und zusammenfassen.',
    ar: 'قراءة رسائلك غير المقروءة وتلخيصها.',
  },
  'objective.emailNeedsReply': {
    en: 'List the conversations whose newest message is waiting for your reply.',
    de: 'Die Unterhaltungen auflisten, deren neueste Nachricht auf deine Antwort wartet.',
    ar: 'عرض المحادثات التي تنتظر أحدث رسائلها ردك.',
  },
  'objective.draftReply': {
    en: 'Write a reply to {name} and save it as a draft — nothing is sent.',
    de: 'Eine Antwort an {name} schreiben und als Entwurf speichern – es wird nichts gesendet.',
    ar: 'كتابة رد على {name} وحفظه كمسودة — لن يُرسل شيء.',
  },
  'objective.calendarUpcoming': {
    en: 'Read the next events in your calendar.',
    de: 'Die nächsten Termine aus deinem Kalender lesen.',
    ar: 'قراءة الأحداث القادمة في تقويمك.',
  },
  'objective.findMeetingTime': {
    en: 'Find times when you and {who} are free.',
    de: 'Zeiten finden, zu denen du und {who} frei seid.',
    ar: 'إيجاد أوقات تكون فيها أنت و{who} متاحين.',
  },
  'objective.findSlots': {
    en: 'Read the free appointments {site} offers right now.',
    de: 'Die freien Termine lesen, die {site} gerade anbietet.',
    ar: 'قراءة المواعيد المتاحة التي يعرضها {site} الآن.',
  },
  'objective.book': {
    en: 'Book {service} on {site} once you approve, and keep the confirmation.',
    de: '{service} auf {site} buchen, sobald du zustimmst, und die Bestätigung aufbewahren.',
    ar: 'حجز {service} على {site} بعد موافقتك، والاحتفاظ بالتأكيد.',
  },
  'objective.compareProducts': {
    en: 'Compare prices, shipping and delivery times for {query} on the supported shops.',
    de: 'Preise, Versandkosten und Lieferzeiten für {query} in den unterstützten Shops vergleichen.',
    ar: 'مقارنة الأسعار وتكاليف الشحن ومدد التوصيل لـ {query} في المتاجر المدعومة.',
  },
  'objective.buy': {
    en: 'Order {product} on {site} once you approve the exact total.',
    de: '{product} auf {site} bestellen, sobald du den genauen Gesamtbetrag bestätigst.',
    ar: 'طلب {product} من {site} بعد موافقتك على المبلغ الإجمالي الدقيق.',
  },
  'step.searchEmail': {
    en: 'Search your mailbox',
    de: 'Postfach durchsuchen',
    ar: 'البحث في بريدك',
  },
  'step.readThreads': {
    en: 'Read the emails',
    de: 'E-Mails lesen',
    ar: 'قراءة الرسائل',
  },
  'step.summarizeEmail': {
    en: 'Summarize the emails',
    de: 'E-Mails zusammenfassen',
    ar: 'تلخيص الرسائل',
  },
  'step.draftReply': {
    en: 'Draft the reply to {name}',
    de: 'Antwort an {name} entwerfen',
    ar: 'صياغة مسودة الرد على {name}',
  },
  'step.trackReplies': {
    en: 'Watch for a reply',
    de: 'Auf eine Antwort achten',
    ar: 'متابعة وصول رد',
  },
  'step.listEvents': {
    en: 'Read your calendar',
    de: 'Kalender lesen',
    ar: 'قراءة تقويمك',
  },
  'step.freeBusy': {
    en: 'Find free times',
    de: 'Freie Zeiten finden',
    ar: 'إيجاد الأوقات المتاحة',
  },
  'step.createEvent': {
    en: 'Create “{title}”',
    de: '„{title}“ anlegen',
    ar: 'إنشاء «{title}»',
  },
  'step.updateEvent': {
    en: 'Change “{title}”',
    de: '„{title}“ ändern',
    ar: 'تعديل «{title}»',
  },
  'step.cancelEvent': {
    en: 'Cancel “{title}”',
    de: '„{title}“ absagen',
    ar: 'إلغاء «{title}»',
  },
  'step.saveToCalendar': {
    en: 'Add it to your calendar',
    de: 'In den Kalender eintragen',
    ar: 'إضافته إلى تقويمك',
  },
  'step.findSlots': {
    en: 'Read free appointments on {site}',
    de: 'Freie Termine auf {site} lesen',
    ar: 'قراءة المواعيد المتاحة على {site}',
  },
  'step.book': {
    en: 'Book on {site}',
    de: 'Auf {site} buchen',
    ar: 'الحجز على {site}',
  },
  'step.readSite': {
    en: 'Read {site}',
    de: '{site} lesen',
    ar: 'قراءة {site}',
  },
  'step.fillForm': {
    en: 'Fill in the form on {site}',
    de: 'Formular auf {site} ausfüllen',
    ar: 'ملء النموذج على {site}',
  },
  'step.searchShops': {
    en: 'Search shops for {query}',
    de: 'Shops nach {query} durchsuchen',
    ar: 'البحث في المتاجر عن {query}',
  },
  'step.compareOffers': {
    en: 'Compare the offers',
    de: 'Angebote vergleichen',
    ar: 'مقارنة العروض',
  },
  'step.prepareCart': {
    en: 'Fill the cart on {site}',
    de: 'Warenkorb auf {site} füllen',
    ar: 'تجهيز سلة التسوق على {site}',
  },
  'step.checkout': {
    en: 'Place the order on {site}',
    de: 'Bestellung auf {site} aufgeben',
    ar: 'تقديم الطلب على {site}',
  },
  'approval.emailDraft': {
    en: 'Save the draft “{subject}” to {recipients} — nothing is sent.',
    de: 'Den Entwurf „{subject}“ an {recipients} speichern – es wird nichts gesendet.',
    ar: 'حفظ المسودة «{subject}» إلى {recipients} — لن يُرسل شيء.',
  },
  'approval.eventCreate': {
    en: 'Add “{title}” to your calendar.',
    de: '„{title}“ in deinen Kalender eintragen.',
    ar: 'إضافة «{title}» إلى تقويمك.',
  },
  'approval.eventInvite': {
    en: 'Add “{title}” to your calendar and invite {recipients}.',
    de: '„{title}“ in deinen Kalender eintragen und {recipients} einladen.',
    ar: 'إضافة «{title}» إلى تقويمك ودعوة {recipients}.',
  },
  'approval.eventUpdate': {
    en: 'Change “{title}” in your calendar.',
    de: '„{title}“ in deinem Kalender ändern.',
    ar: 'تعديل «{title}» في تقويمك.',
  },
  'approval.eventCancel': {
    en: 'Cancel “{title}” in your calendar.',
    de: '„{title}“ in deinem Kalender absagen.',
    ar: 'إلغاء «{title}» من تقويمك.',
  },
  'approval.booking': {
    en: 'Book {service} on {site}.',
    de: '{service} auf {site} buchen.',
    ar: 'حجز {service} على {site}.',
  },
  'approval.formSubmission': {
    en: 'Submit the form on {site}.',
    de: 'Das Formular auf {site} absenden.',
    ar: 'إرسال النموذج على {site}.',
  },
  'approval.cart': {
    en: 'Put the items in a cart on {site} — nothing is bought.',
    de: 'Die Artikel auf {site} in den Warenkorb legen – es wird nichts gekauft.',
    ar: 'وضع المنتجات في سلة التسوق على {site} — لن يُشترى شيء.',
  },
  'approval.purchase': {
    en: 'Buy for {total} from {merchant}.',
    de: 'Für {total} bei {merchant} kaufen.',
    ar: 'الشراء بمبلغ {total} من {merchant}.',
  },
  'result.draftCreated': {
    en: 'Saved the draft “{subject}”.',
    de: 'Entwurf „{subject}“ gespeichert.',
    ar: 'تم حفظ المسودة «{subject}».',
  },
  'result.watchingReplies': {
    en: 'Watching “{subject}” for replies.',
    de: '„{subject}“ wird auf Antworten beobachtet.',
    ar: 'تتم متابعة الردود على «{subject}».',
  },
  'result.eventCreated': {
    en: 'Added “{title}” to your calendar.',
    de: '„{title}“ in deinen Kalender eingetragen.',
    ar: 'تمت إضافة «{title}» إلى تقويمك.',
  },
  'result.eventUpdated': {
    en: 'Changed “{title}” in your calendar.',
    de: '„{title}“ in deinem Kalender geändert.',
    ar: 'تم تعديل «{title}» في تقويمك.',
  },
  'result.eventCancelled': {
    en: 'Cancelled “{title}”.',
    de: '„{title}“ abgesagt.',
    ar: 'تم إلغاء «{title}».',
  },
  'result.booked': {
    en: 'Booked {service} on {site} (reference {reference}).',
    de: '{service} auf {site} gebucht (Referenz {reference}).',
    ar: 'تم حجز {service} على {site} (المرجع {reference}).',
  },
  'result.formSubmitted': {
    en: 'Submitted the form on {site}.',
    de: 'Formular auf {site} abgesendet.',
    ar: 'تم إرسال النموذج على {site}.',
  },
  'result.cartPrepared': {
    en: 'The cart on {site} is ready — nothing was bought.',
    de: 'Der Warenkorb auf {site} ist bereit – es wurde nichts gekauft.',
    ar: 'سلة التسوق على {site} جاهزة — لم يُشترَ شيء.',
  },
  'result.orderPlaced': {
    en: 'Ordered from {merchant} (order {orderId}).',
    de: 'Bei {merchant} bestellt (Bestellung {orderId}).',
    ar: 'تم الطلب من {merchant} (الطلب {orderId}).',
  },
  'question.dateTime': {
    en: 'When should it be? For example: Tuesday from 10:00 to 11:00.',
    de: 'Wann soll es sein? Zum Beispiel: Dienstag von 10:00 bis 11:00.',
    ar: 'متى ينبغي أن يكون؟ على سبيل المثال: الثلاثاء من 10:00 إلى 11:00.',
  },
  'question.contactDetails': {
    en: 'Which details should I give the site? For example your phone number.',
    de: 'Welche Angaben soll ich der Website geben? Zum Beispiel deine Telefonnummer.',
    ar: 'ما البيانات التي ينبغي أن أقدمها للموقع؟ على سبيل المثال رقم هاتفك.',
  },
  'question.product': {
    en: 'Which product do you mean? Name the model or paste its link.',
    de: 'Welches Produkt meinst du? Nenne das Modell oder füge den Link ein.',
    ar: 'أي منتج تقصد؟ اذكر الطراز أو الصق رابطه.',
  },
  'question.site': {
    en: 'Where should I look? Name one of the supported sites.',
    de: 'Wo soll ich nachsehen? Nenne eine der unterstützten Websites.',
    ar: 'أين ينبغي أن أبحث؟ اذكر أحد المواقع المدعومة.',
  },
  // Phase D — phone calls (docs/architecture/phase-d.md §6). {who}: the callee as the user
  // named them, else the number; {number}: E.164.
  'plan.call': {
    en: 'Call {who}',
    de: '{who} anrufen',
    ar: 'الاتصال هاتفيًا بـ{who}',
  },
  'objective.call': {
    en: 'Call {who} as your AI assistant and report what was said.',
    de: '{who} als KI-Assistent anrufen und berichten, was gesagt wurde.',
    ar: 'الاتصال بـ{who} بصفتي مساعدك الذكي ونقل ما قيل.',
  },
  'step.call': {
    en: 'Call {who}',
    de: '{who} anrufen',
    ar: 'الاتصال بـ{who}',
  },
  'approval.call': {
    en: 'Call {who} ({number}) and speak for you as an AI assistant.',
    de: '{who} ({number}) anrufen und als KI-Assistent für dich sprechen.',
    ar: 'الاتصال بـ{who} ({number}) والتحدث نيابةً عنك بصفتي مساعدًا ذكيًا.',
  },
  'result.callCompleted': {
    en: 'Called {who}; the call reached its goal.',
    de: '{who} angerufen – das Ziel des Anrufs wurde erreicht.',
    ar: 'تم الاتصال بـ{who} وتحقق هدف المكالمة.',
  },
  'result.callAnswered': {
    en: 'Called {who}; they answered, but the goal was not reached.',
    de: '{who} angerufen – der Anruf wurde angenommen, das Ziel aber nicht erreicht.',
    ar: 'تم الاتصال بـ{who} وجرى الرد، لكن الهدف لم يتحقق.',
  },
  'result.callTransferred': {
    en: 'Called {who} and put them through to you.',
    de: '{who} angerufen und zu dir durchgestellt.',
    ar: 'تم الاتصال بـ{who} وتحويل المكالمة إليك.',
  },
  'question.phoneNumber': {
    en: 'Which number should I call? Write it with the country code, for example +49 30 1234567.',
    de: 'Welche Nummer soll ich anrufen? Schreib sie mit Ländervorwahl, zum Beispiel +49 30 1234567.',
    ar: 'بأي رقم ينبغي أن أتصل؟ اكتبه مع رمز الدولة، على سبيل المثال +49 30 1234567.',
  },
  'question.callGoal': {
    en: 'What should I say or ask on the call?',
    de: 'Was soll ich am Telefon sagen oder fragen?',
    ar: 'ماذا ينبغي أن أقول أو أسأل في المكالمة؟',
  },
} satisfies Record<ServerMessageKey, Dict>;

const CONTENT = {
  // Email content
  'email.summarySubject': {
    en: 'Summary: {title}',
    de: 'Zusammenfassung: {title}',
    ar: 'ملخص: {title}',
  },
  'email.source': { en: 'Source', de: 'Quelle', ar: 'المصدر' },
  'email.noteSubject': {
    en: 'Note from JARVIS',
    de: 'Notiz von JARVIS',
    ar: 'ملاحظة من JARVIS',
  },
  // Summary method notes (part of the summary email)
  'summary.extractiveNote': {
    en: 'Extractive summary: key sentences quoted from the page; no AI model was used.',
    de: 'Extraktive Zusammenfassung: wichtige Sätze aus der Seite zitiert; es wurde kein KI-Modell verwendet.',
    ar: 'ملخص استخلاصي: جمل رئيسية مقتبسة من الصفحة؛ لم يُستخدم أي نموذج ذكاء اصطناعي.',
  },
  'summary.modelNote': {
    en: 'Summarized by JARVIS with {model}.',
    de: 'Von JARVIS mit {model} zusammengefasst.',
    ar: 'لخّصه JARVIS باستخدام {model}.',
  },
  // Phase B: document analysis method notes (part of results and emails)
  'document.extractiveNote': {
    en: 'Extractive summary: key sentences quoted from the document; no AI model was used.',
    de: 'Extraktive Zusammenfassung: wichtige Sätze aus dem Dokument zitiert; es wurde kein KI-Modell verwendet.',
    ar: 'ملخص استخلاصي: جمل رئيسية مقتبسة من المستند؛ لم يُستخدم أي نموذج ذكاء اصطناعي.',
  },
  'document.modelNote': {
    en: 'Analyzed by JARVIS with {model}.',
    de: 'Von JARVIS mit {model} ausgewertet.',
    ar: 'حلّله JARVIS باستخدام {model}.',
  },
  'document.truncatedNote': {
    en: 'Only the first {chars} characters of the document were read.',
    de: 'Nur die ersten {chars} Zeichen des Dokuments wurden gelesen.',
    ar: 'تمت قراءة أول {chars} حرف من المستند فقط.',
  },
  // Phase B: emailing an earlier result (follow-ups)
  'email.resultSubject': {
    en: 'From JARVIS: {title}',
    de: 'Von JARVIS: {title}',
    ar: 'من JARVIS: {title}',
  },
} satisfies Record<string, Dict>;

const STRINGS: Record<MessageKey, Dict> = { ...MESSAGES, ...CONTENT };

export type ContentKey = keyof typeof CONTENT;
export type MessageKey = ServerMessageKey | ContentKey;

/** Exposed for the catalog test (every key in every locale, same placeholders). */
export const SERVER_STRINGS: Readonly<Record<MessageKey, Dict>> = STRINGS;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

export function t(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const dict: Dict = STRINGS[key];
  return fill(dict[locale] ?? dict.en, vars);
}

/** A server sentence as data: clients render it in the viewer's locale. */
export function msg(
  key: ServerMessageKey,
  params: Record<string, ServerMessageParam> = {},
): ServerMessage {
  return { key, params };
}

/** Renders a message (and nested messages in its params) in `locale`. */
export function render(locale: Locale, m: ServerMessage): string {
  const vars: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(m.params))
    vars[name] = typeof v === 'object' ? render(locale, v) : v;
  const dict: Dict = MESSAGES[m.key];
  return fill(dict[locale] ?? dict.en, vars);
}

/** "I prefer aisle seats." → "I prefer aisle seats" (for titles and quotes inside a sentence). */
export function withoutFinalStop(text: string): string {
  return text.replace(/(?<![.…])[.。]$/u, '');
}

/** Stored JSON → message (tolerates rows written before messages existed). */
export function asMessage(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { key?: unknown; params?: unknown };
  if (typeof v.key !== 'string' || !(v.key in MESSAGES)) return null;
  const params = v.params && typeof v.params === 'object' ? v.params : {};
  return { key: v.key as ServerMessageKey, params: params as ServerMessage['params'] };
}

export function asLocale(value: string | null | undefined, fallback: Locale = 'en'): Locale {
  return value === 'en' || value === 'de' || value === 'ar' ? value : fallback;
}
