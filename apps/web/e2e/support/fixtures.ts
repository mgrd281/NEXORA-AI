/**
 * Realistic fixture data for visual / component tests (never used by the app itself). User
 * generated content (requests, email bodies) exists in en/de/ar; everything is validated
 * against the contract schemas when the mock API loads it (see mock-api.ts), so the mocks
 * cannot drift from the real API.
 *
 * Like the real API with the offline planner, server-written text comes twice: as a localizable
 * message ({ key, params }: titleMessage, objectiveMessage, summaryMessage,
 * resultSummaryMessage) and as plain text in the request's language (`text()` below renders the
 * same message for that). Errors carry code + reason + params with an English developer
 * message; evidence carries its code + params next to the English label / value.
 */
import type {
  AdminOverview,
  Approval,
  AssistantStatus,
  Connection,
  Evidence,
  HomeSnapshot,
  Me,
  Memory,
  Notification,
  ServerMessage,
  ServerMessageParam,
  SessionInfo,
  TaskDetail,
  TaskSummary,
  UsageSummary,
} from '@jarvis/contracts';
import { catalogs } from '../../src/i18n/messages';
import { basePhaseB, derivedId, type PhaseBState } from './phase-b';
import { basePhaseC, type PhaseCState } from './phase-c';
import { basePhaseD, type PhaseDState } from './phase-d';
import { renderServerMessage } from '../../src/i18n/server-message';
import { createTranslator, stripIsolates } from '../../src/i18n/translate';

export type FixtureLocale = 'en' | 'de' | 'ar';

/** A server sentence as the API sends it. */
export function msg(
  key: ServerMessage['key'],
  params: Record<string, ServerMessageParam> = {},
): ServerMessage {
  return { key, params };
}

/** The stored plain text of a server sentence: rendered in the request's language. */
export function text(locale: FixtureLocale, message: ServerMessage): string {
  const t = createTranslator(locale, catalogs[locale]);
  const rendered = renderServerMessage({ t, messages: catalogs[locale] }, message);
  if (rendered === null) throw new Error(`Fixture message ${message.key} does not render`);
  return stripIsolates(rendered);
}

/** A server sentence with its stored text: `{ title, titleMessage }` and the like. */
function said(locale: FixtureLocale, message: ServerMessage) {
  return { text: text(locale, message), message };
}

/** The evidence the tools record (apps/api/src/modules/agent/tools/*): code + params first. */
export const evidence = {
  http(url: string, status: number, contentType: string, bytes: number, at: string): Evidence {
    return {
      kind: 'http_response',
      label: `HTTP ${status}`,
      value: `GET ${url} → ${status} (${contentType}, ${bytes} bytes)`,
      at,
      code: 'HTTP_RESPONSE',
      params: { method: 'GET', url, status, contentType, bytes },
    };
  },
  hash(hex: string, at: string): Evidence {
    return {
      kind: 'content_hash',
      label: 'SHA-256 of the response body',
      value: `sha256:${hex}`,
      at,
      code: 'CONTENT_HASH',
      params: { algorithm: 'SHA-256', hash: hex },
    };
  },
  extractive(sentences: number, chars: number, excludedSentences: number, at: string): Evidence {
    return {
      kind: 'note',
      label: 'Extractive summary',
      value: `${sentences} key sentences from ${chars} characters; no AI model was used.`,
      at,
      code: 'EXTRACTIVE_SUMMARY',
      params: { sentences, chars, excludedSentences },
    };
  },
  smtp(response: string, messageId: string, accepted: number, total: number, at: string) {
    const replyCode = Number(response.slice(0, 3));
    return {
      kind: 'smtp_receipt',
      label: `SMTP ${replyCode} · ${accepted} accepted`,
      value: `${response} · Message-ID ${messageId}`,
      at,
      code: 'SMTP_RECEIPT',
      params: { replyCode, accepted, total, response, messageId },
    } satisfies Evidence;
  },
  model(model: string, inputTokens: number, outputTokens: number, at: string): Evidence {
    return {
      kind: 'model_output',
      label: model,
      value: `${inputTokens} input / ${outputTokens} output tokens`,
      at,
      code: 'MODEL_OUTPUT',
      params: { model, inputTokens, outputTokens },
    };
  },
  memory(memoryId: string, kind: 'fact' | 'preference', at: string): Evidence {
    return {
      kind: 'record',
      label: 'Memory saved',
      value: `memory ${memoryId} (${kind})`,
      at,
      code: 'MEMORY_RECORD',
      params: { memoryId, kind },
    };
  },
};

const MIN = 60_000;
const HOUR = 60 * MIN;

export const IDS = {
  tenant: '0b6f8a3e-2c51-4d7a-9e10-5f3c2a1b7d01',
  user: '1c7e9b4f-3d62-4e8b-8f21-6a4d3b2c8e02',
  session: '2d8fac50-4e73-4f9c-9a32-7b5e4c3d9f03',
  taskEmail: '3e90bd61-5f84-4a0d-8b43-8c6f5d4e0a04',
  taskMemory: '4fa1ce72-6a95-4b1e-9c54-9d7a6e5f1b05',
  taskFailed: '50b2df83-7ba6-4c2f-8d65-ae8b7f6a2c06',
  taskRunning: '61c3e094-8cb7-4d30-9e76-bf9c8a7b3d07',
  approval: '72d4f1a5-9dc8-4e41-8f87-c0ad9b8c4e08',
  stepFetch: '83e502b6-aed9-4f52-9098-d1beac9d5f09',
  stepSummarize: '94f613c7-bfea-4063-81a9-e2cfbdae6a10',
  stepEmail: 'a50724d8-c0fb-4174-92ba-f3d0cebf7b11',
  stepMemory: 'b61835e9-d10c-4285-a3cb-04e1dfc08c12',
  stepFailedFetch: 'c7294610-e21d-4396-b4dc-15f2e0d19d13',
  conversation: 'd83a5721-f32e-44a7-85ed-2603f1e2ae14',
  notificationApproval: 'e94b6832-0a3f-45b8-96fe-3714a2f3bf15',
  notificationCompleted: 'fa5c7943-1b40-46c9-a70f-4825b304c016',
  notificationFailed: '0b6d8a54-2c51-47da-b810-5936c415d117',
  connectionWeb: '1c7e9b65-3d62-48eb-8921-6a47d526e218',
  connectionSmtp: '2d8fac76-4e73-49fc-9a32-7b58e637f319',
  memorySeat: '3e90bd87-5f84-4a0d-8b43-8c69f748041a',
} as const;

/** What the user wrote (requests, the note to remember) and what JARVIS wrote (the email). */
interface LocalizedContent {
  emailRequest: string;
  emailSubject: string;
  emailBody: string;
  memoryRequest: string;
  /** The words the offline planner keeps from the request ("Remember that …"). */
  memoryText: string;
  failedRequest: string;
  runningRequest: string;
}

export const URL_AI_ACT =
  'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai';

export const HOSTS = {
  aiAct: 'digital-strategy.ec.europa.eu',
  intranet: 'intranet.haddad.internal',
  wcag: 'www.w3.org',
} as const;

/** The web.fetch SSRF guard's developer message (English in every locale, never shown). */
const PRIVATE_ADDRESS_MESSAGE = `Refusing to fetch ${HOSTS.intranet}: it resolves to a private or local network address.`;

const CONTENT: Record<FixtureLocale, LocalizedContent> = {
  en: {
    emailRequest:
      'Summarize the EU AI Act overview at https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai and email it to me',
    emailSubject: 'Summary: EU AI Act overview',
    emailBody: [
      'Summary of “AI Act | Shaping Europe’s digital future” (digital-strategy.ec.europa.eu):',
      '',
      '• The AI Act is the first comprehensive legal framework on AI worldwide. It sets risk-based rules for developers and deployers of AI systems.',
      '• Systems with unacceptable risk, such as social scoring, are banned. High-risk systems must meet strict requirements before they can be placed on the market.',
      '• Transparency obligations apply to AI that interacts with people, for example chatbots, and to generated content.',
      '• The rules apply in stages; most obligations take effect two years after entry into force.',
      '',
      'Source: https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
    ].join('\n'),
    memoryRequest: 'Remember that I prefer aisle seats on flights',
    memoryText: 'I prefer aisle seats on flights',
    failedRequest: 'Summarize http://intranet.haddad.internal/q3-board-report',
    runningRequest: 'Read https://www.w3.org/TR/WCAG22/ and summarize what changed in WCAG 2.2',
  },
  de: {
    emailRequest:
      'Fasse die Übersicht zum EU AI Act unter https://digital-strategy.ec.europa.eu/de/policies/regulatory-framework-ai zusammen und schick sie mir per E-Mail',
    emailSubject: 'Zusammenfassung: Übersicht zum EU AI Act',
    emailBody: [
      'Zusammenfassung von „KI-Gesetz | Gestaltung der digitalen Zukunft Europas“ (digital-strategy.ec.europa.eu):',
      '',
      '• Das KI-Gesetz ist der weltweit erste umfassende Rechtsrahmen für KI. Es legt risikobasierte Regeln für Anbieter und Betreiber von KI-Systemen fest.',
      '• Systeme mit unannehmbarem Risiko, etwa Social Scoring, sind verboten. Hochrisikosysteme müssen strenge Anforderungen erfüllen, bevor sie in Verkehr gebracht werden.',
      '• Transparenzpflichten gelten für KI, die mit Menschen interagiert, etwa Chatbots, sowie für generierte Inhalte.',
      '• Die Regeln gelten schrittweise; die meisten Pflichten greifen zwei Jahre nach Inkrafttreten.',
      '',
      'Quelle: https://digital-strategy.ec.europa.eu/de/policies/regulatory-framework-ai',
    ].join('\n'),
    memoryRequest: 'Merk dir: Ich bevorzuge Gangplätze auf Flügen',
    memoryText: 'Ich bevorzuge Gangplätze auf Flügen',
    failedRequest: 'Fasse http://intranet.haddad.internal/q3-vorstandsbericht zusammen',
    runningRequest:
      'Lies https://www.w3.org/TR/WCAG22/ und fasse zusammen, was sich in WCAG 2.2 geändert hat',
  },
  ar: {
    emailRequest:
      'لخّص نظرة عامة على قانون الذكاء الاصطناعي الأوروبي في https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai وأرسله لي بالبريد',
    emailSubject: 'ملخص: قانون الذكاء الاصطناعي الأوروبي',
    emailBody: [
      'ملخص صفحة «قانون الذكاء الاصطناعي | تشكيل المستقبل الرقمي لأوروبا» (digital-strategy.ec.europa.eu):',
      '',
      '• قانون الذكاء الاصطناعي هو أول إطار قانوني شامل للذكاء الاصطناعي في العالم، ويضع قواعد قائمة على المخاطر لمطوّري أنظمة الذكاء الاصطناعي ومستخدميها.',
      '• تُحظر الأنظمة ذات المخاطر غير المقبولة مثل التصنيف الاجتماعي، ويجب أن تستوفي الأنظمة عالية المخاطر متطلبات صارمة قبل طرحها في السوق.',
      '• تنطبق التزامات الشفافية على أنظمة الذكاء الاصطناعي التي تتفاعل مع الناس، مثل روبوتات المحادثة، وعلى المحتوى المُولَّد.',
      '• تُطبَّق القواعد على مراحل، ويسري معظم الالتزامات بعد عامين من دخول القانون حيز التنفيذ.',
      '',
      'المصدر: https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
    ].join('\n'),
    memoryRequest: 'تذكّر: أفضّل المقاعد بجانب الممر في الرحلات الجوية',
    memoryText: 'أفضّل المقاعد بجانب الممر في الرحلات الجوية',
    failedRequest: 'لخّص http://intranet.haddad.internal/q3-board-report',
    runningRequest: 'اقرأ https://www.w3.org/TR/WCAG22/ ولخّص ما تغيّر في WCAG 2.2',
  },
};

export interface Fixtures extends PhaseBState, PhaseCState, PhaseDState {
  me: Me;
  assistantStatus: AssistantStatus;
  tasks: TaskSummary[];
  taskDetails: Record<string, TaskDetail>;
  approvals: Approval[];
  notifications: Notification[];
  connections: Connection[];
  memories: Memory[];
  usage: UsageSummary;
  sessions: SessionInfo[];
  adminOverview: AdminOverview;
  home: HomeSnapshot;
}

export interface FixtureOptions {
  locale?: FixtureLocale;
  /** Reference time for all timestamps (default: now). */
  now?: number;
  /** Planner mode shown by the assistant status (default offline: no API key here). */
  planner?: 'offline' | 'model';
  workerHealthy?: boolean;
  admin?: boolean;
  /** me.theme (the shell mirrors it into the theme cookie). */
  theme?: 'system' | 'light' | 'dark';
}

export function buildFixtures(options: FixtureOptions = {}): Fixtures {
  const locale = options.locale ?? 'en';
  const now = options.now ?? Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const c = CONTENT[locale];
  const email = 'layla.haddad@example.com';

  const me: Me = {
    id: IDS.user,
    email,
    displayName: 'Layla Haddad',
    locale,
    timeZone: 'Europe/Berlin',
    theme: options.theme ?? 'system',
    roles: options.admin === false ? ['owner'] : ['owner', 'platform_admin'],
    tenant: { id: IDS.tenant, name: 'Haddad' },
    phoneNumber: null,
    phoneNumberVerifiedAt: null,
    preferences: {
      voice: {
        speakResponses: false,
        recognitionLocale: 'auto',
        conversationMode: false,
        speakingRate: 1,
        endOfSpeechSilenceMs: 1200,
        voiceNames: { en: null, de: null, ar: null },
      },
      autonomy: { autoApproveEmailToSelf: false },
      ai: { allowExternalModels: true, planningModel: 'balanced' },
      notifications: { approvalRequested: true, taskCompleted: true, taskFailed: true },
      spending: { monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: 0 },
      memory: { enabled: true },
      retention: { memoryDays: null, taskHistoryDays: null },
      skills: { disabled: [] },
    },
    createdAt: at(-21 * 24 * HOUR),
  };

  const offline = (options.planner ?? 'offline') === 'offline';
  const assistantStatus: AssistantStatus = {
    planner: offline
      ? { mode: 'offline', provider: null, reason: 'NO_API_KEY' }
      : { mode: 'model', provider: 'anthropic', reason: null },
    worker: { healthy: options.workerHealthy ?? true, lastHeartbeatAt: at(-8_000) },
    capabilities: {
      webFetch: true,
      email: true,
      memory: true,
      generalQuestions: !offline,
      attachments: true,
      translation: !offline,
      schedules: true,
    },
    version: '0.1.0',
  };

  // What the offline planner writes for these requests (apps/api …/models/offline.ts).
  const emailPlan = {
    title: said(locale, msg('plan.summarizeEmail', { host: HOSTS.aiAct })),
    objective: said(locale, msg('objective.summarizeEmail', { url: URL_AI_ACT, email })),
    fetch: said(locale, msg('step.fetch', { host: HOSTS.aiAct })),
    summarize: said(locale, msg('step.summarize')),
    email: said(locale, msg('step.emailSummary')),
  };
  const approvalSummary = said(
    locale,
    msg('approval.email', { subject: c.emailSubject, recipients: email }),
  );
  const memoryTitle = said(locale, msg('plan.remember', { text: c.memoryText }));
  const memoryResult = said(locale, msg('result.memorySaved', { text: c.memoryText }));
  const failedTitle = said(locale, msg('plan.summarize', { host: HOSTS.intranet }));
  const runningTitle = said(locale, msg('plan.summarize', { host: HOSTS.wcag }));

  const approval: Approval = {
    id: IDS.approval,
    taskId: IDS.taskEmail,
    taskTitle: emailPlan.title.text,
    taskTitleMessage: emailPlan.title.message,
    stepId: IDS.stepEmail,
    toolId: 'email.send',
    status: 'PENDING',
    riskLevel: 'MEDIUM',
    summary: approvalSummary.text,
    summaryMessage: approvalSummary.message,
    details: {
      kind: 'email',
      from: email,
      to: [email],
      subject: c.emailSubject,
      body: c.emailBody,
    },
    actionHash: 'sha256:9c1e4f7a2b6d8e0f3a5c7b9d1e2f4a6c8b0d2e4f6a8c0b2d4e6f8a0c2b4d6e8f',
    reasons: ['RISK_MEDIUM', 'RECIPIENT_SELF'],
    expiresAt: at(23 * HOUR + 52 * MIN),
    decidedAt: null,
    decisionNote: null,
    createdAt: at(-8 * MIN),
  };

  const emailTask: TaskSummary = {
    id: IDS.taskEmail,
    title: emailPlan.title.text,
    titleMessage: emailPlan.title.message,
    request: c.emailRequest,
    status: 'AWAITING_APPROVAL',
    riskLevel: 'MEDIUM',
    source: 'text',
    progress: { completed: 2, total: 3 },
    pendingApprovalId: IDS.approval,
    pendingApproval: { id: IDS.approval, untrustedSource: false },
    resultSummary: null,
    resultSummaryMessage: null,
    error: null,
    createdAt: at(-9 * MIN),
    updatedAt: at(-8 * MIN),
    completedAt: null,
    conversationId: IDS.conversation,
    outcome: null,
    question: null,
    scheduleId: null,
    attachmentCount: 0,
  };
  const runningTask: TaskSummary = {
    id: IDS.taskRunning,
    title: runningTitle.text,
    titleMessage: runningTitle.message,
    request: c.runningRequest,
    status: 'RUNNING',
    riskLevel: 'LOW',
    source: 'voice',
    progress: { completed: 1, total: 2 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: null,
    resultSummaryMessage: null,
    error: null,
    createdAt: at(-40_000),
    updatedAt: at(-12_000),
    completedAt: null,
    conversationId: derivedId(IDS.taskRunning, 9),
    outcome: null,
    question: null,
    scheduleId: null,
    attachmentCount: 0,
  };
  const memoryTask: TaskSummary = {
    id: IDS.taskMemory,
    title: memoryTitle.text,
    titleMessage: memoryTitle.message,
    request: c.memoryRequest,
    status: 'COMPLETED',
    riskLevel: 'LOW',
    source: 'text',
    progress: { completed: 1, total: 1 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: memoryResult.text,
    resultSummaryMessage: memoryResult.message,
    error: null,
    createdAt: at(-2 * HOUR - 3 * MIN),
    updatedAt: at(-2 * HOUR - 2 * MIN),
    completedAt: at(-2 * HOUR - 2 * MIN),
    conversationId: derivedId(IDS.taskMemory, 9),
    outcome: 'action',
    question: null,
    scheduleId: null,
    attachmentCount: 0,
  };
  const failedTask: TaskSummary = {
    id: IDS.taskFailed,
    title: failedTitle.text,
    titleMessage: failedTitle.message,
    request: c.failedRequest,
    status: 'FAILED',
    riskLevel: 'LOW',
    source: 'text',
    // Nothing succeeded; the summarize step was skipped.
    progress: { completed: 0, total: 2 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: null,
    resultSummaryMessage: null,
    error: {
      code: 'FETCH_BLOCKED',
      message: PRIVATE_ADDRESS_MESSAGE,
      retryable: false,
      reason: 'PRIVATE_ADDRESS',
      params: { host: HOSTS.intranet },
    },
    createdAt: at(-26 * HOUR),
    updatedAt: at(-26 * HOUR + 4_000),
    completedAt: at(-26 * HOUR + 4_000),
    conversationId: derivedId(IDS.taskFailed, 9),
    outcome: null,
    question: null,
    scheduleId: null,
    attachmentCount: 0,
  };
  const tasks = [runningTask, emailTask, memoryTask, failedTask];

  const fetchedAt = at(-8 * MIN - 40_000);
  const emailDetail: TaskDetail = {
    ...emailTask,
    objective: emailPlan.objective.text,
    objectiveMessage: emailPlan.objective.message,
    conversationId: IDS.conversation,
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    steps: [
      {
        id: IDS.stepFetch,
        position: 0,
        title: emailPlan.fetch.text,
        titleMessage: emailPlan.fetch.message,
        toolId: 'web.fetch',
        riskLevel: 'LOW',
        status: 'SUCCEEDED',
        requiresApproval: false,
        policy: { decision: 'allow', reasons: ['RISK_LOW'] },
        inputPreview: { url: URL_AI_ACT },
        output: { title: 'AI Act | Shaping Europe’s digital future', bytes: 48213 },
        evidence: [
          evidence.http(URL_AI_ACT, 200, 'text/html; charset=utf-8', 48213, fetchedAt),
          evidence.hash(
            '5d2f8c1a9e3b7d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c6e0b4d8f2a6c0e4b8d2f',
            fetchedAt,
          ),
        ],
        attempts: 1,
        startedAt: at(-8 * MIN - 42_000),
        completedAt: fetchedAt,
        error: null,
      },
      {
        id: IDS.stepSummarize,
        position: 1,
        title: emailPlan.summarize.text,
        titleMessage: emailPlan.summarize.message,
        toolId: 'text.summarize',
        riskLevel: 'LOW',
        status: 'SUCCEEDED',
        requiresApproval: false,
        policy: { decision: 'allow', reasons: ['RISK_LOW'] },
        inputPreview: { source: '{{s1.text}}', maxSentences: 5 },
        output: { sentences: 4 },
        evidence: [evidence.extractive(4, 9120, 0, at(-8 * MIN - 38_000))],
        attempts: 1,
        startedAt: at(-8 * MIN - 39_000),
        completedAt: at(-8 * MIN - 38_000),
        error: null,
      },
      {
        id: IDS.stepEmail,
        position: 2,
        title: emailPlan.email.text,
        titleMessage: emailPlan.email.message,
        toolId: 'email.send',
        riskLevel: 'MEDIUM',
        status: 'AWAITING_APPROVAL',
        requiresApproval: true,
        policy: { decision: 'require_approval', reasons: ['RISK_MEDIUM', 'RECIPIENT_SELF'] },
        inputPreview: { to: [email], subject: c.emailSubject },
        output: null,
        evidence: [],
        attempts: 0,
        startedAt: null,
        completedAt: null,
        error: null,
      },
    ],
    approvals: [approval],
    events: [],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [],
    canCancel: true,
    canRetry: false,
    startedAt: at(-8 * MIN - 42_000),
    attachments: [],
  };

  const notifications: Notification[] = [
    {
      id: IDS.notificationApproval,
      kind: 'approval_requested',
      taskId: IDS.taskEmail,
      data: { taskTitle: emailPlan.title.text, approvalId: IDS.approval },
      readAt: null,
      createdAt: at(-8 * MIN),
    },
    {
      id: IDS.notificationCompleted,
      kind: 'task_completed',
      taskId: IDS.taskMemory,
      data: { taskTitle: memoryTitle.text },
      readAt: at(-HOUR),
      createdAt: at(-2 * HOUR - 2 * MIN),
    },
    {
      id: IDS.notificationFailed,
      kind: 'task_failed',
      taskId: IDS.taskFailed,
      data: { taskTitle: failedTitle.text, errorCode: 'FETCH_BLOCKED' },
      readAt: null,
      createdAt: at(-26 * HOUR + 4_000),
    },
  ];

  const connections: Connection[] = [
    {
      id: IDS.connectionWeb,
      provider: 'web',
      label: 'Web access',
      accountIdentifier: null,
      status: 'active',
      permissions: ['web.fetch'],
      lastVerifiedAt: at(-3 * 24 * HOUR),
      lastError: null,
      expiresAt: null,
      createdAt: at(-20 * 24 * HOUR),
    },
    {
      id: IDS.connectionSmtp,
      provider: 'smtp',
      label: 'Email',
      accountIdentifier: email,
      status: 'active',
      permissions: ['email.send'],
      lastVerifiedAt: at(-26 * HOUR),
      lastError: null,
      expiresAt: null,
      createdAt: at(-20 * 24 * HOUR),
    },
  ];

  const memories: Memory[] = [
    {
      id: IDS.memorySeat,
      kind: 'preference',
      content: c.memoryText,
      source: 'assistant',
      sourceTaskId: IDS.taskMemory,
      createdAt: at(-2 * HOUR - 2 * MIN),
      updatedAt: at(-2 * HOUR - 2 * MIN),
    },
  ];

  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const usage: UsageSummary = {
    periodStart: monthStart.toISOString(),
    periodEnd: monthEnd.toISOString(),
    aiMicroUsd: 0,
    toolMicroUsd: 0,
    totalMicroUsd: 0,
    budgetMicroUsd: 20_000_000,
    tasks: { completed: 1, failed: 1, total: 4 },
  };

  const sessions: SessionInfo[] = [
    {
      id: IDS.session,
      deviceName: null,
      platform: 'web',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      createdAt: at(-3 * 24 * HOUR),
      lastUsedAt: at(-MIN),
      expiresAt: at(27 * 24 * HOUR),
      current: true,
    },
  ];

  const adminOverview: AdminOverview = {
    generatedAt: at(0),
    health: {
      database: true,
      worker: assistantStatus.worker,
      planner: assistantStatus.planner,
      // queueDepth is the deprecated alias of queueReady.
      queueDepth: 0,
      queueReady: 0,
      // Approval expiry timers: scheduled, not backlog.
      queueScheduled: 1,
      oldestReadyAgeMs: null,
    },
    users: { total: 1, active7d: 1 },
    tenants: { total: 1 },
    tasksByStatus: { RUNNING: 1, AWAITING_APPROVAL: 1, COMPLETED: 1, FAILED: 1 },
    toolReliability: [
      { toolId: 'web.fetch', executions: 3, succeeded: 2, failed: 1, p50Ms: 412, p95Ms: 980 },
      { toolId: 'text.summarize', executions: 1, succeeded: 1, failed: 0, p50Ms: 18, p95Ms: 18 },
      { toolId: 'memory.save', executions: 1, succeeded: 1, failed: 0, p50Ms: 9, p95Ms: 9 },
    ],
    cost30dMicroUsd: 0,
  };

  const home: HomeSnapshot = {
    assistant: assistantStatus,
    pendingApprovals: [approval],
    activeTasks: [runningTask, emailTask],
    recentTasks: [memoryTask, failedTask],
    unreadNotifications: notifications.filter((n) => n.readAt === null).length,
    // No connection grants calendar.read: Home shows no "Upcoming" section.
    upcoming: null,
    suggestions: offline
      ? [
          {
            id: 'configure-model',
            kind: 'review',
            messageKey: 'suggest.configureModel',
            command: null,
            href: '/settings#assistant',
          },
        ]
      : [
          {
            id: 'summarize-and-email',
            kind: 'command',
            messageKey: 'suggest.summarizeAndEmail',
            command: null,
            href: null,
          },
        ],
  };

  return {
    ...basePhaseB({ me, connections, assistantStatus }, locale, now),
    ...basePhaseC(),
    ...basePhaseD(),
    me,
    assistantStatus,
    tasks,
    taskDetails: { [IDS.taskEmail]: emailDetail },
    approvals: [approval],
    notifications,
    connections,
    memories,
    usage,
    sessions,
    adminOverview,
    home,
  };
}
