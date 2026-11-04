/**
 * Phase B fixtures (skills, schedules, webhooks, time zones, attachments, conversations) and
 * the read model the mock API derives from them — the same shapes the real API sends, validated
 * against the contracts when the mock loads them.
 *
 *   withConversations(f, locale, now)  adds a few multi-turn conversations (follow-ups, a
 *                                      clarifying question, a document, a scheduled run)
 *   conversationOf(state, id)          ConversationDetail assembled like conversations/read.ts
 */
import type {
  Attachment,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  ConversationTurn,
  Recurrence,
  Schedule,
  ScheduleRun,
  Skill,
  TaskDetail,
  TaskSummary,
  TimeZoneInfo,
  WebhookDelivery,
  WebhookEndpoint,
} from '@jarvis/contracts';
import { isTerminal, SCHEDULE_LIMITS, WEBHOOK_LIMITS } from '@jarvis/contracts';
import { evidence, msg, text, type FixtureLocale, type Fixtures } from './fixtures';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ ids */

/** Another valid UUID for the same object (e.g. a task's own conversation, its messages). */
export function derivedId(id: string, salt: number): string {
  const hex = '0123456789abcdef';
  const flip = (c: string, by: number) => hex[(hex.indexOf(c) + by) % 16]!;
  return flip(id[0]!, salt) + flip(id[1]!, salt * 3) + id.slice(2);
}

export const PB = {
  // Conversation A: summary → "send it to Bob" (question) → the address (awaiting approval)
  convA: 'aa000001-0000-4000-8000-00000000000a',
  a1: 'aa000001-0000-4000-8000-0000000000a1',
  a1Fetch: 'aa000001-0000-4000-8000-000000000a11',
  a1Summarize: 'aa000001-0000-4000-8000-000000000a12',
  a2: 'aa000001-0000-4000-8000-0000000000a2',
  a2Clarify: 'aa000001-0000-4000-8000-000000000a21',
  a3: 'aa000001-0000-4000-8000-0000000000a3',
  a3Recall: 'aa000001-0000-4000-8000-000000000a31',
  a3Email: 'aa000001-0000-4000-8000-000000000a32',
  a3Approval: 'aa000001-0000-4000-8000-000000000a33',
  // Conversation B: "summarize the document" without a file (question: document)
  convB: 'bb000001-0000-4000-8000-00000000000b',
  b1: 'bb000001-0000-4000-8000-0000000000b1',
  b1Clarify: 'bb000001-0000-4000-8000-000000000b11',
  // Conversation C: a PDF summarized, then "email it to me"
  convC: 'cc000001-0000-4000-8000-00000000000c',
  c1: 'cc000001-0000-4000-8000-0000000000c1',
  c1Analyze: 'cc000001-0000-4000-8000-000000000c11',
  c2: 'cc000001-0000-4000-8000-0000000000c2',
  c2Recall: 'cc000001-0000-4000-8000-000000000c21',
  c2Email: 'cc000001-0000-4000-8000-000000000c22',
  attachmentPdf: 'cc000001-0000-4000-8000-00000000f001',
  attachmentCsv: 'cc000001-0000-4000-8000-00000000f002',
  // Conversation D: the runs of the weekly schedule
  convD: 'dd000001-0000-4000-8000-00000000000d',
  d1: 'dd000001-0000-4000-8000-0000000000d1',
  // Schedules
  scheduleWeekly: '5c000001-0000-4000-8000-000000000001',
  scheduleMonthly: '5c000001-0000-4000-8000-000000000002',
  schedulePaused: '5c000001-0000-4000-8000-000000000003',
  runA: '5c000001-0000-4000-8000-000000000f01',
  runB: '5c000001-0000-4000-8000-000000000f02',
  // Webhooks
  webhookOps: '3b000001-0000-4000-8000-000000000001',
  webhookOld: '3b000001-0000-4000-8000-000000000002',
} as const;

/* ------------------------------------------------------------------ skills */

type SkillSeed = Omit<Skill, 'available' | 'unavailableReason' | 'enabled'> & {
  enabled?: boolean;
};

const SKILL_SEEDS: SkillSeed[] = [
  {
    id: 'web-research',
    version: '1.1.0',
    status: 'implemented',
    canToggle: true,
    tools: ['web.fetch', 'text.summarize'],
    plannedTools: ['browser.navigate'],
    permissions: ['web:read'],
    maxRisk: 'LOW',
    requiredConnections: ['web'],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: null,
    docsPath: 'docs/skills/web-research.md',
  },
  {
    id: 'email-management',
    version: '1.1.0',
    status: 'implemented',
    canToggle: true,
    tools: ['email.send'],
    plannedTools: ['email.read', 'email.draft'],
    permissions: ['email:send'],
    maxRisk: 'MEDIUM',
    requiredConnections: ['smtp'],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: null,
    docsPath: 'docs/skills/email-management.md',
  },
  {
    id: 'document-analysis',
    version: '1.0.0',
    status: 'implemented',
    canToggle: true,
    tools: ['document.analyze'],
    plannedTools: [],
    permissions: ['files:read'],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: 200_000,
    docsPath: 'docs/skills/document-analysis.md',
  },
  {
    id: 'task-scheduling',
    version: '1.0.0',
    status: 'implemented',
    canToggle: true,
    tools: ['schedule.create'],
    plannedTools: [],
    permissions: ['schedules:write'],
    maxRisk: 'MEDIUM',
    requiredConnections: [],
    modelUse: 'none',
    maxCostPerRunMicroUsd: null,
    docsPath: 'docs/skills/task-scheduling.md',
  },
  {
    id: 'personal-memory',
    version: '1.1.0',
    status: 'implemented',
    canToggle: true,
    tools: ['memory.save'],
    plannedTools: [],
    permissions: ['memory:write'],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'none',
    maxCostPerRunMicroUsd: null,
    docsPath: 'docs/skills/personal-memory.md',
  },
  {
    id: 'translation',
    version: '1.0.0',
    status: 'implemented',
    canToggle: true,
    tools: ['text.translate'],
    plannedTools: [],
    permissions: [],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'required',
    maxCostPerRunMicroUsd: 100_000,
    docsPath: 'docs/skills/translation.md',
  },
  {
    id: 'workflow-planning',
    version: '1.2.0',
    status: 'implemented',
    canToggle: false,
    tools: ['assistant.answer', 'assistant.clarify', 'conversation.recall'],
    plannedTools: [],
    permissions: [],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: null,
    docsPath: 'docs/skills/workflow-planning.md',
  },
  ...(
    [
      ['calendar-management', ['calendar.read', 'calendar.write'], 'MEDIUM'],
      ['appointment-booking', ['booking.search', 'booking.book'], 'HIGH'],
      ['phone-calling', ['phone.call'], 'HIGH'],
      ['shopping-assistant', ['shop.search', 'shop.purchase'], 'CRITICAL'],
      ['device-automation', ['device.run'], 'HIGH'],
    ] as const
  ).map(([id, plannedTools, maxRisk]): SkillSeed => ({
    id,
    version: '0.0.0',
    status: 'planned',
    canToggle: false,
    enabled: false,
    tools: [],
    plannedTools: [...plannedTools],
    permissions: [],
    maxRisk,
    requiredConnections: [],
    modelUse: 'required',
    maxCostPerRunMicroUsd: null,
    docsPath: `docs/skills/${id}.md`,
  })),
];

/** The catalog with real availability for this fixture account (SkillService.list rules). */
export function skillsFor(
  state: Pick<Fixtures, 'me' | 'connections' | 'assistantStatus'>,
): Skill[] {
  const disabled = new Set(state.me.preferences.skills.disabled);
  const connected = new Set(
    state.connections.filter((c) => c.status === 'active').map((c) => c.provider),
  );
  const modelAvailable = state.assistantStatus.planner.mode === 'model';
  const storage = state.assistantStatus.capabilities.attachments !== false;
  return SKILL_SEEDS.map((seed) => {
    const enabled =
      seed.status === 'planned'
        ? false
        : seed.id === 'personal-memory'
          ? state.me.preferences.memory.enabled
          : !disabled.has(seed.id);
    const missing = seed.requiredConnections.filter((c) => !connected.has(c));
    let status = seed.status;
    let reason: Skill['unavailableReason'] = null;
    if (seed.status === 'planned') reason = 'PLANNED';
    else if (seed.id === 'personal-memory' && !enabled) reason = 'MEMORY_DISABLED';
    else if (!enabled) reason = 'DISABLED_BY_USER';
    else if (missing.length > 0) {
      status = 'needs_connection';
      reason = 'CONNECTION_REQUIRED';
    } else if (seed.modelUse === 'required' && !modelAvailable) reason = 'MODEL_REQUIRED';
    else if (seed.id === 'document-analysis' && !storage) reason = 'STORAGE_NOT_CONFIGURED';
    const { enabled: _ignored, ...rest } = seed;
    return { ...rest, status, enabled, available: reason === null, unavailableReason: reason };
  });
}

/* ------------------------------------------------------------------ time zones */

/** Like GET /v1/meta/time-zones: zones Node knows (Intl), with their offset right now. */
export function timeZoneList(now = Date.now()): TimeZoneInfo[] {
  const zones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  return [...zones].sort().map((id) => ({ id, utcOffsetMinutes: offsetMinutes(id, now) }));
}

export function offsetMinutes(zone: string, at: number): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? '');
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/* ------------------------------------------------------------------ recurrence (mock math) */

const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 } as const;

/** Local calendar date (y, m, d) of an instant in a zone. */
function localDate(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The instant of a wall-clock time in a zone (good enough for previews in visual tests). */
function zonedInstant(y: number, m: number, d: number, time: string, zone: string): number {
  const [h, min] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, min);
  return guess - offsetMinutes(zone, guess) * MIN;
}

/**
 * The next `limit` occurrences after `after` (daily / weekly / monthly with interval, until and
 * count left to the real server; previews here only need to look right).
 */
export function nextOccurrences(r: Recurrence, after: number, limit: number): string[] {
  const out: string[] = [];
  const start = localDate(after, r.timeZone);
  const base = Date.UTC(start.y, start.m - 1, start.d);
  const interval = r.interval ?? 1;
  for (let i = 0; out.length < limit && i < 800; i++) {
    const day = new Date(base + i * DAY);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    let match = false;
    if (r.frequency === 'daily') match = i % interval === 0;
    else if (r.frequency === 'weekly') {
      const week = Math.floor(i / 7);
      match =
        week % interval === 0 &&
        (r.byWeekday ?? []).some((w) => WEEKDAY_INDEX[w] === day.getUTCDay());
    } else {
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const months = (y - start.y) * 12 + (m - start.m);
      match =
        months % interval === 0 &&
        (r.byMonthDay ?? []).some((md) => (md === -1 ? d === lastDay : md === d));
    }
    if (!match) continue;
    const at = zonedInstant(y, m, d, r.time, r.timeZone);
    if (at > after) out.push(new Date(at).toISOString());
  }
  return out;
}

export function rruleFor(r: Recurrence, at: number): string {
  const days = r.byWeekday?.length ? `;BYDAY=${r.byWeekday.join(',')}` : '';
  const monthDays = r.byMonthDay?.length ? `;BYMONTHDAY=${r.byMonthDay.join(',')}` : '';
  const [h, m] = r.time.split(':');
  const d = localDate(at, r.timeZone);
  const date = `${d.y}${String(d.m).padStart(2, '0')}${String(d.d).padStart(2, '0')}`;
  return `DTSTART;TZID=${r.timeZone}:${date}T${h}${m}00\nRRULE:FREQ=${r.frequency.toUpperCase()};INTERVAL=${r.interval ?? 1}${days}${monthDays};BYHOUR=${Number(h)};BYMINUTE=${Number(m)};BYSECOND=0`;
}

/* ------------------------------------------------------------------ copy */

interface PhaseBCopy {
  scheduleWeeklyTitle: string;
  scheduleWeeklyRequest: string;
  scheduleMonthlyTitle: string;
  scheduleMonthlyRequest: string;
  schedulePausedTitle: string;
  schedulePausedRequest: string;
  a1Request: string;
  a1Summary: string;
  a2Request: string;
  a3Request: string;
  b1Request: string;
  c1Request: string;
  c1Summary: string;
  c2Request: string;
  webhookDescription: string;
}

const BOB = 'bob.martin@example.com';
const URL_AI_ACT = 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai';

export const PHASE_B_COPY: Record<FixtureLocale, PhaseBCopy> = {
  en: {
    scheduleWeeklyTitle: 'Weekly AI Act summary',
    scheduleWeeklyRequest: `Summarize ${URL_AI_ACT} and email it to me`,
    scheduleMonthlyTitle: 'Month-end expense reminder',
    scheduleMonthlyRequest: 'Email me: submit the expense report before the books close',
    schedulePausedTitle: 'Morning WCAG news',
    schedulePausedRequest: 'Summarize https://www.w3.org/WAI/news/ and email it to me',
    a1Request: `Summarize ${URL_AI_ACT}`,
    a1Summary:
      'The AI Act is the first comprehensive legal framework on AI worldwide. Systems with unacceptable risk are banned; high-risk systems must meet strict requirements. Most obligations apply two years after entry into force.',
    a2Request: 'Send it to Bob',
    a3Request: `Bob is ${BOB}`,
    b1Request: 'Summarize the document',
    c1Request: 'Summarize the attached quarterly report',
    c1Summary:
      'Revenue grew 12% to €4.2 million, driven by the new subscription plans. Operating costs rose 5%, mainly for hiring. The board approved the expansion into Austria for the first quarter.',
    c2Request: 'Email it to me',
    webhookDescription: 'Ops dashboard',
  },
  de: {
    scheduleWeeklyTitle: 'Wöchentliche Zusammenfassung zum AI Act',
    scheduleWeeklyRequest: `Fasse ${URL_AI_ACT} zusammen und schick sie mir per E-Mail`,
    scheduleMonthlyTitle: 'Erinnerung Spesenabrechnung zum Monatsende',
    scheduleMonthlyRequest: 'Schick mir: Spesenabrechnung vor dem Monatsabschluss einreichen',
    schedulePausedTitle: 'WCAG-Neuigkeiten am Morgen',
    schedulePausedRequest: 'Fasse https://www.w3.org/WAI/news/ zusammen und schick sie mir',
    a1Request: `Fasse ${URL_AI_ACT} zusammen`,
    a1Summary:
      'Das KI-Gesetz ist der weltweit erste umfassende Rechtsrahmen für KI. Systeme mit unannehmbarem Risiko sind verboten; Hochrisikosysteme müssen strenge Anforderungen erfüllen. Die meisten Pflichten greifen zwei Jahre nach Inkrafttreten.',
    a2Request: 'Schick das an Bob',
    a3Request: `Bob ist ${BOB}`,
    b1Request: 'Fasse das Dokument zusammen',
    c1Request: 'Fasse den angehängten Quartalsbericht zusammen',
    c1Summary:
      'Der Umsatz stieg um 12 % auf 4,2 Mio. €, getragen von den neuen Abo-Tarifen. Die Betriebskosten stiegen um 5 %, vor allem durch Neueinstellungen. Der Vorstand hat die Expansion nach Österreich für das erste Quartal beschlossen.',
    c2Request: 'Schick mir das',
    webhookDescription: 'Ops-Dashboard',
  },
  ar: {
    scheduleWeeklyTitle: 'ملخص أسبوعي لقانون الذكاء الاصطناعي',
    scheduleWeeklyRequest: `لخّص ${URL_AI_ACT} وأرسله لي بالبريد`,
    scheduleMonthlyTitle: 'تذكير بتقرير المصروفات في نهاية الشهر',
    scheduleMonthlyRequest: 'أرسل لي: قدّم تقرير المصروفات قبل إقفال الحسابات',
    schedulePausedTitle: 'أخبار WCAG الصباحية',
    schedulePausedRequest: 'لخّص https://www.w3.org/WAI/news/ وأرسله لي',
    a1Request: `لخّص ${URL_AI_ACT}`,
    a1Summary:
      'قانون الذكاء الاصطناعي هو أول إطار قانوني شامل للذكاء الاصطناعي في العالم. تُحظر الأنظمة ذات المخاطر غير المقبولة، ويجب أن تستوفي الأنظمة عالية المخاطر متطلبات صارمة. يسري معظم الالتزامات بعد عامين من دخوله حيز التنفيذ.',
    a2Request: 'أرسله إلى بوب',
    a3Request: `عنوان بوب هو ${BOB}`,
    b1Request: 'لخّص المستند',
    c1Request: 'لخّص التقرير الفصلي المرفق',
    c1Summary:
      'نمت الإيرادات بنسبة 12٪ لتصل إلى 4.2 مليون يورو بفضل خطط الاشتراك الجديدة. وارتفعت تكاليف التشغيل بنسبة 5٪ ويعود ذلك أساسًا إلى التوظيف. ووافق مجلس الإدارة على التوسع في النمسا خلال الربع الأول.',
    c2Request: 'أرسله لي',
    webhookDescription: 'لوحة العمليات',
  },
};

/* ------------------------------------------------------------------ base additions */

export interface PhaseBState {
  attachments: Attachment[];
  /** Messages the server stored (when absent, the mock derives them from the tasks). */
  messages: ConversationMessage[];
  skills: Skill[];
  schedules: Schedule[];
  scheduleRuns: Record<string, ScheduleRun[]>;
  webhooks: WebhookEndpoint[];
  webhookDeliveries: Record<string, WebhookDelivery[]>;
  timeZones: TimeZoneInfo[];
}

/** Schedules, webhooks and time zones every fixture account has. */
export function basePhaseB(
  f: Pick<Fixtures, 'me' | 'connections' | 'assistantStatus'>,
  locale: FixtureLocale,
  now: number,
): PhaseBState {
  const c = PHASE_B_COPY[locale];
  const at = (offset: number) => new Date(now + offset).toISOString();
  const tz = f.me.timeZone;
  const weekly: Recurrence = {
    frequency: 'weekly',
    interval: 1,
    byWeekday: ['MO'],
    time: '09:00',
    timeZone: tz,
  };
  const monthly: Recurrence = {
    frequency: 'monthly',
    interval: 1,
    byMonthDay: [-1],
    time: '16:30',
    timeZone: tz,
  };
  const paused: Recurrence = {
    frequency: 'weekly',
    interval: 1,
    byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'],
    time: '07:45',
    timeZone: 'America/New_York',
  };
  const schedules: Schedule[] = [
    {
      id: PB.scheduleWeekly,
      title: c.scheduleWeeklyTitle,
      request: c.scheduleWeeklyRequest,
      language: locale,
      recurrence: weekly,
      rrule: rruleFor(weekly, now - 30 * DAY),
      status: 'active',
      pausedReason: null,
      nextRunAt: nextOccurrences(weekly, now, 1)[0] ?? null,
      lastRunAt: at(-2 * DAY),
      lastTaskId: PB.d1,
      conversationId: PB.convD,
      runCount: 4,
      consecutiveFailures: 0,
      createdBy: 'agent',
      createdAt: at(-30 * DAY),
      updatedAt: at(-2 * DAY),
    },
    {
      id: PB.scheduleMonthly,
      title: c.scheduleMonthlyTitle,
      request: c.scheduleMonthlyRequest,
      language: locale,
      recurrence: monthly,
      rrule: rruleFor(monthly, now - 10 * DAY),
      status: 'active',
      pausedReason: null,
      nextRunAt: nextOccurrences(monthly, now, 1)[0] ?? null,
      lastRunAt: null,
      lastTaskId: null,
      conversationId: null,
      runCount: 0,
      consecutiveFailures: 0,
      createdBy: 'user',
      createdAt: at(-10 * DAY),
      updatedAt: at(-10 * DAY),
    },
    {
      id: PB.schedulePaused,
      title: c.schedulePausedTitle,
      request: c.schedulePausedRequest,
      language: locale,
      recurrence: paused,
      rrule: rruleFor(paused, now - 20 * DAY),
      status: 'paused',
      pausedReason: 'failures',
      nextRunAt: null,
      lastRunAt: at(-1 * DAY),
      lastTaskId: null,
      conversationId: null,
      runCount: 9,
      consecutiveFailures: SCHEDULE_LIMITS.failuresBeforePause,
      createdBy: 'user',
      createdAt: at(-20 * DAY),
      updatedAt: at(-1 * DAY),
    },
  ];
  const webhooks: WebhookEndpoint[] = [
    {
      id: PB.webhookOps,
      url: 'https://hooks.haddad.example/jarvis/events',
      description: c.webhookDescription,
      eventTypes: ['task.completed', 'task.failed', 'approval.requested'],
      status: 'active',
      disabledReason: null,
      secretHint: 'whsec_…x7Qa',
      consecutiveFailures: 0,
      lastDeliveryAt: at(-8 * MIN),
      lastSuccessAt: at(-8 * MIN),
      lastFailureAt: at(-3 * DAY),
      createdAt: at(-14 * DAY),
      updatedAt: at(-8 * MIN),
    },
    {
      id: PB.webhookOld,
      url: 'https://staging.haddad.example/webhooks/jarvis',
      description: null,
      eventTypes: ['task.created', 'task.completed'],
      status: 'disabled',
      disabledReason: 'failures',
      secretHint: 'whsec_…m2Rd',
      consecutiveFailures: WEBHOOK_LIMITS.disableAfterFailedDeliveries,
      lastDeliveryAt: at(-2 * DAY),
      lastSuccessAt: at(-9 * DAY),
      lastFailureAt: at(-2 * DAY),
      createdAt: at(-40 * DAY),
      updatedAt: at(-2 * DAY),
    },
  ];
  const delivery = (
    id: number,
    endpointId: string,
    eventType: WebhookDelivery['eventType'],
    status: WebhookDelivery['status'],
    offset: number,
    extra: Partial<WebhookDelivery> = {},
  ): WebhookDelivery => {
    const deliveryId = `3d000001-0000-4000-8000-${String(id).padStart(12, '0')}`;
    return {
      id: deliveryId,
      endpointId,
      eventType,
      webhookId: `msg_${deliveryId}`,
      status,
      attempts: 1,
      maxAttempts: WEBHOOK_LIMITS.maxAttempts,
      nextAttemptAt: null,
      lastAttemptAt: at(offset),
      responseStatus: status === 'succeeded' ? 200 : null,
      failureReason: null,
      durationMs: 184,
      createdAt: at(offset),
      completedAt: status === 'pending' ? null : at(offset),
      ...extra,
    };
  };
  return {
    attachments: [],
    messages: [],
    skills: skillsFor(f),
    schedules,
    scheduleRuns: {},
    webhooks,
    webhookDeliveries: {
      [PB.webhookOps]: [
        delivery(1, PB.webhookOps, 'task.completed', 'succeeded', -8 * MIN),
        delivery(2, PB.webhookOps, 'approval.requested', 'succeeded', -9 * MIN, {
          durationMs: 211,
        }),
        delivery(3, PB.webhookOps, 'task.failed', 'failed', -3 * DAY, {
          attempts: WEBHOOK_LIMITS.maxAttempts,
          responseStatus: 502,
          failureReason: 'HTTP_ERROR',
          durationMs: 1402,
        }),
      ],
      [PB.webhookOld]: [
        delivery(4, PB.webhookOld, 'task.completed', 'failed', -2 * DAY, {
          attempts: WEBHOOK_LIMITS.maxAttempts,
          responseStatus: null,
          failureReason: 'TIMEOUT',
          durationMs: 10_000,
        }),
      ],
    },
    timeZones: timeZoneList(now),
  };
}

/* ------------------------------------------------------------------ conversations */

/** A task's summary as the API sends it (conversation, outcome, attachments always present). */
export function summaryOf(d: TaskDetail): TaskSummary {
  return {
    id: d.id,
    title: d.title,
    titleMessage: d.titleMessage ?? null,
    request: d.request,
    status: d.status,
    riskLevel: d.riskLevel,
    source: d.source,
    progress: d.progress,
    pendingApprovalId: d.pendingApprovalId,
    pendingApproval: d.pendingApproval ?? null,
    resultSummary: d.resultSummary,
    resultSummaryMessage: d.resultSummaryMessage ?? null,
    error: d.error,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    completedAt: d.completedAt,
    conversationId: d.conversationId,
    outcome: d.outcome ?? null,
    question: d.question ?? null,
    scheduleId: d.scheduleId ?? null,
    attachmentCount: d.attachments?.length ?? d.attachmentCount ?? 0,
  };
}

/** What JARVIS said when a task completed (what executor.ts stores), or null. */
function replyOf(d: TaskDetail): ConversationMessage | null {
  if (d.status !== 'COMPLETED') return null;
  const base = {
    id: derivedId(d.id, 7),
    role: 'assistant' as const,
    language: null,
    taskId: d.id,
    attachments: [],
    createdAt: d.completedAt ?? d.updatedAt,
  };
  if (d.outcome === 'question' && d.question) {
    return { ...base, kind: 'question', text: d.question.text, textMessage: d.question.message };
  }
  if (d.outcome === 'answer' || (d.outcome == null && d.answer)) {
    const summary = [...d.steps].reverse().find((s) => s.output?.summary)?.output?.summary;
    const body = d.answer ?? (typeof summary === 'string' ? summary : d.resultSummary);
    if (body) return { ...base, kind: 'answer', text: body, textMessage: null };
  }
  if (d.resultSummary || d.resultSummaryMessage) {
    return {
      ...base,
      kind: 'result',
      text: d.resultSummary ?? '',
      textMessage: d.resultSummaryMessage ?? null,
    };
  }
  return null;
}

function requestOf(d: TaskDetail): ConversationMessage {
  return {
    id: derivedId(d.id, 5),
    role: 'user',
    kind: 'request',
    text: d.request,
    textMessage: null,
    language: null,
    taskId: d.id,
    attachments: d.attachments ?? [],
    createdAt: d.createdAt,
  };
}

/** Conversation id of a task: its summary's (the detail's if the summary has none). */
function conversationIdOf(state: Fixtures, task: TaskSummary): string {
  return task.conversationId ?? state.taskDetails[task.id]?.conversationId ?? derivedId(task.id, 9);
}

/** The tasks of a conversation, oldest first. */
export function tasksOf(state: Fixtures, conversationId: string): TaskSummary[] {
  return state.tasks
    .filter((t) => conversationIdOf(state, t) === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function summaryFor(state: Fixtures, id: string): ConversationSummary | null {
  const tasks = tasksOf(state, id);
  const first = tasks[0];
  const last = tasks[tasks.length - 1];
  if (!first || !last) return null;
  const schedule = state.schedules.find((s) => s.conversationId === id);
  const updatedAt = tasks
    .map((t) => t.updatedAt)
    .sort()
    .at(-1)!;
  const detailOrSummary = (t: TaskSummary) => {
    const d = state.taskDetails[t.id];
    return d ? summaryOf(d) : t;
  };
  return {
    id,
    title: first.title,
    titleMessage: first.titleMessage ?? null,
    taskCount: tasks.length,
    lastTask: detailOrSummary(last),
    hasActiveTask: tasks.some((t) => !isTerminal(t.status)),
    scheduleId: schedule?.id ?? null,
    createdAt: first.createdAt,
    updatedAt,
  };
}

/** Every conversation, most recent activity first (GET /v1/conversations). */
export function conversationList(state: Fixtures, q = ''): ConversationSummary[] {
  const ids = [...new Set(state.tasks.map((t) => conversationIdOf(state, t)))];
  const needle = q.trim().toLocaleLowerCase();
  return ids
    .map((id) => summaryFor(state, id))
    .filter((c): c is ConversationSummary => c !== null)
    .filter(
      (c) =>
        !needle ||
        c.title.toLocaleLowerCase().includes(needle) ||
        tasksOf(state, c.id).some((t) => t.request.toLocaleLowerCase().includes(needle)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** GET /v1/conversations/:id — turns of the tasks, oldest first. */
export function conversationOf(state: Fixtures, id: string): ConversationDetail | null {
  const summary = summaryFor(state, id);
  if (!summary) return null;
  const turns: ConversationTurn[] = [];
  for (const task of tasksOf(state, id)) {
    const d = state.taskDetails[task.id];
    const stored = state.messages.filter((m) => m.taskId === task.id);
    const request =
      stored.find((m) => m.role === 'user') ??
      (d ? requestOf(d) : { ...requestOf({ ...(task as TaskDetail), attachments: [] }) });
    turns.push({ type: 'user_message', message: request });
    turns.push({ type: 'task', task: d ? summaryOf(d) : task });
    const reply = stored.find((m) => m.role === 'assistant') ?? (d ? replyOf(d) : null);
    if (reply) turns.push({ type: 'assistant_message', message: reply });
  }
  const active = tasksOf(state, id).find((t) => !isTerminal(t.status)) ?? null;
  return {
    ...summary,
    turns,
    earlierCursor: null,
    canFollowUp: active === null,
    activeTaskId: active?.id ?? null,
  };
}

/* ------------------------------------------------------------------ rich conversations */

const EMAIL = 'layla.haddad@example.com';

/**
 * Adds multi-turn conversations to the fixture account:
 *   A  summary → "send it to Bob" (JARVIS asks for the address) → the address (awaiting approval)
 *   B  "summarize the document" without a file (JARVIS asks for it; latest turn)
 *   C  a PDF summarized, then "email it to me" (sent), files attached
 *   D  a run of the weekly schedule
 */
export function withConversations(f: Fixtures, locale: FixtureLocale, now: number): Fixtures {
  const c = PHASE_B_COPY[locale];
  const at = (offset: number) => new Date(now + offset).toISOString();
  const host = 'digital-strategy.ec.europa.eu';
  const said = (m: ReturnType<typeof msg>) => ({ text: text(locale, m), message: m });

  const step = (
    id: string,
    position: number,
    toolId: TaskDetail['steps'][number]['toolId'],
    title: ReturnType<typeof said>,
    t0: number,
    extra: Partial<TaskDetail['steps'][number]> = {},
  ): TaskDetail['steps'][number] => ({
    id,
    position,
    title: title.text,
    titleMessage: title.message,
    toolId,
    riskLevel: 'LOW',
    status: 'SUCCEEDED',
    requiresApproval: false,
    policy: { decision: 'allow', reasons: ['RISK_LOW'] },
    inputPreview: {},
    output: {},
    evidence: [],
    attempts: 1,
    startedAt: at(t0),
    completedAt: at(t0 + 2 * SEC),
    error: null,
    ...extra,
  });

  const detail = (
    d: Omit<
      TaskDetail,
      | 'objective'
      | 'objectiveMessage'
      | 'approvals'
      | 'events'
      | 'cost'
      | 'canCancel'
      | 'canRetry'
      | 'startedAt'
      | 'pendingApprovalId'
      | 'pendingApproval'
      | 'error'
      | 'riskLevel'
      | 'planner'
      | 'answer'
      | 'evidence'
    > &
      Partial<TaskDetail>,
  ): TaskDetail => ({
    objective: null,
    objectiveMessage: null,
    approvals: [],
    events: [],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    canCancel: !isTerminal(d.status),
    canRetry: false,
    startedAt: d.createdAt,
    pendingApprovalId: null,
    pendingApproval: null,
    error: null,
    riskLevel: 'LOW',
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    evidence: d.steps.flatMap((s) => s.evidence),
    ...d,
  });

  // ---- A: summary, then a question, then the answer (awaiting approval)
  const a1Title = said(msg('plan.summarize', { host }));
  const a1T0 = -3 * HOUR;
  const a1 = detail({
    id: PB.a1,
    conversationId: PB.convA,
    title: a1Title.text,
    titleMessage: a1Title.message,
    request: c.a1Request,
    status: 'COMPLETED',
    outcome: 'answer',
    source: 'text',
    progress: { completed: 2, total: 2 },
    resultSummary: c.a1Summary,
    resultSummaryMessage: null,
    createdAt: at(a1T0),
    updatedAt: at(a1T0 + 6 * SEC),
    completedAt: at(a1T0 + 6 * SEC),
    attachments: [],
    steps: [
      step(PB.a1Fetch, 0, 'web.fetch', said(msg('step.fetch', { host })), a1T0, {
        inputPreview: { url: URL_AI_ACT },
        evidence: [evidence.http(URL_AI_ACT, 200, 'text/html', 48213, at(a1T0 + 2 * SEC))],
      }),
      step(PB.a1Summarize, 1, 'text.summarize', said(msg('step.summarize')), a1T0 + 3 * SEC, {
        output: { summary: c.a1Summary },
        evidence: [evidence.extractive(3, 9120, 0, at(a1T0 + 5 * SEC))],
      }),
    ],
  });
  const a2T0 = -2 * HOUR;
  const question = {
    text: text(locale, msg('question.recipient')),
    message: msg('question.recipient'),
    missing: ['recipient' as const],
  };
  const a2Title = said(msg('plan.clarify'));
  const a2 = detail({
    id: PB.a2,
    conversationId: PB.convA,
    title: a2Title.text,
    titleMessage: a2Title.message,
    request: c.a2Request,
    status: 'COMPLETED',
    outcome: 'question',
    question,
    source: 'text',
    progress: { completed: 1, total: 1 },
    resultSummary: question.text,
    resultSummaryMessage: question.message,
    createdAt: at(a2T0),
    updatedAt: at(a2T0 + 2 * SEC),
    completedAt: at(a2T0 + 2 * SEC),
    attachments: [],
    steps: [
      step(PB.a2Clarify, 0, 'assistant.clarify', said(msg('step.clarify')), a2T0, {
        inputPreview: { missing: ['recipient'] },
        evidence: [
          {
            kind: 'note',
            label: 'Question asked',
            value: 'recipient',
            at: at(a2T0 + SEC),
            code: 'QUESTION_ASKED',
            params: { missing: 'recipient' },
          },
        ],
      }),
    ],
  });
  const a3T0 = -90 * MIN;
  const a3Title = said(msg('plan.emailResult', { title: a1Title.message }));
  const recall = said(msg('step.recall'));
  const emailStep = said(msg('step.emailResult'));
  const subject = text(locale, msg('plan.summarize', { host }));
  const a3Approval = {
    id: PB.a3Approval,
    taskId: PB.a3,
    taskTitle: a3Title.text,
    taskTitleMessage: a3Title.message,
    stepId: PB.a3Email,
    toolId: 'email.send' as const,
    status: 'PENDING' as const,
    riskLevel: 'MEDIUM' as const,
    summary: text(locale, msg('approval.email', { subject, recipients: BOB })),
    summaryMessage: msg('approval.email', { subject, recipients: BOB }),
    details: {
      kind: 'email' as const,
      from: EMAIL,
      to: [BOB],
      subject,
      body: c.a1Summary,
    },
    actionHash: 'sha256:a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3',
    reasons: ['RISK_MEDIUM', 'RECIPIENT_EXTERNAL'],
    expiresAt: at(a3T0 + 24 * HOUR),
    decidedAt: null,
    decisionNote: null,
    createdAt: at(a3T0 + 4 * SEC),
  };
  const a3 = detail({
    id: PB.a3,
    conversationId: PB.convA,
    title: a3Title.text,
    titleMessage: a3Title.message,
    request: c.a3Request,
    status: 'AWAITING_APPROVAL',
    outcome: null,
    riskLevel: 'MEDIUM',
    source: 'text',
    progress: { completed: 1, total: 2 },
    pendingApprovalId: PB.a3Approval,
    pendingApproval: { id: PB.a3Approval, untrustedSource: false },
    resultSummary: null,
    resultSummaryMessage: null,
    createdAt: at(a3T0),
    updatedAt: at(a3T0 + 4 * SEC),
    completedAt: null,
    attachments: [],
    approvals: [a3Approval],
    steps: [
      step(PB.a3Recall, 0, 'conversation.recall', recall, a3T0, {
        inputPreview: { taskId: PB.a1 },
        evidence: [
          {
            kind: 'record',
            label: 'Earlier result used',
            value: PB.a1,
            at: at(a3T0 + SEC),
            code: 'RECALLED_RESULT',
            params: { taskId: PB.a1 },
          },
        ],
      }),
      step(PB.a3Email, 1, 'email.send', emailStep, a3T0 + 2 * SEC, {
        riskLevel: 'MEDIUM',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM', 'RECIPIENT_EXTERNAL'] },
        inputPreview: { to: [BOB], subject, body: '{{s1.text}}' },
        output: null,
        startedAt: null,
        completedAt: null,
        attempts: 0,
      }),
    ],
  });

  // ---- B: a question that wants a file (the latest turn)
  const b1T0 = -25 * MIN;
  const bQuestion = {
    text: text(locale, msg('question.document')),
    message: msg('question.document'),
    missing: ['document' as const],
  };
  const b1 = detail({
    id: PB.b1,
    conversationId: PB.convB,
    title: a2Title.text,
    titleMessage: a2Title.message,
    request: c.b1Request,
    status: 'COMPLETED',
    outcome: 'question',
    question: bQuestion,
    source: 'text',
    progress: { completed: 1, total: 1 },
    resultSummary: bQuestion.text,
    resultSummaryMessage: bQuestion.message,
    createdAt: at(b1T0),
    updatedAt: at(b1T0 + 2 * SEC),
    completedAt: at(b1T0 + 2 * SEC),
    attachments: [],
    steps: [
      step(PB.b1Clarify, 0, 'assistant.clarify', said(msg('step.clarify')), b1T0, {
        inputPreview: { missing: ['document'] },
      }),
    ],
  });

  // ---- C: a document summarized, then emailed
  const c1T0 = -6 * HOUR;
  const pdf: Attachment = {
    id: PB.attachmentPdf,
    filename:
      locale === 'ar'
        ? 'التقرير-الفصلي-الربع-الثالث.pdf'
        : locale === 'de'
          ? 'Quartalsbericht-Q3.pdf'
          : 'Q3-board-report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1_284_312,
    sha256: '9f2c1e7a4b8d0f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a',
    conversationId: PB.convC,
    pageCount: 14,
    textChars: 38_412,
    downloadPath: `/v1/attachments/${PB.attachmentPdf}/content`,
    expiresAt: null,
    createdAt: at(c1T0 - MIN),
  };
  const csv: Attachment = {
    id: PB.attachmentCsv,
    filename: 'revenue-by-plan.csv',
    mediaType: 'text/csv',
    sizeBytes: 18_204,
    sha256: '1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a2c',
    conversationId: PB.convC,
    pageCount: 1,
    textChars: 18_002,
    downloadPath: `/v1/attachments/${PB.attachmentCsv}/content`,
    expiresAt: null,
    createdAt: at(c1T0 - MIN),
  };
  const docTitle = said(msg('plan.summarizeDocument', { name: pdf.filename }));
  const c1 = detail({
    id: PB.c1,
    conversationId: PB.convC,
    title: docTitle.text,
    titleMessage: docTitle.message,
    request: c.c1Request,
    status: 'COMPLETED',
    outcome: 'answer',
    source: 'text',
    progress: { completed: 1, total: 1 },
    resultSummary: c.c1Summary,
    resultSummaryMessage: null,
    createdAt: at(c1T0),
    updatedAt: at(c1T0 + 9 * SEC),
    completedAt: at(c1T0 + 9 * SEC),
    attachments: [pdf, csv],
    steps: [
      step(
        PB.c1Analyze,
        0,
        'document.analyze',
        said(msg('step.summarizeDocument', { name: pdf.filename })),
        c1T0,
        {
          inputPreview: { attachmentId: pdf.id, mode: 'summary', language: locale },
          output: { summary: c.c1Summary, pages: 14 },
          evidence: [
            {
              kind: 'record',
              label: 'Document read',
              value: `${pdf.filename}: 14 pages`,
              at: at(c1T0 + 5 * SEC),
              code: 'DOCUMENT_EXTRACTED',
              params: {
                attachmentId: pdf.id,
                mediaType: pdf.mediaType,
                pages: 14,
                chars: 38_412,
                truncated: 0,
              },
            },
            evidence.hash(pdf.sha256, at(c1T0 + 5 * SEC)),
            evidence.extractive(3, 38_412, 0, at(c1T0 + 8 * SEC)),
          ],
        },
      ),
    ],
  });
  const c2T0 = -5 * HOUR;
  const c2Title = said(msg('plan.emailResult', { title: docTitle.message }));
  const c2Result = said(msg('result.emailSent', { subject: docTitle.text, recipients: EMAIL }));
  const c2 = detail({
    id: PB.c2,
    conversationId: PB.convC,
    title: c2Title.text,
    titleMessage: c2Title.message,
    request: c.c2Request,
    status: 'COMPLETED',
    outcome: 'action',
    riskLevel: 'MEDIUM',
    source: 'voice',
    progress: { completed: 2, total: 2 },
    resultSummary: c2Result.text,
    resultSummaryMessage: c2Result.message,
    createdAt: at(c2T0),
    updatedAt: at(c2T0 + 70 * SEC),
    completedAt: at(c2T0 + 70 * SEC),
    attachments: [],
    steps: [
      step(PB.c2Recall, 0, 'conversation.recall', recall, c2T0, {
        inputPreview: { taskId: PB.c1 },
      }),
      step(PB.c2Email, 1, 'email.send', emailStep, c2T0 + 60 * SEC, {
        riskLevel: 'MEDIUM',
        policy: {
          decision: 'allow',
          reasons: ['RISK_MEDIUM', 'RECIPIENT_SELF', 'AUTO_APPROVED_SELF'],
        },
        inputPreview: { to: [EMAIL], subject: docTitle.text },
        output: { accepted: [EMAIL] },
        evidence: [
          evidence.smtp(
            '250 2.0.0 Ok: queued as 7HkQ2x',
            '<5b1e-c2@jarvis.haddad.example>',
            1,
            1,
            at(c2T0 + 68 * SEC),
          ),
        ],
      }),
    ],
  });

  // ---- D: the weekly schedule's last run
  const d1T0 = -2 * DAY;
  const weekly = f.schedules.find((s) => s.id === PB.scheduleWeekly);
  const dTitle = said(msg('plan.summarizeEmail', { host }));
  const dResult = said(msg('result.emailSent', { subject: dTitle.text, recipients: EMAIL }));
  const d1 = detail({
    id: PB.d1,
    conversationId: PB.convD,
    title: dTitle.text,
    titleMessage: dTitle.message,
    request: weekly?.request ?? c.scheduleWeeklyRequest,
    status: 'COMPLETED',
    outcome: 'action',
    riskLevel: 'MEDIUM',
    source: 'schedule',
    scheduleId: PB.scheduleWeekly,
    progress: { completed: 3, total: 3 },
    resultSummary: dResult.text,
    resultSummaryMessage: dResult.message,
    createdAt: at(d1T0),
    updatedAt: at(d1T0 + 40 * SEC),
    completedAt: at(d1T0 + 40 * SEC),
    attachments: [],
    steps: [],
  });

  const details = [a1, a2, a3, b1, c1, c2, d1];
  const runs: ScheduleRun[] = [
    {
      id: PB.runA,
      occurrenceAt: at(d1T0),
      status: 'created',
      reason: null,
      task: summaryOf(d1),
      createdAt: at(d1T0),
    },
    {
      id: PB.runB,
      occurrenceAt: at(d1T0 - 7 * DAY),
      status: 'skipped',
      reason: 'BUDGET_EXHAUSTED',
      task: null,
      createdAt: at(d1T0 - 7 * DAY),
    },
  ];
  return {
    ...f,
    tasks: [...f.tasks, ...details.map(summaryOf)],
    taskDetails: {
      ...f.taskDetails,
      ...Object.fromEntries(details.map((d) => [d.id, d])),
    },
    approvals: [...f.approvals, a3Approval],
    attachments: [...f.attachments, pdf, csv],
    scheduleRuns: { ...f.scheduleRuns, [PB.scheduleWeekly]: runs },
  };
}
