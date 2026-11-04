/**
 * Phase C fixtures (docs/architecture/phase-c.md): connection providers, Google / Microsoft
 * connections, Home "Upcoming", reply watches, orders, bookings, browser sessions with their
 * evidence files, and the tasks and approvals of the email, calendar, booking and shopping
 * agents — the shapes the real API sends (step outputs are the tools' current outputPreview),
 * validated against the contracts when the mock loads them. Test code only.
 *
 *   basePhaseC(f, now)                    what every fixture account has (no Phase C data;
 *                                         Google configured, Microsoft not configured)
 *   withPhaseC(f, locale, now, options)   connected accounts, upcoming events, orders,
 *                                         bookings, watches and the Phase C tasks below
 *
 * Evidence screenshots in ./evidence/*.png were captured from the local fixture site
 * (scripts/fixture-site.mjs) at the browser agent's viewport (1280 × 900).
 */
import type {
  Approval,
  Booking,
  BrowserSession,
  CalendarEventSummary,
  Connection,
  ConnectionProviderInfo,
  EmailWatch,
  Evidence,
  EvidenceArtifact,
  Money,
  Order,
  ServerMessage,
  TaskDetail,
  TaskStep,
  TaskSummary,
  UpcomingEvents,
} from '@jarvis/contracts';
import { moneyParam, OAUTH_SCOPES } from '@jarvis/contracts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { msg, text, type FixtureLocale, type Fixtures } from './fixtures';
import { derivedId, offsetMinutes, summaryOf } from './phase-b';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ state */

export interface PhaseCState {
  providers: ConnectionProviderInfo[];
  emailWatches: EmailWatch[];
  orders: Order[];
  bookings: Booking[];
  evidenceArtifacts: EvidenceArtifact[];
  /** Artifact id → the file served for it (./evidence/<name>). */
  evidenceFiles: Record<string, string>;
}

/** GET /v1/connections/providers as the server builds it from OAUTH_SCOPES. */
export function providerInfo(
  provider: 'google' | 'microsoft',
  configured: boolean,
): ConnectionProviderInfo {
  const scopes = OAUTH_SCOPES[provider];
  return {
    provider,
    kind: 'oauth',
    configured,
    capabilities: (
      ['mail.read', 'mail.compose', 'mail.send', 'calendar.read', 'calendar.write'] as const
    ).map((capability) => ({ capability, scopes: [...scopes[capability]] })),
    identityScopes: [...scopes.identity],
    revocation: provider === 'google' ? 'provider' : 'local_only',
  };
}

const SMTP_INFO: ConnectionProviderInfo = {
  provider: 'smtp',
  kind: 'smtp',
  configured: true,
  capabilities: [],
  identityScopes: [],
  revocation: null,
};
const WEB_INFO: ConnectionProviderInfo = { ...SMTP_INFO, provider: 'web', kind: 'web' };

/** Every fixture account: Google can be connected, Microsoft is not set up on this server. */
export function basePhaseC(): PhaseCState {
  return {
    providers: [
      providerInfo('google', true),
      providerInfo('microsoft', false),
      SMTP_INFO,
      WEB_INFO,
    ],
    emailWatches: [],
    orders: [],
    bookings: [],
    evidenceArtifacts: [],
    evidenceFiles: {},
  };
}

/* ------------------------------------------------------------------ ids */

export const PC = {
  connGoogle: 'c0000001-0000-4000-8000-0000000000c1',
  connMicrosoft: 'c0000001-0000-4000-8000-0000000000c2',
  // tasks
  replies: 'cc000001-0000-4000-8000-000000000001',
  unread: 'cc000001-0000-4000-8000-000000000002',
  compare: 'cc000001-0000-4000-8000-000000000003',
  slots: 'cc000001-0000-4000-8000-000000000004',
  booked: 'cc000001-0000-4000-8000-000000000005',
  ordered: 'cc000001-0000-4000-8000-000000000006',
  buy: 'cc000001-0000-4000-8000-000000000007',
  meet: 'cc000001-0000-4000-8000-000000000008',
  book: 'cc000001-0000-4000-8000-000000000009',
  form: 'cc000001-0000-4000-8000-00000000000a',
  draft: 'cc000001-0000-4000-8000-00000000000b',
  expired: 'cc000001-0000-4000-8000-00000000000c',
  captcha: 'cc000001-0000-4000-8000-00000000000d',
  login: 'cc000001-0000-4000-8000-00000000000e',
  unsupported: 'cc000001-0000-4000-8000-00000000000f',
  denied: 'cc000001-0000-4000-8000-000000000010',
  overLimit: 'cc000001-0000-4000-8000-000000000011',
  unknown: 'cc000001-0000-4000-8000-000000000012',
  // approvals
  aPurchase: 'ca000001-0000-4000-8000-000000000001',
  aEvent: 'ca000001-0000-4000-8000-000000000002',
  aBooking: 'ca000001-0000-4000-8000-000000000003',
  aForm: 'ca000001-0000-4000-8000-000000000004',
  aDraft: 'ca000001-0000-4000-8000-000000000005',
  aBooked: 'ca000001-0000-4000-8000-000000000006',
  aOrdered: 'ca000001-0000-4000-8000-000000000007',
  // records
  orderPlaced: 'c0de0001-0000-4000-8000-000000000001',
  orderFailed: 'c0de0001-0000-4000-8000-000000000002',
  orderUnknown: 'c0de0001-0000-4000-8000-000000000003',
  booking: 'cb000001-0000-4000-8000-000000000001',
  watchOpen: 'ce000001-0000-4000-8000-000000000001',
  watchReplied: 'ce000001-0000-4000-8000-000000000002',
  watchExpired: 'ce000001-0000-4000-8000-000000000003',
  // browser sessions
  sShop: 'cd000001-0000-4000-8000-000000000001',
  sOutlet: 'cd000001-0000-4000-8000-000000000002',
  sSlots: 'cd000001-0000-4000-8000-000000000003',
  sBooked: 'cd000001-0000-4000-8000-000000000004',
  sCaptcha: 'cd000001-0000-4000-8000-000000000005',
  sLogin: 'cd000001-0000-4000-8000-000000000006',
  sCart: 'cd000001-0000-4000-8000-000000000007',
  sOrder: 'cd000001-0000-4000-8000-000000000008',
  // evidence files
  evShop: 'cf000001-0000-4000-8000-000000000001',
  evOutlet: 'cf000001-0000-4000-8000-000000000002',
  evSlots: 'cf000001-0000-4000-8000-000000000003',
  evConfirmation: 'cf000001-0000-4000-8000-000000000004',
  evIcs: 'cf000001-0000-4000-8000-000000000005',
  evCaptcha: 'cf000001-0000-4000-8000-000000000006',
  evCheckout: 'cf000001-0000-4000-8000-000000000007',
  evCart: 'cf000001-0000-4000-8000-000000000008',
  evForm: 'cf000001-0000-4000-8000-000000000009',
} as const;

/** The local fixture site the recipes use in development (BROWSER_FIXTURE_ORIGIN). */
export const FIXTURE_ORIGIN = 'http://127.0.0.1:4599';
export const FIXTURE_HOST = '127.0.0.1:4599';
const EMAIL = 'layla.haddad@example.com';
const OMAR = 'omar.said@example.com';
const SARA = 'sara.klein@example.com';

const EVIDENCE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'evidence');

/** The ICS file the fixture booking site sent for the reservation. */
export function icsFor(reference: string, startIso: string, endIso: string): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fixture Dental//Booking//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${reference}@fixture-dental.test`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(startIso)}`,
    `DTEND:${stamp(endIso)}`,
    'SUMMARY:Check-up at Fixture Dental',
    'LOCATION:Fixture Dental\\, 3 Molar Lane\\, 10117 Fixture City',
    `DESCRIPTION:Reference ${reference}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** The bytes the mock serves for an evidence file (PNG from ./evidence, or the ICS text). */
export function evidenceBytes(file: string): Buffer {
  if (file.startsWith('ics:')) return Buffer.from(file.slice(4), 'utf8');
  return readFileSync(path.join(EVIDENCE_DIR, file));
}

function artifact(
  id: string,
  file: string,
  kind: EvidenceArtifact['kind'],
  pageUrl: string | null,
  taskId: string | null,
  sessionId: string | null,
  createdAt: string,
): EvidenceArtifact {
  const bytes = evidenceBytes(file);
  return {
    id,
    kind,
    mediaType:
      kind === 'screenshot' ? 'image/png' : kind === 'ics' ? 'text/calendar' : 'application/json',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pageUrl,
    taskId,
    browserSessionId: sessionId,
    downloadPath: `/v1/evidence/${id}/content`,
    createdAt,
  };
}

/* ------------------------------------------------------------------ time */

/** The calendar date in `zone`, `plus` days from `at`. */
function dayIn(zone: string, at: number, plus: number): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at + plus * DAY));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The instant of a local wall-clock time in `zone` (DST-correct: offset of that instant). */
function zoned(zone: string, day: { y: number; m: number; d: number }, hh: number, mm = 0) {
  const guess = Date.UTC(day.y, day.m - 1, day.d, hh, mm);
  const first = guess - offsetMinutes(zone, guess) * MIN;
  return guess - offsetMinutes(zone, first) * MIN;
}

/** The next weekday (Mon–Fri) at least `minDays` ahead, in `zone`. */
function weekdayAhead(zone: string, now: number, minDays: number) {
  for (let plus = minDays; plus < minDays + 7; plus++) {
    const day = dayIn(zone, now, plus);
    const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return day;
  }
  return dayIn(zone, now, minDays);
}

const usd = (cents: number): Money => ({ amountMicro: cents * 10_000, currency: 'USD' });

/* ------------------------------------------------------------------ copy */

interface PhaseCCopy {
  repliesRequest: string;
  unreadRequest: string;
  compareRequest: string;
  compareQuery: string;
  slotsRequest: string;
  bookedRequest: string;
  orderedRequest: string;
  buyRequest: string;
  buyProduct: string;
  meetRequest: string;
  meetTitle: string;
  meetDescription: string;
  bookRequest: string;
  formRequest: string;
  formTitle: string;
  formMessage: string;
  draftRequest: string;
  draftBody: string;
  expiredRequest: string;
  captchaRequest: string;
  loginRequest: string;
  unsupportedRequest: string;
  deniedRequest: string;
  overLimitRequest: string;
  overLimitProduct: string;
  unknownRequest: string;
  unreadSummary: string;
  threads: Array<{ from: string; name: string; subject: string; snippet: string }>;
  events: {
    call: string;
    review: string;
    dentist: string;
    conference: string;
    sync: string;
    dinner: string;
    yoga: string;
    reviewRoom: string;
  };
  watchSubjects: [string, string, string];
}

const COPY: Record<FixtureLocale, PhaseCCopy> = {
  en: {
    repliesRequest: 'What needs my reply?',
    unreadRequest: 'Summarize my unread emails',
    compareRequest: 'Compare prices for FX-200 noise-cancelling headphones',
    compareQuery: 'FX-200 noise-cancelling headphones',
    slotsRequest: 'Find a check-up at Fixture Dental next week',
    bookedRequest: 'Book the check-up at Fixture Dental on the first free morning',
    orderedRequest: 'Buy the FX-10 earbuds on Fixture Shop',
    buyRequest: 'Buy the FX-200 headphones on Fixture Shop',
    buyProduct: 'FX-200 headphones',
    meetRequest:
      'Set up a project review with omar.said@example.com and sara.klein@example.com on Friday at 14:00',
    meetTitle: 'Project review',
    meetDescription: 'Agenda: Q4 milestones and the open budget questions.',
    bookRequest: 'Book a dental cleaning at Fixture Dental next week',
    formRequest: 'Ask Fixture Dental whether they offer evening appointments',
    formTitle: 'Ask Fixture Dental about evening appointments',
    formMessage:
      'Hello, do you offer appointments after 18:00 on weekdays? Thank you, Layla Haddad',
    draftRequest: 'Draft a reply to Omar saying Friday at 14:00 works for me',
    draftBody: 'Hi Omar,\n\nFriday at 14:00 works for me. See you then.\n\nBest,\nLayla',
    expiredRequest: 'What’s on my calendar this week?',
    captchaRequest: 'Read the returns policy on Fixture Outlet',
    loginRequest: 'Find a check-up at Fixture Dental on Saturday',
    unsupportedRequest: 'Read the menu on https://www.trattoria-roma.example/menu',
    deniedRequest: 'Buy the FX-200 headphones on Fixture Shop',
    overLimitRequest: 'Buy the FX Book 14 laptop on Fixture Shop',
    overLimitProduct: 'FX Book 14 laptop',
    unknownRequest: 'Buy the FX-10 earbuds on Fixture Shop',
    unreadSummary: [
      'Omar Said asks whether Friday at 14:00 works for the project review and needs an answer by Thursday.',
      'Kitchen Works sent the revised offer for the kitchen renovation: €18,400, valid until 20 November.',
      'The school reminds parents that the trip form must be signed and returned by Wednesday.',
    ].join('\n'),
    threads: [
      {
        from: OMAR,
        name: 'Omar Said',
        subject: 'Project review next week',
        snippet: 'Hi Layla, would Friday at 14:00 work for you? I’d like to go through the Q4 …',
      },
      {
        from: 'offers@kitchenworks.example',
        name: 'Kitchen Works',
        subject: 'Revised offer for your kitchen',
        snippet: 'Please find attached the revised offer. Let us know if you would like to …',
      },
      {
        from: 'office@riverside-school.example',
        name: 'Riverside School',
        subject: 'Class trip: signed form needed',
        snippet: 'Dear parents, please sign the attached form and return it by Wednesday …',
      },
    ],
    events: {
      call: 'Call with Omar',
      review: 'Quarterly planning',
      dentist: 'Check-up at Fixture Dental',
      conference: 'Digital Health Summit',
      sync: 'Weekly sync with the New York team',
      dinner: 'Dinner with Sara',
      yoga: 'Yoga class',
      reviewRoom: 'Room 4.12',
    },
    watchSubjects: [
      'Re: Project review next week',
      'Revised offer for your kitchen',
      'Re: Invoice 2026-118',
    ],
  },
  de: {
    repliesRequest: 'Worauf muss ich antworten?',
    unreadRequest: 'Fasse meine ungelesenen E-Mails zusammen',
    compareRequest: 'Vergleiche Preise für FX-200 Kopfhörer mit Geräuschunterdrückung',
    compareQuery: 'FX-200 Kopfhörer mit Geräuschunterdrückung',
    slotsRequest: 'Finde nächste Woche einen Kontrolltermin bei Fixture Dental',
    bookedRequest: 'Buche den Kontrolltermin bei Fixture Dental am ersten freien Vormittag',
    orderedRequest: 'Kauf die FX-10 Ohrhörer bei Fixture Shop',
    buyRequest: 'Kauf die FX-200 Kopfhörer bei Fixture Shop',
    buyProduct: 'FX-200 Kopfhörer',
    meetRequest:
      'Leg ein Projekt-Review mit omar.said@example.com und sara.klein@example.com am Freitag um 14:00 an',
    meetTitle: 'Projekt-Review',
    meetDescription: 'Agenda: Meilensteine für Q4 und die offenen Budgetfragen.',
    bookRequest: 'Buche nächste Woche eine Zahnreinigung bei Fixture Dental',
    formRequest: 'Frag Fixture Dental, ob es Abendtermine gibt',
    formTitle: 'Fixture Dental nach Abendterminen fragen',
    formMessage:
      'Guten Tag, bieten Sie werktags Termine nach 18:00 Uhr an? Vielen Dank, Layla Haddad',
    draftRequest: 'Entwirf eine Antwort an Omar: Freitag um 14:00 passt mir',
    draftBody: 'Hallo Omar,\n\nFreitag um 14:00 passt mir. Bis dann!\n\nViele Grüße\nLayla',
    expiredRequest: 'Was steht diese Woche in meinem Kalender?',
    captchaRequest: 'Lies die Rückgaberegeln bei Fixture Outlet',
    loginRequest: 'Finde am Samstag einen Kontrolltermin bei Fixture Dental',
    unsupportedRequest: 'Lies die Speisekarte auf https://www.trattoria-roma.example/menu',
    deniedRequest: 'Kauf die FX-200 Kopfhörer bei Fixture Shop',
    overLimitRequest: 'Kauf den FX Book 14 Laptop bei Fixture Shop',
    overLimitProduct: 'FX Book 14 Laptop',
    unknownRequest: 'Kauf die FX-10 Ohrhörer bei Fixture Shop',
    unreadSummary: [
      'Omar Said fragt, ob Freitag um 14:00 für das Projekt-Review passt, und braucht bis Donnerstag eine Antwort.',
      'Küchenwerk hat das überarbeitete Angebot für die Küchenrenovierung geschickt: 18.400 €, gültig bis 20. November.',
      'Die Schule erinnert daran, das unterschriebene Formular für den Ausflug bis Mittwoch abzugeben.',
    ].join('\n'),
    threads: [
      {
        from: OMAR,
        name: 'Omar Said',
        subject: 'Projekt-Review nächste Woche',
        snippet: 'Hallo Layla, passt dir Freitag um 14:00? Ich würde gern die Q4-Planung …',
      },
      {
        from: 'angebote@kuechenwerk.example',
        name: 'Küchenwerk',
        subject: 'Überarbeitetes Angebot für deine Küche',
        snippet: 'Anbei das überarbeitete Angebot. Melde dich gern, wenn du …',
      },
      {
        from: 'sekretariat@grundschule-am-fluss.example',
        name: 'Grundschule am Fluss',
        subject: 'Klassenausflug: unterschriebenes Formular nötig',
        snippet: 'Liebe Eltern, bitte unterschreibt das Formular und gebt es bis Mittwoch …',
      },
    ],
    events: {
      call: 'Telefonat mit Omar',
      review: 'Quartalsplanung',
      dentist: 'Kontrolltermin bei Fixture Dental',
      conference: 'Digital Health Summit',
      sync: 'Wöchentlicher Abgleich mit dem Team in New York',
      dinner: 'Abendessen mit Sara',
      yoga: 'Yogakurs',
      reviewRoom: 'Raum 4.12',
    },
    watchSubjects: [
      'Re: Projekt-Review nächste Woche',
      'Überarbeitetes Angebot für deine Küche',
      'Re: Rechnung 2026-118',
    ],
  },
  ar: {
    repliesRequest: 'ما الذي يحتاج إلى ردي؟',
    unreadRequest: 'لخص رسائلي غير المقروءة',
    compareRequest: 'قارن أسعار سماعات FX-200 العازلة للضوضاء',
    compareQuery: 'سماعات FX-200 العازلة للضوضاء',
    slotsRequest: 'ابحث عن موعد فحص لدى Fixture Dental الأسبوع القادم',
    bookedRequest: 'احجز الفحص لدى Fixture Dental في أول صباح متاح',
    orderedRequest: 'اشترِ سماعات الأذن FX-10 من Fixture Shop',
    buyRequest: 'اشترِ سماعات FX-200 من Fixture Shop',
    buyProduct: 'سماعات FX-200',
    meetRequest:
      'رتّب مراجعة المشروع مع omar.said@example.com وsara.klein@example.com يوم الجمعة الساعة 14:00',
    meetTitle: 'مراجعة المشروع',
    meetDescription: 'جدول الأعمال: مراحل الربع الرابع وأسئلة الميزانية المفتوحة.',
    bookRequest: 'احجز تنظيف أسنان لدى Fixture Dental الأسبوع القادم',
    formRequest: 'اسأل Fixture Dental إن كانت تقدّم مواعيد مسائية',
    formTitle: 'سؤال Fixture Dental عن المواعيد المسائية',
    formMessage: 'مرحبًا، هل لديكم مواعيد بعد الساعة 18:00 في أيام الأسبوع؟ شكرًا، ليلى حداد',
    draftRequest: 'اكتب مسودة رد على عمر: يناسبني يوم الجمعة الساعة 14:00',
    draftBody: 'مرحبًا عمر،\n\nيناسبني يوم الجمعة الساعة 14:00. أراك حينها.\n\nمع التحية،\nليلى',
    expiredRequest: 'ما الذي في تقويمي هذا الأسبوع؟',
    captchaRequest: 'اقرأ سياسة الإرجاع لدى Fixture Outlet',
    loginRequest: 'ابحث عن موعد فحص لدى Fixture Dental يوم السبت',
    unsupportedRequest: 'اقرأ قائمة الطعام في https://www.trattoria-roma.example/menu',
    deniedRequest: 'اشترِ سماعات FX-200 من Fixture Shop',
    overLimitRequest: 'اشترِ الحاسوب FX Book 14 من Fixture Shop',
    overLimitProduct: 'الحاسوب FX Book 14',
    unknownRequest: 'اشترِ سماعات الأذن FX-10 من Fixture Shop',
    unreadSummary: [
      'يسأل عمر سعيد إن كان يوم الجمعة الساعة 14:00 يناسب مراجعة المشروع، ويحتاج إلى رد قبل الخميس.',
      'أرسلت شركة المطابخ العرض المعدّل لتجديد المطبخ: 18,400 يورو، صالح حتى 20 نوفمبر.',
      'تذكّر المدرسة بتوقيع نموذج الرحلة وإعادته قبل الأربعاء.',
    ].join('\n'),
    threads: [
      {
        from: OMAR,
        name: 'عمر سعيد',
        subject: 'مراجعة المشروع الأسبوع القادم',
        snippet: 'مرحبًا ليلى، هل يناسبك يوم الجمعة الساعة 14:00؟ أود مراجعة خطة الربع الرابع …',
      },
      {
        from: 'offers@kitchens.example',
        name: 'شركة المطابخ',
        subject: 'العرض المعدّل لمطبخك',
        snippet: 'تجدون مرفقًا العرض المعدّل. أخبرونا إن رغبتم في …',
      },
      {
        from: 'office@riverside-school.example',
        name: 'مدرسة النهر',
        subject: 'الرحلة المدرسية: النموذج الموقّع مطلوب',
        snippet: 'أولياء الأمور الكرام، يرجى توقيع النموذج المرفق وإعادته قبل الأربعاء …',
      },
    ],
    events: {
      call: 'مكالمة مع عمر',
      review: 'تخطيط الربع',
      dentist: 'فحص لدى Fixture Dental',
      conference: 'Digital Health Summit',
      sync: 'الاجتماع الأسبوعي مع فريق نيويورك',
      dinner: 'عشاء مع سارة',
      yoga: 'درس يوغا',
      reviewRoom: 'القاعة 4.12',
    },
    watchSubjects: [
      'رد: مراجعة المشروع الأسبوع القادم',
      'العرض المعدّل لمطبخك',
      'رد: الفاتورة 2026-118',
    ],
  },
};

/** Lines of the email.search result text as the tool writes them (request language). */
function searchText(locale: FixtureLocale, threads: PhaseCCopy['threads'], dates: string[]) {
  const head = {
    en: `${threads.length} conversation(s):`,
    de: `${threads.length} Unterhaltung(en):`,
    ar: `عدد المحادثات: ${threads.length}`,
  }[locale];
  return [
    head,
    ...threads.map(
      (t, i) => `${i + 1}. ${t.name} <${t.from}> — “${t.subject}” (${dates[i]}): ${t.snippet}`,
    ),
  ].join('\n');
}

/* ------------------------------------------------------------------ builder */

export interface PhaseCOptions {
  /** spending.monthlyPurchaseLimitUsd (default 200: the purchase approval is within it). */
  purchaseLimitUsd?: number;
}

/**
 * Connected accounts (Google active, Microsoft expired), Home "Upcoming" with a conflict and an
 * expired source, reply watches, orders, a booking, and the Phase C tasks and approvals.
 */
export function withPhaseC(
  f: Fixtures,
  locale: FixtureLocale,
  now: number,
  options: PhaseCOptions = {},
): Fixtures {
  const c = COPY[locale];
  const at = (offset: number) => new Date(now + offset).toISOString();
  const said = (m: ServerMessage) => ({ text: text(locale, m), message: m });
  const zone = f.me.timeZone;
  const limitUsd = options.purchaseLimitUsd ?? 200;

  /* ---- connections */
  const google: Connection = {
    id: PC.connGoogle,
    provider: 'google',
    label: 'Google',
    accountIdentifier: EMAIL,
    status: 'active',
    permissions: [],
    lastVerifiedAt: at(-14 * MIN),
    lastError: null,
    expiresAt: null,
    createdAt: at(-9 * DAY),
    capabilities: ['mail.read', 'mail.compose', 'mail.send', 'calendar.read', 'calendar.write'],
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    statusReason: null,
  };
  const microsoft: Connection = {
    id: PC.connMicrosoft,
    provider: 'microsoft',
    label: 'Microsoft',
    accountIdentifier: 'layla.haddad@contoso.example',
    status: 'expired',
    permissions: [],
    lastVerifiedAt: at(-3 * DAY),
    lastError: null,
    expiresAt: null,
    createdAt: at(-30 * DAY),
    capabilities: ['mail.read', 'calendar.read'],
    scopes: ['openid', 'email', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'],
    statusReason: 'GRANT_INVALID',
  };

  /* ---- Home "Upcoming" (Google ok, Microsoft expired) */
  const nextHour = Math.ceil((now + 45 * MIN) / HOUR) * HOUR;
  const tomorrow = weekdayAhead(zone, now, 1);
  const in3 = dayIn(zone, now, 3);
  const in4 = dayIn(zone, now, 4);
  const dentistStart = zoned(zone, tomorrow, 10, 30);
  const event = (
    id: string,
    title: string,
    start: number,
    end: number,
    extra: Partial<CalendarEventSummary> = {},
  ): CalendarEventSummary => ({
    id,
    provider: 'google',
    connectionId: PC.connGoogle,
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timeZone: zone,
    allDay: false,
    location: null,
    status: 'confirmed',
    webLink: `https://calendar.google.com/calendar/event?eid=${id}`,
    attendeeCount: 0,
    ...extra,
  });
  const allDayStart = zoned(zone, in3, 0);
  const allDayEnd = zoned(zone, dayIn(zone, now, 4), 0);
  const nyDay = in4;
  const upcoming: UpcomingEvents = {
    events: [
      event('evtcall01', c.events.call, nextHour, nextHour + 30 * MIN, { attendeeCount: 2 }),
      event(
        'evtreview02',
        c.events.review,
        zoned(zone, tomorrow, 10),
        zoned(zone, tomorrow, 11, 30),
        {
          location: c.events.reviewRoom,
          attendeeCount: 6,
        },
      ),
      event('evtdentist03', c.events.dentist, dentistStart, dentistStart + 30 * MIN, {
        location: 'Fixture Dental, 3 Molar Lane, 10117 Fixture City',
      }),
      event('evtsummit04', c.events.conference, allDayStart, allDayEnd, {
        allDay: true,
        timeZone: null,
      }),
      event(
        'evtsync05',
        c.events.sync,
        zoned('America/New_York', nyDay, 9),
        zoned('America/New_York', nyDay, 9, 45),
        { timeZone: 'America/New_York', attendeeCount: 8 },
      ),
      event('evtdinner06', c.events.dinner, zoned(zone, in4, 19, 30), zoned(zone, in4, 21, 30), {
        status: 'tentative',
        attendeeCount: 1,
      }),
      event(
        'evtyoga07',
        c.events.yoga,
        zoned(zone, dayIn(zone, now, 5), 18),
        zoned(zone, dayIn(zone, now, 5), 19),
        { status: 'cancelled' },
      ),
    ],
    sources: [
      {
        connectionId: PC.connGoogle,
        provider: 'google',
        accountIdentifier: EMAIL,
        status: 'ok',
      },
      {
        connectionId: PC.connMicrosoft,
        provider: 'microsoft',
        accountIdentifier: microsoft.accountIdentifier,
        status: 'expired',
      },
    ],
    rangeStart: at(0),
    rangeEnd: at(7 * DAY),
    fetchedAt: at(-20 * SEC),
  };

  /* ---- evidence files */
  const shopUrl = `${FIXTURE_ORIGIN}/shop/search?q=headphones`;
  const outletUrl = `${FIXTURE_ORIGIN}/outlet/search?q=headphones`;
  const slotsUrl = `${FIXTURE_ORIGIN}/booking/slots?service=checkup`;
  const bookedStartIso = new Date(dentistStart).toISOString();
  const bookedEndIso = new Date(dentistStart + 30 * MIN).toISOString();
  const ics = `ics:${icsFor('FD-4001', bookedStartIso, bookedEndIso)}`;
  const files: Record<string, string> = {
    [PC.evShop]: 'shop-search.png',
    [PC.evOutlet]: 'outlet-search.png',
    [PC.evSlots]: 'booking-slots.png',
    [PC.evConfirmation]: 'booking-confirmation.png',
    [PC.evIcs]: ics,
    [PC.evCaptcha]: 'captcha.png',
    [PC.evCheckout]: 'shop-checkout.png',
    [PC.evCart]: 'shop-cart.png',
    [PC.evForm]: 'booking-form.png',
  };
  const art = {
    shop: artifact(
      PC.evShop,
      files[PC.evShop]!,
      'screenshot',
      shopUrl,
      PC.compare,
      PC.sShop,
      at(-50 * MIN),
    ),
    outlet: artifact(
      PC.evOutlet,
      files[PC.evOutlet]!,
      'screenshot',
      outletUrl,
      PC.compare,
      PC.sOutlet,
      at(-50 * MIN),
    ),
    slots: artifact(
      PC.evSlots,
      files[PC.evSlots]!,
      'screenshot',
      slotsUrl,
      PC.slots,
      PC.sSlots,
      at(-3 * HOUR),
    ),
    confirmation: artifact(
      PC.evConfirmation,
      files[PC.evConfirmation]!,
      'screenshot',
      `${FIXTURE_ORIGIN}/booking/confirmation/FD-4001`,
      PC.booked,
      PC.sBooked,
      at(-26 * HOUR),
    ),
    ics: artifact(PC.evIcs, ics, 'ics', null, PC.booked, PC.sBooked, at(-26 * HOUR)),
    captcha: artifact(
      PC.evCaptcha,
      files[PC.evCaptcha]!,
      'screenshot',
      `${FIXTURE_ORIGIN}/captcha`,
      PC.captcha,
      PC.sCaptcha,
      at(-5 * HOUR),
    ),
    checkout: artifact(
      PC.evCheckout,
      files[PC.evCheckout]!,
      'screenshot',
      `${FIXTURE_ORIGIN}/shop/checkout/c-7`,
      PC.buy,
      PC.sCart,
      at(-6 * MIN),
    ),
    cart: artifact(
      PC.evCart,
      files[PC.evCart]!,
      'screenshot',
      `${FIXTURE_ORIGIN}/shop/cart/c-7`,
      PC.buy,
      PC.sCart,
      at(-6 * MIN),
    ),
  };

  /* ---- orders and bookings */
  const monthStart = zoned(zone, { ...dayIn(zone, now, 0), d: 1 }, 0);
  const thisMonth = now - Math.min(2 * DAY, Math.max(HOUR, (now - monthStart) / 2));
  const lastMonth = monthStart - 3 * DAY;
  const earbuds = {
    title: 'FX-10 Wireless Earbuds',
    quantity: 1,
    unitPrice: usd(3999),
    lineTotal: usd(3999),
    productUrl: `${FIXTURE_ORIGIN}/shop/products/FX-10`,
  };
  const orderPlaced: Order = {
    id: PC.orderPlaced,
    taskId: PC.ordered,
    siteId: 'fixture-shop',
    merchantName: 'Fixture Shop',
    merchantHost: FIXTURE_HOST,
    status: 'placed',
    items: [earbuds],
    subtotal: usd(3999),
    shipping: usd(499),
    tax: null,
    total: usd(4498),
    merchantOrderId: 'FS-1042',
    placedAt: new Date(thisMonth).toISOString(),
    failureReason: null,
    evidence: [],
    createdAt: new Date(thisMonth - 2 * MIN).toISOString(),
    updatedAt: new Date(thisMonth).toISOString(),
  };
  const orderUnknown: Order = {
    ...orderPlaced,
    id: PC.orderUnknown,
    taskId: PC.unknown,
    status: 'unknown',
    merchantOrderId: null,
    placedAt: null,
    failureReason: 'ORDER_UNKNOWN',
    createdAt: new Date(lastMonth).toISOString(),
    updatedAt: new Date(lastMonth + MIN).toISOString(),
  };
  const orderFailed: Order = {
    ...orderPlaced,
    id: PC.orderFailed,
    taskId: null,
    status: 'failed',
    items: [
      {
        title: 'FX-100 Wireless Headphones',
        quantity: 1,
        unitPrice: usd(7900),
        lineTotal: usd(7900),
        productUrl: `${FIXTURE_ORIGIN}/shop/products/FX-100`,
      },
    ],
    subtotal: usd(7900),
    shipping: usd(499),
    total: usd(8399),
    merchantOrderId: null,
    placedAt: null,
    failureReason: 'PRICE_CHANGED',
    createdAt: new Date(lastMonth - 4 * DAY).toISOString(),
    updatedAt: new Date(lastMonth - 4 * DAY + MIN).toISOString(),
  };
  const booking: Booking = {
    id: PC.booking,
    taskId: PC.booked,
    siteId: 'fixture-booking',
    siteName: 'Fixture Dental',
    siteHost: FIXTURE_HOST,
    service: 'Check-up',
    status: 'confirmed',
    start: bookedStartIso,
    end: bookedEndIso,
    timeZone: 'Europe/Berlin',
    reference: 'FD-4001',
    price: null,
    binding: false,
    calendarEventId: 'evtdentist03',
    failureReason: null,
    evidence: [art.confirmation, art.ics],
    createdAt: at(-26 * HOUR),
    updatedAt: at(-26 * HOUR + MIN),
  };
  const spentMicro = orderPlaced.total.amountMicro;

  /* ---- watches */
  const watches: EmailWatch[] = [
    {
      id: PC.watchOpen,
      provider: 'google',
      connectionId: PC.connGoogle,
      threadId: '18f2a9c4d1e7b305',
      subject: c.watchSubjects[0],
      status: 'watching',
      taskId: PC.draft,
      lastCheckedAt: at(-2 * MIN),
      nextCheckAt: at(8 * MIN),
      replyAt: null,
      replyFrom: null,
      expiresAt: at(13 * DAY),
      createdAt: at(-DAY),
      updatedAt: at(-2 * MIN),
    },
    {
      id: PC.watchReplied,
      provider: 'google',
      connectionId: PC.connGoogle,
      threadId: '18f1c0aa93be4410',
      subject: c.watchSubjects[1],
      status: 'replied',
      taskId: null,
      lastCheckedAt: at(-2 * HOUR),
      nextCheckAt: null,
      replyAt: at(-2 * HOUR - 4 * MIN),
      replyFrom: { name: c.threads[1]!.name, address: c.threads[1]!.from },
      expiresAt: at(9 * DAY),
      createdAt: at(-5 * DAY),
      updatedAt: at(-2 * HOUR),
    },
    {
      id: PC.watchExpired,
      provider: 'google',
      connectionId: PC.connGoogle,
      threadId: '18e7d2f0b1c95577',
      subject: c.watchSubjects[2],
      status: 'expired',
      taskId: null,
      lastCheckedAt: at(-6 * DAY),
      nextCheckAt: null,
      replyAt: null,
      replyFrom: null,
      expiresAt: at(-6 * DAY),
      createdAt: at(-20 * DAY),
      updatedAt: at(-6 * DAY),
    },
  ];

  /* ---- tasks */
  const details: TaskDetail[] = [];
  const approvals: Approval[] = [];
  type StepInput = Partial<TaskStep> &
    Pick<TaskStep, 'toolId'> & { message: ServerMessage | string };
  const steps = (taskId: string, t0: number, list: StepInput[]): TaskStep[] =>
    list.map((s, i) => {
      const title =
        typeof s.message === 'string' ? { text: s.message, message: null } : said(s.message);
      const { message: _m, ...rest } = s;
      void _m;
      const done = (s.status ?? 'SUCCEEDED') === 'SUCCEEDED';
      return {
        id: derivedId(taskId, 1).slice(0, 34) + String(10 + i),
        position: i,
        title: title.text,
        titleMessage: title.message,
        riskLevel: 'LOW',
        status: 'SUCCEEDED',
        requiresApproval: false,
        policy: { decision: 'allow', reasons: ['RISK_LOW'] },
        inputPreview: {},
        output: null,
        evidence: [],
        attempts: done ? 1 : 0,
        startedAt: done ? new Date(t0 + i * 4 * SEC).toISOString() : null,
        completedAt: done ? new Date(t0 + i * 4 * SEC + 3 * SEC).toISOString() : null,
        error: null,
        ...rest,
      } as TaskStep;
    });

  const task = (
    id: string,
    p: {
      request: string;
      title: ServerMessage | string;
      objective?: ServerMessage | null;
      status: TaskDetail['status'];
      riskLevel?: TaskDetail['riskLevel'];
      t0: number;
      planner?: 'offline' | 'model';
      steps: TaskStep[];
      approvals?: Approval[];
      result?: ServerMessage | string | null;
      outcome?: TaskDetail['outcome'];
      error?: TaskDetail['error'];
      browserSessions?: BrowserSession[];
      canRetry?: boolean;
    },
  ) => {
    const title = typeof p.title === 'string' ? { text: p.title, message: null } : said(p.title);
    const objective = p.objective ? said(p.objective) : null;
    const result =
      p.result == null
        ? null
        : typeof p.result === 'string'
          ? { text: p.result, message: null }
          : said(p.result);
    const end = p.t0 + p.steps.length * 4 * SEC + 2 * SEC;
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(p.status);
    const pending = (p.approvals ?? []).find((a) => a.status === 'PENDING') ?? null;
    const detail: TaskDetail = {
      id,
      title: title.text,
      titleMessage: title.message,
      request: p.request,
      status: p.status,
      riskLevel: p.riskLevel ?? 'LOW',
      source: 'text',
      progress: {
        completed: p.steps.filter((s) => s.status === 'SUCCEEDED').length,
        total: p.steps.length,
      },
      pendingApprovalId: pending?.id ?? null,
      pendingApproval: pending ? { id: pending.id, untrustedSource: false } : null,
      resultSummary: result?.text ?? null,
      resultSummaryMessage: result?.message ?? null,
      error: p.error ?? null,
      createdAt: new Date(p.t0 - 2 * SEC).toISOString(),
      updatedAt: new Date(end).toISOString(),
      completedAt: terminal ? new Date(end).toISOString() : null,
      conversationId: derivedId(id, 9),
      outcome: p.status === 'COMPLETED' ? (p.outcome ?? 'answer') : null,
      question: null,
      scheduleId: null,
      attachmentCount: 0,
      objective: objective?.text ?? null,
      objectiveMessage: objective?.message ?? null,
      planner:
        p.planner === 'model'
          ? { mode: 'model', provider: 'anthropic', model: 'claude-sonnet-4-6' }
          : { mode: 'offline', provider: null, model: null },
      answer: null,
      steps: p.steps,
      approvals: p.approvals ?? [],
      events: [],
      cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
      evidence: p.steps.flatMap((s) => s.evidence),
      canCancel: !terminal,
      canRetry: p.canRetry ?? false,
      startedAt: new Date(p.t0).toISOString(),
      attachments: [],
      browserSessions: p.browserSessions ?? [],
    };
    details.push(detail);
    approvals.push(...(p.approvals ?? []));
    return detail;
  };

  const ev = (
    kind: Evidence['kind'],
    code: Evidence['code'],
    label: string,
    value: string,
    params: Evidence['params'],
    when: number,
  ): Evidence => ({ kind, code, label, value, params, at: new Date(when).toISOString() });
  const screenshotEv = (a: EvidenceArtifact, when: number) =>
    ev(
      'browser_capture',
      'SCREENSHOT',
      'Screenshot',
      a.pageUrl ?? '',
      {
        artifactId: a.id,
        url: a.pageUrl ?? '',
        sha256: a.sha256,
      },
      when,
    );

  const session = (
    id: string,
    taskId: string,
    stepId: string,
    siteId: string,
    operation: string,
    status: BrowserSession['status'],
    t: number,
    artifacts: EvidenceArtifact[],
    extra: Partial<BrowserSession> = {},
  ): BrowserSession => ({
    id,
    taskId,
    stepId,
    siteId,
    operation,
    status,
    stopReason: null,
    handoverUrl: null,
    navigations: 2,
    requests: 14,
    blockedRequests: 0,
    startedAt: new Date(t).toISOString(),
    endedAt: new Date(t + 6 * SEC).toISOString(),
    createdAt: new Date(t - SEC).toISOString(),
    artifacts,
    ...extra,
  });

  // 1. What needs my reply? (email.search, needsReply)
  {
    const t0 = now - 25 * MIN;
    const dates = [at(-3 * HOUR), at(-20 * HOUR), at(-2 * DAY)].map((d) => d.slice(0, 10));
    task(PC.replies, {
      request: c.repliesRequest,
      title: msg('plan.emailNeedsReply'),
      objective: msg('objective.emailNeedsReply'),
      status: 'COMPLETED',
      t0,
      steps: steps(PC.replies, t0, [
        {
          toolId: 'email.search',
          message: msg('step.searchEmail'),
          inputPreview: { provider: 'google', needsReply: true, limit: 10 },
          output: {
            provider: 'google',
            count: c.threads.length,
            text: searchText(locale, c.threads, dates),
            suspectedInjection: false,
          },
          evidence: [
            ev(
              'provider_response',
              'MAIL_SEARCH',
              'google mail search',
              '3 conversation(s)',
              {
                provider: 'google',
                threads: 3,
              },
              t0 + 3 * SEC,
            ),
          ],
        },
      ]),
      result: searchText(locale, c.threads, dates).split('\n')[0]!,
    });
  }

  // 2. Summarize my unread emails (search → read → summarize)
  {
    const t0 = now - 70 * MIN;
    task(PC.unread, {
      request: c.unreadRequest,
      title: msg('plan.emailUnread'),
      objective: msg('objective.emailUnread'),
      status: 'COMPLETED',
      t0,
      steps: steps(PC.unread, t0, [
        {
          toolId: 'email.search',
          message: msg('step.searchEmail'),
          inputPreview: { provider: 'google', unreadOnly: true, limit: 10 },
          output: {
            provider: 'google',
            count: 3,
            text: searchText(locale, c.threads, ['2026-11-03', '2026-11-03', '2026-11-02']),
            suspectedInjection: false,
          },
          evidence: [
            ev(
              'provider_response',
              'MAIL_SEARCH',
              'google mail search',
              '3 conversation(s)',
              { provider: 'google', threads: 3 },
              t0 + 3 * SEC,
            ),
          ],
        },
        {
          toolId: 'email.read_thread',
          message: msg('step.readThreads'),
          inputPreview: { provider: 'google', threadIds: '{{s1.threadIds}}' },
          output: {
            provider: 'google',
            messageCount: 5,
            digest: c.threads.map((t) => `${t.name}: ${t.subject}`).join('\n'),
            truncated: false,
            suspectedInjection: false,
          },
          evidence: [
            ev(
              'provider_response',
              'PROVIDER_RESPONSE',
              'google threads.read',
              '200',
              { provider: 'google', operation: 'threads.read', status: 200 },
              t0 + 7 * SEC,
            ),
          ],
        },
        {
          toolId: 'text.summarize',
          message: msg('step.summarizeEmail'),
          inputPreview: { source: '{{s2.text}}', maxSentences: 5 },
          output: { summary: c.unreadSummary, sentences: 3 },
          evidence: [
            ev(
              'note',
              'EXTRACTIVE_SUMMARY',
              'Extractive summary',
              '3 key sentences from 4180 characters; no AI model was used.',
              { sentences: 3, chars: 4180, excludedSentences: 0 },
              t0 + 11 * SEC,
            ),
          ],
        },
      ]),
      result: c.unreadSummary.split('\n')[0]!,
    });
  }

  // 3. Compare prices (shop.search on both fixture shops → shop.compare)
  const offersPreview = [
    {
      title: 'FX-200 Noise-Cancelling Headphones',
      merchant: 'Fixture Outlet',
      total: null,
      price: usd(13900),
    },
    {
      title: 'FX-200 Noise-Cancelling Headphones',
      merchant: 'Fixture Shop',
      total: usd(14900),
      price: usd(14900),
    },
    {
      title: 'FX-100 Wireless Headphones (open box)',
      merchant: 'Fixture Outlet',
      total: usd(8440),
      price: usd(7450),
    },
    {
      title: 'FX-100 Wireless Headphones',
      merchant: 'Fixture Shop',
      total: usd(8399),
      price: usd(7900),
    },
  ];
  {
    const t0 = now - 52 * MIN;
    const s = steps(PC.compare, t0, [
      {
        toolId: 'shop.search',
        message: msg('step.searchShops', { query: c.compareQuery }),
        inputPreview: { query: c.compareQuery },
        output: {
          query: c.compareQuery,
          offerCount: offersPreview.length,
          offers: offersPreview,
          sites: [
            { siteId: 'fixture-outlet', status: 'ok', reason: null },
            { siteId: 'fixture-shop', status: 'ok', reason: null },
          ],
          suspectedInjection: false,
        },
        evidence: [screenshotEv(art.outlet, t0 + 2 * SEC), screenshotEv(art.shop, t0 + 3 * SEC)],
      },
      {
        toolId: 'shop.compare',
        message: msg('step.compareOffers'),
        inputPreview: { searchIds: '{{s1.searchId}}', preference: 'total' },
        output: {
          offerCount: 4,
          ranking: [
            { title: 'FX-100 Wireless Headphones', merchant: 'Fixture Shop', total: usd(8399) },
            {
              title: 'FX-100 Wireless Headphones (open box)',
              merchant: 'Fixture Outlet',
              total: usd(8440),
            },
            {
              title: 'FX-200 Noise-Cancelling Headphones',
              merchant: 'Fixture Shop',
              total: usd(14900),
            },
            {
              title: 'FX-200 Noise-Cancelling Headphones',
              merchant: 'Fixture Outlet',
              total: null,
            },
          ],
          best: {
            title: 'FX-200 Noise-Cancelling Headphones',
            merchant: 'Fixture Shop',
            total: usd(14900),
          },
          mixedCurrencies: false,
        },
      },
    ]);
    task(PC.compare, {
      request: c.compareRequest,
      title: msg('plan.compareProducts', { query: c.compareQuery }),
      objective: msg('objective.compareProducts', { query: c.compareQuery }),
      status: 'COMPLETED',
      t0,
      steps: s,
      result: '“' + c.compareQuery + '”: 4 offers compared',
      browserSessions: [
        session(
          PC.sOutlet,
          PC.compare,
          s[0]!.id,
          'fixture-outlet',
          'search',
          'succeeded',
          t0,
          [art.outlet],
          { navigations: 1, requests: 9 },
        ),
        session(
          PC.sShop,
          PC.compare,
          s[0]!.id,
          'fixture-shop',
          'search',
          'succeeded',
          t0 + SEC,
          [art.shop],
          { navigations: 1, requests: 11, blockedRequests: 2 },
        ),
      ],
    });
  }

  // 4. Free appointments (booking.find_slots)
  const slotDays = [weekdayAhead('Europe/Berlin', now, 1), weekdayAhead('Europe/Berlin', now, 2)];
  const slotStarts = [
    zoned('Europe/Berlin', slotDays[0]!, 10),
    zoned('Europe/Berlin', slotDays[0]!, 11),
    zoned('Europe/Berlin', slotDays[0]!, 14),
    zoned('Europe/Berlin', slotDays[1]!, 9),
    zoned('Europe/Berlin', slotDays[1]!, 15),
  ];
  {
    const t0 = now - 3 * HOUR;
    const s = steps(PC.slots, t0, [
      {
        toolId: 'booking.find_slots',
        message: msg('step.findSlots', { site: 'Fixture Dental' }),
        inputPreview: { siteId: 'fixture-booking', service: 'Check-up' },
        output: {
          siteId: 'fixture-booking',
          service: 'Check-up',
          slotCount: 40,
          slots: slotStarts.map((st) => ({
            start: new Date(st).toISOString(),
            timeZone: 'Europe/Berlin',
          })),
          requiredFields: ['Full name', 'Email', 'Phone'],
          evidenceArtifactId: PC.evSlots,
        },
        evidence: [screenshotEv(art.slots, t0 + 3 * SEC)],
      },
    ]);
    task(PC.slots, {
      request: c.slotsRequest,
      title: msg('plan.findSlots', { site: 'Fixture Dental' }),
      objective: msg('objective.findSlots', { site: 'Fixture Dental' }),
      status: 'COMPLETED',
      t0,
      steps: s,
      result: '40 free time(s) on Fixture Dental',
      browserSessions: [
        session(PC.sSlots, PC.slots, s[0]!.id, 'fixture-booking', 'slots', 'succeeded', t0, [
          art.slots,
        ]),
      ],
    });
  }

  // 5. Booked (find_slots → booking.book, approved)
  {
    const t0 = now - 26 * HOUR - 3 * MIN;
    const s = steps(PC.booked, t0, [
      {
        toolId: 'booking.find_slots',
        message: msg('step.findSlots', { site: 'Fixture Dental' }),
        inputPreview: { siteId: 'fixture-booking', service: 'Check-up' },
        output: {
          siteId: 'fixture-booking',
          service: 'Check-up',
          slotCount: 38,
          slots: [{ start: bookedStartIso, timeZone: 'Europe/Berlin' }],
          requiredFields: ['Full name', 'Email', 'Phone'],
          evidenceArtifactId: null,
        },
      },
      {
        toolId: 'booking.book',
        message: msg('step.book', { site: 'Fixture Dental' }),
        riskLevel: 'MEDIUM',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM'] },
        inputPreview: {
          siteId: 'fixture-booking',
          service: 'Check-up',
          expectedStart: bookedStartIso,
        },
        output: {
          bookingId: PC.booking,
          reference: 'FD-4001',
          title: 'Check-up — Fixture Dental',
          start: bookedStartIso,
          end: bookedEndIso,
          timeZone: 'Europe/Berlin',
          location: 'Fixture Dental, 3 Molar Lane, 10117 Fixture City',
        },
        evidence: [
          screenshotEv(art.confirmation, t0 + 7 * SEC),
          ev(
            'browser_capture',
            'ICS_FILE',
            'ICS file',
            PC.evIcs,
            { artifactId: PC.evIcs, sha256: art.ics.sha256 },
            t0 + 7 * SEC,
          ),
          ev(
            'record',
            'BOOKING_CONFIRMATION',
            'Booking confirmed by the site',
            'FD-4001',
            { bookingId: PC.booking, reference: 'FD-4001' },
            t0 + 7 * SEC,
          ),
        ],
      },
    ]);
    const approval: Approval = {
      id: PC.aBooked,
      taskId: PC.booked,
      taskTitle: text(locale, msg('plan.book', { service: 'Check-up', site: 'Fixture Dental' })),
      taskTitleMessage: msg('plan.book', { service: 'Check-up', site: 'Fixture Dental' }),
      stepId: s[1]!.id,
      toolId: 'booking.book',
      status: 'APPROVED',
      riskLevel: 'MEDIUM',
      summary: text(
        locale,
        msg('approval.booking', { service: 'Check-up', site: 'Fixture Dental' }),
      ),
      summaryMessage: msg('approval.booking', { service: 'Check-up', site: 'Fixture Dental' }),
      details: {
        kind: 'booking',
        siteId: 'fixture-booking',
        siteName: 'Fixture Dental',
        siteHost: FIXTURE_HOST,
        service: 'Check-up',
        start: bookedStartIso,
        end: bookedEndIso,
        timeZone: 'Europe/Berlin',
        fields: [
          { label: 'Full name', value: 'Layla Haddad', personal: true },
          { label: 'Email', value: EMAIL, personal: true },
          { label: 'Phone', value: '+49 30 1234567', personal: true },
        ],
        price: null,
        binding: false,
        cancellationTerms: 'Free of charge. You can cancel at any time.',
        evidenceArtifactId: null,
      },
      actionHash: 'sha256:5b1f0c9e7d2a4b6c8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d',
      reasons: ['RISK_MEDIUM'],
      expiresAt: at(-2 * HOUR),
      decidedAt: new Date(t0 + 5 * SEC).toISOString(),
      decisionNote: null,
      createdAt: new Date(t0 + 4 * SEC).toISOString(),
    };
    task(PC.booked, {
      request: c.bookedRequest,
      title: msg('plan.book', { service: 'Check-up', site: 'Fixture Dental' }),
      objective: msg('objective.book', { service: 'Check-up', site: 'Fixture Dental' }),
      status: 'COMPLETED',
      riskLevel: 'MEDIUM',
      t0,
      steps: s,
      approvals: [approval],
      outcome: 'action',
      result: msg('result.booked', {
        service: 'Check-up',
        site: 'Fixture Dental',
        reference: 'FD-4001',
      }),
      browserSessions: [
        session(
          PC.sBooked,
          PC.booked,
          s[1]!.id,
          'fixture-booking',
          'book',
          'succeeded',
          t0 + 6 * SEC,
          [art.confirmation, art.ics],
          { navigations: 3, requests: 18 },
        ),
      ],
    });
  }

  // 6. Ordered (search → compare → prepare_cart → checkout, approved) — order FS-1042
  {
    const t0 = new Date(orderPlaced.createdAt).getTime() - 20 * SEC;
    const s = steps(PC.ordered, t0, [
      {
        toolId: 'shop.search',
        message: msg('step.searchShops', { query: 'FX-10' }),
        inputPreview: { query: 'FX-10', siteIds: 'fixture-shop' },
        output: {
          query: 'FX-10',
          offerCount: 1,
          offers: [
            { title: earbuds.title, merchant: 'Fixture Shop', total: usd(4498), price: usd(3999) },
          ],
          sites: [{ siteId: 'fixture-shop', status: 'ok', reason: null }],
          suspectedInjection: false,
        },
      },
      {
        toolId: 'shop.compare',
        message: msg('step.compareOffers'),
        output: {
          offerCount: 1,
          ranking: [{ title: earbuds.title, merchant: 'Fixture Shop', total: usd(4498) }],
          best: { title: earbuds.title, merchant: 'Fixture Shop', total: usd(4498) },
          mixedCurrencies: false,
        },
      },
      {
        toolId: 'shop.prepare_cart',
        message: msg('step.prepareCart', { site: 'Fixture Shop' }),
        riskLevel: 'MEDIUM',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM'] },
        inputPreview: { siteId: 'fixture-shop', quantity: 1 },
        output: {
          merchant: 'Fixture Shop',
          lines: [{ title: earbuds.title, quantity: 1, lineTotal: usd(3999) }],
          total: usd(4498),
          handoverUrl: null,
          checkoutSupported: true,
        },
      },
      {
        toolId: 'shop.checkout',
        message: msg('step.checkout', { site: 'Fixture Shop' }),
        riskLevel: 'HIGH',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_HIGH', 'PURCHASE'] },
        inputPreview: { siteId: 'fixture-shop', expectedTotalMicro: 44_980_000, currency: 'USD' },
        output: {
          orderId: PC.orderPlaced,
          merchantOrderId: 'FS-1042',
          total: moneyParam(usd(4498)),
          merchant: 'Fixture Shop',
          reconciled: false,
        },
        evidence: [
          ev(
            'record',
            'ORDER_CONFIRMATION',
            'Order confirmed by the merchant',
            'FS-1042',
            { orderId: PC.orderPlaced, merchantOrderId: 'FS-1042', total: moneyParam(usd(4498)) },
            t0 + 15 * SEC,
          ),
        ],
      },
    ]);
    task(PC.ordered, {
      request: c.orderedRequest,
      title: msg('plan.buy', { product: 'FX-10', site: 'Fixture Shop' }),
      objective: msg('objective.buy', { product: 'FX-10', site: 'Fixture Shop' }),
      status: 'COMPLETED',
      riskLevel: 'HIGH',
      t0,
      steps: s,
      outcome: 'action',
      result: msg('result.orderPlaced', { merchant: 'Fixture Shop', orderId: 'FS-1042' }),
    });
  }

  // 7. Buy (awaiting the purchase approval: scenario 3 → 7 with a limit set)
  {
    const t0 = now - 7 * MIN;
    const product = c.buyProduct;
    const s = steps(PC.buy, t0, [
      {
        toolId: 'shop.search',
        message: msg('step.searchShops', { query: product }),
        inputPreview: { query: product, siteIds: 'fixture-shop' },
        output: {
          query: product,
          offerCount: 1,
          offers: [offersPreview[1]],
          sites: [{ siteId: 'fixture-shop', status: 'ok', reason: null }],
          suspectedInjection: false,
        },
      },
      {
        toolId: 'shop.compare',
        message: msg('step.compareOffers'),
        output: {
          offerCount: 1,
          ranking: [
            {
              title: 'FX-200 Noise-Cancelling Headphones',
              merchant: 'Fixture Shop',
              total: usd(14900),
            },
          ],
          best: {
            title: 'FX-200 Noise-Cancelling Headphones',
            merchant: 'Fixture Shop',
            total: usd(14900),
          },
          mixedCurrencies: false,
        },
      },
      {
        toolId: 'shop.prepare_cart',
        message: msg('step.prepareCart', { site: 'Fixture Shop' }),
        riskLevel: 'MEDIUM',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM'] },
        inputPreview: { siteId: 'fixture-shop', quantity: 1 },
        output: {
          merchant: 'Fixture Shop',
          lines: [
            { title: 'FX-200 Noise-Cancelling Headphones', quantity: 1, lineTotal: usd(14900) },
          ],
          total: usd(14900),
          handoverUrl: null,
          checkoutSupported: true,
        },
        evidence: [
          ev(
            'browser_capture',
            'CART_SNAPSHOT',
            'Cart',
            moneyParam(usd(14900)),
            { artifactId: PC.evCart, total: moneyParam(usd(14900)) },
            t0 + 11 * SEC,
          ),
        ],
      },
      {
        toolId: 'shop.checkout',
        message: msg('step.checkout', { site: 'Fixture Shop' }),
        riskLevel: 'HIGH',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_HIGH', 'PURCHASE'] },
        inputPreview: {
          siteId: 'fixture-shop',
          cartId: '{{s3.cartId}}',
          expectedTotalMicro: '{{s3.totalMicro}}',
          currency: '{{s3.currency}}',
        },
      },
    ]);
    const approval: Approval = {
      id: PC.aPurchase,
      taskId: PC.buy,
      taskTitle: text(locale, msg('plan.buy', { product, site: 'Fixture Shop' })),
      taskTitleMessage: msg('plan.buy', { product, site: 'Fixture Shop' }),
      stepId: s[3]!.id,
      toolId: 'shop.checkout',
      status: 'PENDING',
      riskLevel: 'HIGH',
      summary: text(
        locale,
        msg('approval.purchase', { total: moneyParam(usd(14900)), merchant: 'Fixture Shop' }),
      ),
      summaryMessage: msg('approval.purchase', {
        total: moneyParam(usd(14900)),
        merchant: 'Fixture Shop',
      }),
      details: {
        kind: 'purchase',
        siteId: 'fixture-shop',
        merchant: { name: 'Fixture Shop', host: FIXTURE_HOST },
        items: [
          {
            title: 'FX-200 Noise-Cancelling Headphones',
            quantity: 1,
            unitPrice: usd(14900),
            lineTotal: usd(14900),
            productUrl: `${FIXTURE_ORIGIN}/shop/products/FX-200`,
          },
        ],
        subtotal: usd(14900),
        shipping: usd(0),
        tax: null,
        total: usd(14900),
        delivery: {
          method: 'Standard shipping',
          estimate: '1–2 business days',
          address: 'Alex Example, 12 Sample Road, 10115 Fixture City',
        },
        paymentMethod: 'Visa •••• 4242',
        limit: {
          monthly: usd(limitUsd * 100),
          spentThisMonth: { amountMicro: spentMicro, currency: 'USD' },
          remainingAfter: {
            amountMicro: Math.max(0, limitUsd * 1_000_000 - spentMicro - 149_000_000),
            currency: 'USD',
          },
        },
        evidenceArtifactId: PC.evCheckout,
      },
      actionHash: 'sha256:a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5',
      reasons: ['RISK_HIGH', 'PURCHASE'],
      expiresAt: at(23 * HOUR + 53 * MIN),
      decidedAt: null,
      decisionNote: null,
      createdAt: at(-6 * MIN),
    };
    task(PC.buy, {
      request: c.buyRequest,
      title: msg('plan.buy', { product, site: 'Fixture Shop' }),
      objective: msg('objective.buy', { product, site: 'Fixture Shop' }),
      status: 'AWAITING_APPROVAL',
      riskLevel: 'HIGH',
      t0,
      steps: s,
      approvals: [approval],
      browserSessions: [
        session(
          PC.sCart,
          PC.buy,
          s[2]!.id,
          'fixture-shop',
          'cart',
          'succeeded',
          t0 + 8 * SEC,
          [art.cart, art.checkout],
          { navigations: 3, requests: 22 },
        ),
      ],
    });
  }

  // 8. Meeting invitation (calendar.create_event, RECIPIENT_EXTERNAL) — planned by the model
  {
    const t0 = now - 4 * MIN;
    const friday = (() => {
      for (let plus = 1; plus < 8; plus++) {
        const d = dayIn(zone, now, plus);
        if (new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() === 5) return d;
      }
      return dayIn(zone, now, 3);
    })();
    const start = new Date(zoned(zone, friday, 14)).toISOString();
    const end = new Date(zoned(zone, friday, 15)).toISOString();
    const s = steps(PC.meet, t0, [
      {
        toolId: 'calendar.free_busy',
        message: msg('step.freeBusy'),
        inputPreview: { provider: 'google', attendees: [OMAR, SARA], durationMinutes: 60 },
        output: { provider: 'google', slotCount: 3, text: '' },
      },
      {
        toolId: 'calendar.create_event',
        message: msg('step.createEvent', { title: c.meetTitle }),
        riskLevel: 'MEDIUM',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM', 'RECIPIENT_EXTERNAL'] },
        inputPreview: {
          provider: 'google',
          title: c.meetTitle,
          start,
          end,
          attendees: [OMAR, SARA],
        },
      },
    ]);
    const approval: Approval = {
      id: PC.aEvent,
      taskId: PC.meet,
      taskTitle: c.meetTitle,
      taskTitleMessage: null,
      stepId: s[1]!.id,
      toolId: 'calendar.create_event',
      status: 'PENDING',
      riskLevel: 'MEDIUM',
      summary: text(
        locale,
        msg('approval.eventInvite', { title: c.meetTitle, recipients: `${OMAR}, ${SARA}` }),
      ),
      summaryMessage: msg('approval.eventInvite', {
        title: c.meetTitle,
        recipients: `${OMAR}, ${SARA}`,
      }),
      details: {
        kind: 'calendar_event',
        action: 'create',
        provider: 'google',
        account: EMAIL,
        eventId: null,
        title: c.meetTitle,
        start,
        end,
        timeZone: zone,
        allDay: false,
        location: c.events.reviewRoom,
        description: c.meetDescription,
        attendees: [OMAR, SARA],
        notifyAttendees: true,
        previous: null,
        conflictCheck: true,
      },
      actionHash: 'sha256:c1e3a5b7d9f1c3e5a7b9d1f3c5e7a9b1d3f5c7e9a1b3d5f7c9e1a3b5d7f9c1e3',
      reasons: ['RISK_MEDIUM', 'RECIPIENT_EXTERNAL'],
      expiresAt: at(23 * HOUR + 56 * MIN),
      decidedAt: null,
      decisionNote: null,
      createdAt: at(-3 * MIN),
    };
    task(PC.meet, {
      request: c.meetRequest,
      title: c.meetTitle,
      status: 'AWAITING_APPROVAL',
      riskLevel: 'MEDIUM',
      planner: 'model',
      t0,
      steps: s,
      approvals: [approval],
    });
  }

  // 9. Paid, binding booking (booking.book: BINDING_COMMITMENT + PURCHASE)
  {
    const t0 = now - 11 * MIN;
    const start = slotStarts[3]!;
    const s = steps(PC.book, t0, [
      {
        toolId: 'booking.find_slots',
        message: msg('step.findSlots', { site: 'Fixture Dental' }),
        inputPreview: { siteId: 'fixture-booking', service: 'Dental cleaning' },
        output: {
          siteId: 'fixture-booking',
          service: 'Dental cleaning',
          slotCount: 24,
          slots: slotStarts
            .slice(3)
            .map((st) => ({ start: new Date(st).toISOString(), timeZone: 'Europe/Berlin' })),
          requiredFields: ['Full name', 'Email', 'Phone'],
          evidenceArtifactId: PC.evSlots,
        },
        evidence: [screenshotEv(art.slots, t0 + 3 * SEC)],
      },
      {
        toolId: 'booking.book',
        message: msg('step.book', { site: 'Fixture Dental' }),
        riskLevel: 'HIGH',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: {
          decision: 'require_approval',
          reasons: ['RISK_HIGH', 'BINDING_COMMITMENT', 'PURCHASE'],
        },
        inputPreview: {
          siteId: 'fixture-booking',
          service: 'Dental cleaning',
          expectedStart: new Date(start).toISOString(),
        },
      },
    ]);
    const approval: Approval = {
      id: PC.aBooking,
      taskId: PC.book,
      taskTitle: text(
        locale,
        msg('plan.book', { service: 'Dental cleaning', site: 'Fixture Dental' }),
      ),
      taskTitleMessage: msg('plan.book', { service: 'Dental cleaning', site: 'Fixture Dental' }),
      stepId: s[1]!.id,
      toolId: 'booking.book',
      status: 'PENDING',
      riskLevel: 'HIGH',
      summary: text(
        locale,
        msg('approval.booking', { service: 'Dental cleaning', site: 'Fixture Dental' }),
      ),
      summaryMessage: msg('approval.booking', {
        service: 'Dental cleaning',
        site: 'Fixture Dental',
      }),
      details: {
        kind: 'booking',
        siteId: 'fixture-booking',
        siteName: 'Fixture Dental',
        siteHost: FIXTURE_HOST,
        service: 'Dental cleaning',
        start: new Date(start).toISOString(),
        end: new Date(start + 45 * MIN).toISOString(),
        timeZone: 'Europe/Berlin',
        fields: [
          { label: 'Full name', value: 'Layla Haddad', personal: true },
          { label: 'Email', value: EMAIL, personal: true },
          { label: 'Phone', value: '+49 30 1234567', personal: true },
        ],
        price: usd(8000),
        binding: true,
        cancellationTerms:
          'Cancellations less than 24 hours before the appointment are charged in full.',
        evidenceArtifactId: PC.evSlots,
      },
      actionHash: 'sha256:e5a7c9b1d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a5c7b9d1f3e5a7',
      reasons: ['RISK_HIGH', 'BINDING_COMMITMENT', 'PURCHASE'],
      expiresAt: at(23 * HOUR + 49 * MIN),
      decidedAt: null,
      decisionNote: null,
      createdAt: at(-10 * MIN),
    };
    task(PC.book, {
      request: c.bookRequest,
      title: msg('plan.book', { service: 'Dental cleaning', site: 'Fixture Dental' }),
      objective: msg('objective.book', { service: 'Dental cleaning', site: 'Fixture Dental' }),
      status: 'AWAITING_APPROVAL',
      riskLevel: 'HIGH',
      t0,
      steps: s,
      approvals: [approval],
      browserSessions: [
        session(
          derivedId(PC.sSlots, 3),
          PC.book,
          s[0]!.id,
          'fixture-booking',
          'slots',
          'succeeded',
          t0,
          [],
        ),
      ],
    });
  }

  // 10. Contact form (browser.fill, form_submission)
  {
    const t0 = now - 16 * MIN;
    const s = steps(PC.form, t0, [
      {
        toolId: 'browser.fill',
        message: msg('step.fillForm', { site: 'Fixture Dental' }),
        riskLevel: 'MEDIUM',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM'] },
        inputPreview: { siteId: 'fixture-booking', form: 'contact' },
      },
    ]);
    const approval: Approval = {
      id: PC.aForm,
      taskId: PC.form,
      taskTitle: c.formTitle,
      taskTitleMessage: null,
      stepId: s[0]!.id,
      toolId: 'browser.fill',
      status: 'PENDING',
      riskLevel: 'MEDIUM',
      summary: text(locale, msg('approval.formSubmission', { site: 'Fixture Dental' })),
      summaryMessage: msg('approval.formSubmission', { site: 'Fixture Dental' }),
      details: {
        kind: 'form_submission',
        siteId: 'fixture-booking',
        siteName: 'Fixture Dental',
        siteHost: FIXTURE_HOST,
        form: 'contact',
        fields: [
          { label: 'Name', value: 'Layla Haddad', personal: true },
          { label: 'Email', value: EMAIL, personal: true },
          { label: 'Message', value: c.formMessage, personal: false },
        ],
        binding: false,
        evidenceArtifactId: PC.evForm,
      },
      actionHash: 'sha256:f7b9d1e3a5c7f9b1d3e5a7c9f1b3d5e7a9c1f3b5d7e9a1c3f5b7d9e1a3c5f7b9',
      reasons: ['RISK_MEDIUM'],
      expiresAt: at(23 * HOUR + 44 * MIN),
      decidedAt: null,
      decisionNote: null,
      createdAt: at(-15 * MIN),
    };
    task(PC.form, {
      request: c.formRequest,
      title: c.formTitle,
      status: 'AWAITING_APPROVAL',
      riskLevel: 'MEDIUM',
      planner: 'model',
      t0,
      steps: s,
      approvals: [approval],
    });
  }

  // 11. Draft a reply (email.draft_reply, mode draft, via Google)
  {
    const t0 = now - 19 * MIN;
    const thread = c.threads[0]!;
    const s = steps(PC.draft, t0, [
      {
        toolId: 'email.search',
        message: msg('step.searchEmail'),
        inputPreview: { provider: 'google', from: 'Omar', limit: 1 },
        output: {
          provider: 'google',
          count: 1,
          text: searchText(locale, [thread], [at(-3 * HOUR).slice(0, 10)]),
          suspectedInjection: false,
        },
      },
      {
        toolId: 'email.draft_reply',
        message: msg('step.draftReply', { name: 'Omar' }),
        riskLevel: 'MEDIUM',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM', 'RECIPIENT_EXTERNAL'] },
        inputPreview: { provider: 'google', threadId: '{{s1.firstThreadId}}' },
      },
    ]);
    const subject = `Re: ${thread.subject}`;
    const approval: Approval = {
      id: PC.aDraft,
      taskId: PC.draft,
      taskTitle: text(locale, msg('plan.draftReply', { name: 'Omar' })),
      taskTitleMessage: msg('plan.draftReply', { name: 'Omar' }),
      stepId: s[1]!.id,
      toolId: 'email.draft_reply',
      status: 'PENDING',
      riskLevel: 'MEDIUM',
      summary: text(locale, msg('approval.emailDraft', { subject, recipients: OMAR })),
      summaryMessage: msg('approval.emailDraft', { subject, recipients: OMAR }),
      details: {
        kind: 'email',
        mode: 'draft',
        via: 'google',
        from: `Layla Haddad <${EMAIL}>`,
        to: [OMAR],
        cc: [SARA],
        subject,
        body: c.draftBody,
        inReplyTo: { threadId: '18f2a9c4d1e7b305', subject: thread.subject },
      },
      actionHash: 'sha256:b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1',
      reasons: ['RISK_MEDIUM', 'RECIPIENT_EXTERNAL'],
      expiresAt: at(23 * HOUR + 41 * MIN),
      decidedAt: null,
      decisionNote: null,
      createdAt: at(-18 * MIN),
    };
    task(PC.draft, {
      request: c.draftRequest,
      title: msg('plan.draftReply', { name: 'Omar' }),
      objective: msg('objective.draftReply', { name: 'Omar' }),
      status: 'AWAITING_APPROVAL',
      riskLevel: 'MEDIUM',
      t0,
      steps: s,
      approvals: [approval],
    });
  }

  // 12. Expired connection (scenario 9): planning-time deny CONNECTION_EXPIRED
  {
    const t0 = now - 40 * MIN;
    task(PC.expired, {
      request: c.expiredRequest,
      title: msg('plan.calendarUpcoming'),
      objective: msg('objective.calendarUpcoming'),
      status: 'FAILED',
      t0,
      steps: steps(PC.expired, t0, [
        {
          toolId: 'calendar.list',
          message: msg('step.listEvents'),
          status: 'BLOCKED',
          policy: { decision: 'deny', reasons: ['CONNECTION_EXPIRED'] },
          inputPreview: { provider: 'microsoft' },
          attempts: 0,
          startedAt: null,
          completedAt: null,
          error: {
            code: 'CONNECTION_REQUIRED',
            message: 'The microsoft connection has expired.',
            retryable: true,
            reason: 'CONNECTION_EXPIRED',
            params: { provider: 'microsoft' },
          },
        },
      ]),
      error: {
        code: 'CONNECTION_REQUIRED',
        message: 'The microsoft connection has expired: reconnect it.',
        retryable: true,
        reason: 'CONNECTION_EXPIRED',
        params: { provider: 'microsoft' },
      },
      canRetry: true,
    });
  }

  // 13. CAPTCHA: handover (browser.read on Fixture Outlet)
  {
    const t0 = now - 5 * HOUR;
    const s = steps(PC.captcha, t0, [
      {
        toolId: 'browser.read',
        message: msg('step.readSite', { site: 'Fixture Outlet' }),
        status: 'FAILED',
        inputPreview: {
          siteId: 'fixture-outlet',
          operation: 'read',
          url: `${FIXTURE_ORIGIN}/outlet/returns`,
        },
        evidence: [
          screenshotEv(art.captcha, t0 + 3 * SEC),
          ev(
            'note',
            'HANDOVER',
            'Handed over to you',
            `${FIXTURE_HOST} · CAPTCHA_DETECTED`,
            { host: FIXTURE_HOST, reason: 'CAPTCHA_DETECTED', url: `${FIXTURE_ORIGIN}/captcha` },
            t0 + 3 * SEC,
          ),
        ],
        error: {
          code: 'TOOL_FAILED',
          message: 'The site asks to prove a human is there.',
          retryable: false,
          reason: 'CAPTCHA_DETECTED',
          params: { host: FIXTURE_HOST },
        },
      },
    ]);
    task(PC.captcha, {
      request: c.captchaRequest,
      title: msg('step.readSite', { site: 'Fixture Outlet' }),
      status: 'FAILED',
      t0,
      steps: s,
      error: {
        code: 'TOOL_FAILED',
        message: 'The site asks to prove a human is there.',
        retryable: false,
        reason: 'CAPTCHA_DETECTED',
        params: { host: FIXTURE_HOST },
      },
      browserSessions: [
        session(
          PC.sCaptcha,
          PC.captcha,
          s[0]!.id,
          'fixture-outlet',
          'read',
          'handover',
          t0,
          [art.captcha],
          {
            stopReason: 'CAPTCHA_DETECTED',
            handoverUrl: `${FIXTURE_ORIGIN}/captcha`,
            navigations: 2,
            requests: 7,
          },
        ),
      ],
    });
  }

  // 14. Login wall: handover (booking.find_slots)
  {
    const t0 = now - 8 * HOUR;
    const s = steps(PC.login, t0, [
      {
        toolId: 'booking.find_slots',
        message: msg('step.findSlots', { site: 'Fixture Dental' }),
        status: 'FAILED',
        inputPreview: { siteId: 'fixture-booking', service: 'Check-up' },
        evidence: [
          ev(
            'note',
            'HANDOVER',
            'Handed over to you',
            `${FIXTURE_HOST} · LOGIN_REQUIRED`,
            { host: FIXTURE_HOST, reason: 'LOGIN_REQUIRED', url: `${FIXTURE_ORIGIN}/login-wall` },
            t0 + 3 * SEC,
          ),
        ],
        error: {
          code: 'TOOL_FAILED',
          message: 'The site needs a sign-in.',
          retryable: false,
          reason: 'LOGIN_REQUIRED',
          params: { host: FIXTURE_HOST },
        },
      },
    ]);
    task(PC.login, {
      request: c.loginRequest,
      title: msg('plan.findSlots', { site: 'Fixture Dental' }),
      status: 'FAILED',
      t0,
      steps: s,
      error: {
        code: 'TOOL_FAILED',
        message: 'The site needs a sign-in.',
        retryable: false,
        reason: 'LOGIN_REQUIRED',
        params: { host: FIXTURE_HOST },
      },
      browserSessions: [
        session(PC.sLogin, PC.login, s[0]!.id, 'fixture-booking', 'slots', 'handover', t0, [], {
          stopReason: 'LOGIN_REQUIRED',
          handoverUrl: `${FIXTURE_ORIGIN}/login-wall`,
        }),
      ],
    });
  }

  // 15. A site without a recipe
  {
    const t0 = now - 30 * HOUR;
    const host = 'www.trattoria-roma.example';
    task(PC.unsupported, {
      request: c.unsupportedRequest,
      title: msg('step.readSite', { site: host }),
      status: 'FAILED',
      t0,
      steps: steps(PC.unsupported, t0, [
        {
          toolId: 'browser.read',
          message: msg('step.readSite', { site: host }),
          status: 'FAILED',
          inputPreview: { url: `https://${host}/menu` },
          error: {
            code: 'TOOL_FAILED',
            message: `${host} is not a supported site.`,
            retryable: false,
            reason: 'SITE_UNSUPPORTED',
            params: { host },
          },
        },
      ]),
      error: {
        code: 'TOOL_FAILED',
        message: `${host} is not a supported site.`,
        retryable: false,
        reason: 'SITE_UNSUPPORTED',
        params: { host },
      },
    });
  }

  // 16–17. Purchases refused by the policy (scenario 7): off (limit 0), over the limit
  const deniedPlan = (
    id: string,
    request: string,
    product: string,
    reason: 'PURCHASES_DISABLED' | 'PURCHASE_LIMIT',
    params: Record<string, string>,
    t0: number,
  ) => {
    const s = steps(id, t0, [
      {
        toolId: 'shop.search',
        message: msg('step.searchShops', { query: product }),
        status: 'SKIPPED',
        attempts: 0,
        startedAt: null,
        completedAt: null,
      },
      {
        toolId: 'shop.compare',
        message: msg('step.compareOffers'),
        status: 'SKIPPED',
        attempts: 0,
        startedAt: null,
        completedAt: null,
      },
      {
        toolId: 'shop.prepare_cart',
        message: msg('step.prepareCart', { site: 'Fixture Shop' }),
        riskLevel: 'MEDIUM',
        status: 'SKIPPED',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM'] },
      },
      {
        toolId: 'shop.checkout',
        message: msg('step.checkout', { site: 'Fixture Shop' }),
        riskLevel: 'HIGH',
        status: 'BLOCKED',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        policy: { decision: 'deny', reasons: [reason] },
        error: {
          code: 'POLICY_DENIED',
          message: `Purchase refused: ${reason}.`,
          retryable: false,
          reason,
          params,
        },
      },
    ]);
    task(id, {
      request,
      title: msg('plan.buy', { product, site: 'Fixture Shop' }),
      objective: msg('objective.buy', { product, site: 'Fixture Shop' }),
      status: 'FAILED',
      riskLevel: 'HIGH',
      t0,
      steps: s,
      error: {
        code: 'POLICY_DENIED',
        message: `Purchase refused: ${reason}.`,
        retryable: false,
        reason,
        params,
      },
    });
  };
  deniedPlan(
    PC.denied,
    c.deniedRequest,
    c.buyProduct,
    'PURCHASES_DISABLED',
    { step: text(locale, msg('step.checkout', { site: 'Fixture Shop' })) },
    now - 2 * DAY,
  );
  deniedPlan(
    PC.overLimit,
    c.overLimitRequest,
    c.overLimitProduct,
    'PURCHASE_LIMIT',
    {
      limit: moneyParam(usd(limitUsd * 100)),
      spent: moneyParam({ amountMicro: spentMicro, currency: 'USD' }),
      amount: moneyParam(usd(89900)),
    },
    now - 90 * MIN,
  );

  // 18. Interrupted checkout (scenario 10): OUTCOME_UNKNOWN, the order row 'unknown'
  {
    const t0 = new Date(orderUnknown.createdAt).getTime() - 20 * SEC;
    task(PC.unknown, {
      request: c.unknownRequest,
      title: msg('plan.buy', { product: 'FX-10', site: 'Fixture Shop' }),
      status: 'FAILED',
      riskLevel: 'HIGH',
      t0,
      steps: steps(PC.unknown, t0, [
        {
          toolId: 'shop.prepare_cart',
          message: msg('step.prepareCart', { site: 'Fixture Shop' }),
          riskLevel: 'MEDIUM',
          output: {
            merchant: 'Fixture Shop',
            lines: [{ title: earbuds.title, quantity: 1, lineTotal: usd(3999) }],
            total: usd(4498),
            handoverUrl: null,
            checkoutSupported: true,
          },
        },
        {
          toolId: 'shop.checkout',
          message: msg('step.checkout', { site: 'Fixture Shop' }),
          riskLevel: 'HIGH',
          status: 'FAILED',
          requiresApproval: true,
          policy: { decision: 'require_approval', reasons: ['RISK_HIGH', 'PURCHASE'] },
          error: {
            code: 'OUTCOME_UNKNOWN',
            message: 'The checkout was interrupted after it was submitted.',
            retryable: false,
            reason: 'ORDER_UNKNOWN',
            params: { step: 'Fixture Shop' },
          },
        },
      ]),
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'The checkout was interrupted after it was submitted.',
        retryable: false,
        reason: 'ORDER_UNKNOWN',
        params: { step: 'Fixture Shop' },
      },
      canRetry: true,
    });
  }

  /* ---- assemble */
  const summaries: TaskSummary[] = details.map(summaryOf);
  const pendingApprovals = approvals.filter((a) => a.status === 'PENDING');
  return {
    ...f,
    me: {
      ...f.me,
      preferences: {
        ...f.me.preferences,
        spending: { ...f.me.preferences.spending, monthlyPurchaseLimitUsd: limitUsd },
      },
    },
    assistantStatus: {
      ...f.assistantStatus,
      capabilities: {
        ...f.assistantStatus.capabilities,
        mail: true,
        calendar: true,
        browser: true,
        booking: true,
        shopping: true,
        purchases: limitUsd > 0,
      },
    },
    connections: [...f.connections, google, microsoft],
    providers: [providerInfo('google', true), providerInfo('microsoft', true), SMTP_INFO, WEB_INFO],
    tasks: [...summaries, ...f.tasks],
    taskDetails: { ...f.taskDetails, ...Object.fromEntries(details.map((d) => [d.id, d])) },
    approvals: [...pendingApprovals, ...f.approvals],
    home: {
      ...f.home,
      upcoming,
      pendingApprovals: [...pendingApprovals, ...f.home.pendingApprovals],
    },
    emailWatches: watches,
    orders: [orderPlaced, orderUnknown, orderFailed],
    bookings: [booking],
    evidenceArtifacts: Object.values(art),
    evidenceFiles: files,
  };
}
