/**
 * What JARVIS says on a call, in the call's language (docs/architecture/phase-d.md §3.2,
 * docs/security/telephony.md §1): the approved script (bound into the phone.call input before
 * the approval, so its action hash covers the exact words) and the fixed lines of the dialog
 * engine (clarifications, refusals, transfer, opt-out, closings) that every call may use.
 *
 * Rules of the wording:
 *  - the opening ALWAYS says first that this is JARVIS, an AI assistant, calling on behalf of
 *    the named user, why it calls, and that it takes notes of the call;
 *  - the callee is addressed formally (German "Sie", Arabic plural "لديكم"): they are a third
 *    party, usually a business; Arabic avoids gendered verbs for the user's name;
 *  - nothing is promised on the user's behalf (only an approved appointment is confirmed, by
 *    its own template in guard.ts / confirmationLine);
 *  - the user's own words (message, questions) are spoken verbatim.
 */
import type { CallPurpose, CallScript, Locale } from '@jarvis/contracts';

const LOCALE_TAG: Record<Locale, string> = { en: 'en-US', de: 'de-DE', ar: 'ar' };

/** "Friday, November 13" / "Freitag, 13. November" / "الجمعة، ١٣ نوفمبر". */
export function spokenDate(lang: Locale, isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat(LOCALE_TAG[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/** "9:30 AM" / "9:30 Uhr" / "٩:٣٠ ص" for an "HH:MM" local time. */
export function spokenTime(lang: Locale, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  const text = new Intl.DateTimeFormat(LOCALE_TAG[lang], {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(d);
  return lang === 'de' ? `${text} Uhr` : text;
}

export function spokenList(lang: Locale, items: readonly string[]): string {
  return new Intl.ListFormat(LOCALE_TAG[lang], { style: 'long', type: 'conjunction' }).format(
    items,
  );
}

export interface ScriptFacts {
  language: Locale;
  /** The account's display name: whom JARVIS calls for. */
  ownName: string;
  purpose: CallPurpose;
  date: string | null;
  window: { start: string; end: string } | null;
  message: string | null;
  questions: readonly string[];
  recording: 'off' | 'if_consented' | 'required';
  voicemail: 'hang_up' | 'leave_message';
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?؟。]$/.test(t) ? t : `${t}.`;
};

export function windowPhrase(lang: Locale, w: ScriptFacts['window']): string {
  if (!w) return '';
  const a = spokenTime(lang, w.start);
  const b = spokenTime(lang, w.end);
  return lang === 'en'
    ? ` between ${a} and ${b}`
    : lang === 'de'
      ? ` zwischen ${a} und ${b}`
      : ` بين ${a} و${b}`;
}

const T = {
  en: {
    hello: (n: string) => `Hello, this is JARVIS, an AI assistant calling on behalf of ${n}.`,
    notes: (n: string) => `I'll take notes of our call for ${n}.`,
    why: {
      message: (n: string) => `I'm calling to pass on a message from ${n}.`,
      availability: (n: string, d: string, w: string) =>
        `I'm calling to ask whether you have an appointment free on ${d}${w}.`,
      questions: (n: string, count: number) =>
        count === 1
          ? `I'm calling with a question from ${n}.`
          : `I'm calling with a few questions from ${n}.`,
      appointment: (n: string, d: string, w: string) =>
        `I'm calling to make an appointment for ${n} on ${d}${w}.`,
    },
    recording: (n: string) =>
      `May I record this call? The recording is for ${n} only. Please say yes or no.`,
    message: (n: string, m: string) => `${n} asked me to tell you: ${sentence(m)}`,
    replyQuestion: (n: string) => `Is there anything you would like me to pass on to ${n}?`,
    availabilityQuestion: (d: string, w: string) =>
      `Do you have an appointment free on ${d}${w}? Which times could you offer?`,
    appointmentQuestion: (n: string, d: string, w: string) =>
      `Which times on ${d}${w} could you offer ${n}?`,
    closing: (n: string) => `Thank you very much. I'll pass this on to ${n}. Goodbye.`,
    voicemail: {
      message: (n: string, m: string) => `${n} asked me to tell you: ${sentence(m)}`,
      availability: (d: string) =>
        `I was calling to ask whether you have an appointment free on ${d}.`,
      questions: (n: string) => `I was calling with a question from ${n}.`,
      appointment: (n: string) => `I was calling to make an appointment for ${n}.`,
    },
    voicemailEnd: (n: string) => `${n} will get back to you. Goodbye.`,
  },
  de: {
    hello: (n: string) =>
      `Guten Tag, hier ist JARVIS, ein KI-Assistent, der im Auftrag von ${n} anruft.`,
    notes: (n: string) => `Ich notiere unser Gespräch für ${n}.`,
    why: {
      message: (n: string) => `Ich rufe an, um Ihnen eine Nachricht von ${n} auszurichten.`,
      availability: (_n: string, d: string, w: string) =>
        `Ich rufe an, um zu fragen, ob Sie am ${d}${w} einen Termin frei haben.`,
      questions: (n: string, count: number) =>
        count === 1
          ? `Ich rufe mit einer Frage von ${n} an.`
          : `Ich rufe mit einigen Fragen von ${n} an.`,
      appointment: (n: string, d: string, w: string) =>
        `Ich rufe an, um für ${n} einen Termin am ${d}${w} zu vereinbaren.`,
    },
    recording: (n: string) =>
      `Darf ich dieses Gespräch aufzeichnen? Die Aufnahme ist nur für ${n} bestimmt. Bitte sagen Sie Ja oder Nein.`,
    message: (n: string, m: string) =>
      /^dass\s/i.test(m.trim())
        ? `${n} lässt Ihnen ausrichten, ${sentence(m)}`
        : `${n} bittet mich, Ihnen Folgendes auszurichten: ${sentence(m)}`,
    replyQuestion: (n: string) => `Möchten Sie, dass ich ${n} etwas ausrichte?`,
    availabilityQuestion: (d: string, w: string) =>
      `Haben Sie am ${d}${w} einen Termin frei? Welche Uhrzeiten könnten Sie anbieten?`,
    appointmentQuestion: (n: string, d: string, w: string) =>
      `Welche Uhrzeiten am ${d}${w} könnten Sie ${n} anbieten?`,
    closing: (n: string) => `Vielen Dank. Ich gebe das an ${n} weiter. Auf Wiederhören.`,
    voicemail: {
      message: (n: string, m: string) =>
        /^dass\s/i.test(m.trim())
          ? `${n} lässt Ihnen ausrichten, ${sentence(m)}`
          : `${n} bittet mich, Ihnen Folgendes auszurichten: ${sentence(m)}`,
      availability: (d: string) => `Ich wollte fragen, ob Sie am ${d} einen Termin frei haben.`,
      questions: (n: string) => `Ich wollte Ihnen eine Frage von ${n} stellen.`,
      appointment: (n: string) => `Ich wollte einen Termin für ${n} vereinbaren.`,
    },
    voicemailEnd: (n: string) => `${n} meldet sich bei Ihnen. Auf Wiederhören.`,
  },
  ar: {
    hello: (n: string) => `مرحبًا، معكم JARVIS، مساعد ذكي يتصل نيابةً عن ${n}.`,
    notes: (n: string) => `سأدوّن ملاحظات عن مكالمتنا من أجل ${n}.`,
    why: {
      message: (n: string) => `أتصل لأبلغكم رسالة من ${n}.`,
      availability: (_n: string, d: string, w: string) =>
        `أتصل لأسأل إن كان لديكم موعد متاح يوم ${d}${w}.`,
      questions: (n: string, count: number) =>
        count === 1 ? `أتصل لأطرح عليكم سؤالًا من ${n}.` : `أتصل لأطرح عليكم بعض الأسئلة من ${n}.`,
      appointment: (n: string, d: string, w: string) => `أتصل لحجز موعد لـ${n} يوم ${d}${w}.`,
    },
    recording: (n: string) =>
      `هل تسمحون لي بتسجيل هذه المكالمة؟ التسجيل مخصص لـ${n} فقط. من فضلكم قولوا نعم أو لا.`,
    message: (n: string, m: string) => `هذه رسالة من ${n}: ${sentence(m)}`,
    replyQuestion: (n: string) => `هل تودون أن أبلغ ${n} بشيء؟`,
    availabilityQuestion: (d: string, w: string) =>
      `هل لديكم موعد متاح يوم ${d}${w}؟ ما الأوقات التي يمكنكم اقتراحها؟`,
    appointmentQuestion: (n: string, d: string, w: string) =>
      `ما الأوقات المتاحة يوم ${d}${w} التي يمكنكم اقتراحها لـ${n}؟`,
    closing: (n: string) => `شكرًا جزيلًا. سأبلغ ${n} بذلك. مع السلامة.`,
    voicemail: {
      message: (n: string, m: string) => `هذه رسالة من ${n}: ${sentence(m)}`,
      availability: (d: string) => `كنت أتصل لأسأل إن كان لديكم موعد متاح يوم ${d}.`,
      questions: (n: string) => `كنت أتصل لأطرح عليكم سؤالًا من ${n}.`,
      appointment: (n: string) => `كنت أتصل لحجز موعد لـ${n}.`,
    },
    voicemailEnd: (n: string) => `سأطلب من ${n} التواصل معكم. مع السلامة.`,
  },
} as const;

/** The script of a call: deterministic in its facts (the same facts → the same words). */
export function buildScript(f: ScriptFacts): CallScript {
  const t = T[f.language];
  const n = f.ownName;
  const d = f.date ? spokenDate(f.language, f.date) : '';
  const w = windowPhrase(f.language, f.window);
  const why =
    f.purpose === 'message'
      ? t.why.message(n)
      : f.purpose === 'availability'
        ? t.why.availability(n, d, w)
        : f.purpose === 'questions'
          ? t.why.questions(n, f.questions.length)
          : t.why.appointment(n, d, w);
  const questions =
    f.purpose === 'message'
      ? [t.replyQuestion(n)]
      : f.purpose === 'availability'
        ? [t.availabilityQuestion(d, w)]
        : f.purpose === 'appointment'
          ? [t.appointmentQuestion(n, d, w)]
          : f.questions.map((q) => q.trim());
  const vm =
    f.purpose === 'message'
      ? t.voicemail.message(n, f.message ?? '')
      : f.purpose === 'availability'
        ? t.voicemail.availability(d)
        : f.purpose === 'questions'
          ? t.voicemail.questions(n)
          : t.voicemail.appointment(n);
  return {
    opening: `${t.hello(n)} ${why} ${t.notes(n)}`,
    recordingQuestion: f.recording === 'off' ? null : t.recording(n),
    message: f.purpose === 'message' && f.message ? t.message(n, f.message) : null,
    questions,
    closing: t.closing(n),
    voicemailMessage:
      f.voicemail === 'leave_message' ? `${t.hello(n)} ${vm} ${t.voicemailEnd(n)}` : null,
  };
}

/* ------------------------------------------------------------------ */
/* Fixed lines of the dialog engine (approved with every call)         */
/* ------------------------------------------------------------------ */

const quote = (lang: Locale, s: string) => {
  const text = s.length > 120 ? `${s.slice(0, 119).trimEnd()}…` : s;
  return lang === 'de' ? `„${text}“` : lang === 'ar' ? `«${text}»` : `“${text}”`;
};

export const LINES = {
  en: {
    reDisclose: (n: string) =>
      `I'm JARVIS, an AI assistant, not a person, calling on behalf of ${n}.`,
    silence: () => `Sorry, I didn't hear anything.`,
    lowConfidence: (heard: string) =>
      `Sorry, I'm not sure I understood. Did you say ${quote('en', heard)}?`,
    notUnderstood: () => `Sorry, I didn't quite understand.`,
    outsidePurpose: () => `I'm sorry, I can't help with that or share anything else on this call.`,
    share: (label: string, value: string) => `${label}: ${sentence(value)}`,
    unknownAnswer: (n: string) =>
      `I'm sorry, I don't know that. I'll pass your question on to ${n}.`,
    transferring: (n: string) => `One moment, I'll put you through to ${n}.`,
    transferUnavailable: (n: string) =>
      `I can't put you through right now, but I'll ask ${n} to call you back.`,
    transferFailed: (n: string) => `I couldn't reach ${n}. I'll ask for a call back.`,
    optOut: () =>
      `I understand. I'm sorry for the disturbance, and this number won't be called again. Goodbye.`,
    consentAccepted: () => `Thank you. The call is now being recorded.`,
    consentDeclined: () => `No problem, I won't record this call.`,
    consentRequiredEnd: (n: string) =>
      `No problem. I was asked to record this call, so I'll end it here and let ${n} know. Goodbye.`,
    ack: () => `Thank you.`,
    followUpTimes: (d: string) => `Which times could you offer on ${d}?`,
    windowFollowUp: (d: string, w: string) => `Is there anything free on ${d}${w}?`,
    readback: (times: string, d: string) => `Thank you. I've noted ${times} on ${d}.`,
    noTimes: (d: string) => `Thank you, I've noted that nothing is free on ${d}.`,
    silenceEnd: () => `I can't hear you, so I'll end the call now. Goodbye.`,
    unclearEnd: () => `I'm sorry, the line isn't clear enough, so I'll end the call now. Goodbye.`,
    durationEnd: (n: string) =>
      `I'm afraid our time is up. Thank you very much, I'll pass on what we discussed to ${n}. Goodbye.`,
    cancelled: () => `I'm sorry, I have to end the call now. Goodbye.`,
    confirmation: (n: string, d: string, time: string) =>
      `Then the appointment for ${n} is on ${d} at ${time}. Thank you.`,
  },
  de: {
    reDisclose: (n: string) =>
      `Ich bin JARVIS, ein KI-Assistent und kein Mensch, und rufe im Auftrag von ${n} an.`,
    silence: () => `Entschuldigung, ich habe nichts gehört.`,
    lowConfidence: (heard: string) =>
      `Entschuldigung, ich bin nicht sicher, ob ich Sie richtig verstanden habe. Haben Sie ${quote('de', heard)} gesagt?`,
    notUnderstood: () => `Entschuldigung, das habe ich nicht ganz verstanden.`,
    outsidePurpose: () =>
      `Das kann ich in diesem Gespräch leider nicht beantworten, und ich gebe auch nichts weiter darüber hinaus.`,
    share: (label: string, value: string) => `${label}: ${sentence(value)}`,
    unknownAnswer: (n: string) => `Das weiß ich leider nicht. Ich gebe Ihre Frage an ${n} weiter.`,
    transferring: (n: string) => `Einen Moment, ich verbinde Sie mit ${n}.`,
    transferUnavailable: (n: string) =>
      `Ich kann Sie gerade nicht verbinden, aber ich bitte ${n} um einen Rückruf.`,
    transferFailed: (n: string) =>
      `Ich konnte ${n} leider nicht erreichen und bitte um einen Rückruf.`,
    optOut: () =>
      `Verstanden. Entschuldigen Sie die Störung, diese Nummer wird nicht mehr angerufen. Auf Wiederhören.`,
    consentAccepted: () => `Danke. Das Gespräch wird jetzt aufgezeichnet.`,
    consentDeclined: () => `Kein Problem, ich zeichne das Gespräch nicht auf.`,
    consentRequiredEnd: (n: string) =>
      `Kein Problem. Ich wurde gebeten, das Gespräch aufzuzeichnen, deshalb beende ich es hier und gebe ${n} Bescheid. Auf Wiederhören.`,
    ack: () => `Danke.`,
    followUpTimes: (d: string) => `Welche Uhrzeiten könnten Sie am ${d} anbieten?`,
    windowFollowUp: (d: string, w: string) => `Ist am ${d}${w} etwas frei?`,
    readback: (times: string, d: string) => `Danke. Ich habe mir ${times} am ${d} notiert.`,
    noTimes: (d: string) => `Danke, ich habe notiert, dass am ${d} nichts frei ist.`,
    silenceEnd: () =>
      `Ich kann Sie leider nicht hören und beende das Gespräch jetzt. Auf Wiederhören.`,
    unclearEnd: () =>
      `Die Verbindung ist leider zu undeutlich, deshalb beende ich das Gespräch jetzt. Auf Wiederhören.`,
    durationEnd: (n: string) =>
      `Leider ist unsere Zeit um. Vielen Dank, ich gebe das Besprochene an ${n} weiter. Auf Wiederhören.`,
    cancelled: () => `Entschuldigung, ich muss das Gespräch jetzt beenden. Auf Wiederhören.`,
    confirmation: (n: string, d: string, time: string) =>
      `Dann ist der Termin für ${n} am ${d} um ${time}. Vielen Dank.`,
  },
  ar: {
    reDisclose: (n: string) => `أنا JARVIS، مساعد ذكي ولست إنسانًا، وأتصل نيابةً عن ${n}.`,
    silence: () => `عذرًا، لم أسمع شيئًا.`,
    lowConfidence: (heard: string) =>
      `عذرًا، لست متأكدًا من أنني فهمت. هل قلتم ${quote('ar', heard)}؟`,
    notUnderstood: () => `عذرًا، لم أفهم ذلك تمامًا.`,
    outsidePurpose: () => `عذرًا، لا يمكنني المساعدة في ذلك أو مشاركة أي شيء آخر في هذه المكالمة.`,
    share: (label: string, value: string) => `${label}: ${sentence(value)}`,
    unknownAnswer: (n: string) => `عذرًا، لا أعرف ذلك. سأنقل سؤالكم إلى ${n}.`,
    transferring: (n: string) => `لحظة من فضلكم، سأحوّلكم إلى ${n}.`,
    transferUnavailable: (n: string) =>
      `لا يمكنني تحويلكم الآن، لكنني سأطلب من ${n} معاودة الاتصال بكم.`,
    transferFailed: (n: string) => `تعذّر عليّ الوصول إلى ${n}، وسأطلب معاودة الاتصال بكم.`,
    optOut: () => `مفهوم. نعتذر عن الإزعاج، ولن يتم الاتصال بهذا الرقم مرة أخرى. مع السلامة.`,
    consentAccepted: () => `شكرًا. يتم الآن تسجيل المكالمة.`,
    consentDeclined: () => `لا مشكلة، لن أسجّل هذه المكالمة.`,
    consentRequiredEnd: (n: string) =>
      `لا مشكلة. طُلب مني تسجيل هذه المكالمة، لذا سأنهيها هنا وأبلغ ${n} بذلك. مع السلامة.`,
    ack: () => `شكرًا.`,
    followUpTimes: (d: string) => `ما الأوقات التي يمكنكم اقتراحها يوم ${d}؟`,
    windowFollowUp: (d: string, w: string) => `هل يوجد موعد متاح يوم ${d}${w}؟`,
    readback: (times: string, d: string) => `شكرًا. دوّنت ${times} يوم ${d}.`,
    noTimes: (d: string) => `شكرًا، دوّنت أنه لا يوجد موعد متاح يوم ${d}.`,
    silenceEnd: () => `لا أستطيع سماعكم، لذا سأنهي المكالمة الآن. مع السلامة.`,
    unclearEnd: () => `عذرًا، الاتصال غير واضح بما يكفي، لذا سأنهي المكالمة الآن. مع السلامة.`,
    durationEnd: (n: string) =>
      `للأسف انتهى الوقت المخصص للمكالمة. شكرًا جزيلًا، سأبلغ ${n} بما تحدثنا عنه. مع السلامة.`,
    cancelled: () => `عذرًا، عليّ إنهاء المكالمة الآن. مع السلامة.`,
    confirmation: (n: string, d: string, time: string) =>
      `إذن الموعد لـ${n} يوم ${d} الساعة ${time}. شكرًا لكم.`,
  },
} as const satisfies Record<Locale, Record<string, (...a: never[]) => string>>;

export type Lines = (typeof LINES)[Locale];

/** The appointment confirmation JARVIS says (the only commitment it ever makes; guard.ts). */
export function confirmationLine(
  lang: Locale,
  ownName: string,
  date: string,
  time: string,
): string {
  return LINES[lang].confirmation(ownName, spokenDate(lang, date), spokenTime(lang, time));
}

/**
 * What the account owner hears on a transfer, after answering and before the callee is put
 * through (<Number url> → twilioCallWhisper): who is on the line and why, in the owner's own
 * language (German "du" — JARVIS speaks to its user; Arabic MSA without gendered verbs). `who`
 * is the callee as the user named them, or the number; `goal` the approved goal as written.
 */
export function whisperLine(lang: Locale, who: string, goal: string): string {
  const g = sentence(goal.length > 160 ? `${goal.slice(0, 159).trimEnd()}…` : goal);
  switch (lang) {
    case 'de':
      return `Hier ist JARVIS, mit dem Anruf, um den du gebeten hast: ${who}. Die Person möchte mit dir sprechen. Es geht um: ${g} Ich verbinde dich jetzt.`;
    case 'ar':
      return `معك JARVIS بخصوص المكالمة التي طلبتها: ${who}. الطرف الآخر يطلب التحدث معك، والموضوع: ${g} جارٍ وصل المكالمة الآن.`;
    default:
      return `This is JARVIS, with the call you asked for: ${who}. They would like to speak with you. It is about: ${g} Connecting you now.`;
  }
}
