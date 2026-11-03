/**
 * Realistic fixture data for visual / component tests (never used by the app itself). User
 * generated content (requests, titles, email bodies) exists in en/de/ar; everything is
 * validated against the contract schemas when the mock API loads it (see mock-api.ts), so the
 * mocks cannot drift from the real API.
 */
import type {
  AdminOverview,
  Approval,
  AssistantStatus,
  Connection,
  HomeSnapshot,
  Me,
  Memory,
  Notification,
  SessionInfo,
  TaskDetail,
  TaskSummary,
  UsageSummary,
} from '@jarvis/contracts';

export type FixtureLocale = 'en' | 'de' | 'ar';

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

interface LocalizedContent {
  emailRequest: string;
  emailTitle: string;
  emailSummary: string;
  emailSubject: string;
  emailBody: string;
  memoryRequest: string;
  memoryTitle: string;
  memoryResult: string;
  failedRequest: string;
  failedTitle: string;
  failedError: string;
  runningRequest: string;
  runningTitle: string;
}

const CONTENT: Record<FixtureLocale, LocalizedContent> = {
  en: {
    emailRequest:
      'Summarize the EU AI Act overview at https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai and email it to me',
    emailTitle: 'Summarize the EU AI Act overview and email it to me',
    emailSummary:
      'Send an email to layla.haddad@example.com with the subject “Summary: EU AI Act overview”.',
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
    memoryTitle: 'Remember: aisle seats on flights',
    memoryResult: 'Saved to memory: you prefer aisle seats on flights.',
    failedRequest: 'Summarize http://intranet.haddad.internal/q3-board-report',
    failedTitle: 'Summarize the Q3 board report',
    failedError: 'This address points to a private network, so JARVIS will not fetch it.',
    runningRequest: 'Read https://www.w3.org/TR/WCAG22/ and summarize what changed in WCAG 2.2',
    runningTitle: 'Summarize what changed in WCAG 2.2',
  },
  de: {
    emailRequest:
      'Fasse die Übersicht zum EU AI Act unter https://digital-strategy.ec.europa.eu/de/policies/regulatory-framework-ai zusammen und schick sie mir per E-Mail',
    emailTitle: 'Übersicht zum EU AI Act zusammenfassen und per E-Mail senden',
    emailSummary:
      'Eine E-Mail an layla.haddad@example.com mit dem Betreff „Zusammenfassung: Übersicht zum EU AI Act“ senden.',
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
    memoryRequest: 'Merk dir, dass ich auf Flügen Gangplätze bevorzuge',
    memoryTitle: 'Merken: Gangplatz auf Flügen',
    memoryResult: 'Im Gedächtnis gespeichert: Gangplätze auf Flügen werden bevorzugt.',
    failedRequest: 'Fasse http://intranet.haddad.internal/q3-vorstandsbericht zusammen',
    failedTitle: 'Q3-Vorstandsbericht zusammenfassen',
    failedError:
      'Diese Adresse verweist auf ein privates Netzwerk, daher ruft JARVIS sie nicht ab.',
    runningRequest:
      'Lies https://www.w3.org/TR/WCAG22/ und fasse zusammen, was sich in WCAG 2.2 geändert hat',
    runningTitle: 'Änderungen in WCAG 2.2 zusammenfassen',
  },
  ar: {
    emailRequest:
      'لخّص نظرة عامة على قانون الذكاء الاصطناعي الأوروبي في https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai وأرسله لي بالبريد',
    emailTitle: 'تلخيص نظرة عامة على قانون الذكاء الاصطناعي الأوروبي وإرسالها بالبريد',
    emailSummary:
      'إرسال رسالة إلى layla.haddad@example.com بعنوان «ملخص: قانون الذكاء الاصطناعي الأوروبي».',
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
    memoryRequest: 'تذكّر أنني أفضّل المقاعد بجانب الممر في الرحلات الجوية',
    memoryTitle: 'تذكّر: مقعد بجانب الممر في الرحلات',
    memoryResult: 'حُفظ في الذاكرة: تفضّل المقاعد بجانب الممر في الرحلات الجوية.',
    failedRequest: 'لخّص http://intranet.haddad.internal/q3-board-report',
    failedTitle: 'تلخيص تقرير مجلس الإدارة للربع الثالث',
    failedError: 'يشير هذا العنوان إلى شبكة خاصة، لذا لن يجلبه JARVIS.',
    runningRequest: 'اقرأ https://www.w3.org/TR/WCAG22/ ولخّص ما تغيّر في WCAG 2.2',
    runningTitle: 'تلخيص التغييرات في WCAG 2.2',
  },
};

export interface Fixtures {
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
    preferences: {
      voice: { speakResponses: false, recognitionLocale: 'auto' },
      autonomy: { autoApproveEmailToSelf: false },
      ai: { allowExternalModels: true },
      notifications: { approvalRequested: true, taskCompleted: true, taskFailed: true },
      spending: { monthlyAiBudgetUsd: 20 },
      memory: { enabled: true },
    },
    createdAt: at(-21 * 24 * HOUR),
  };

  const offline = (options.planner ?? 'offline') === 'offline';
  const assistantStatus: AssistantStatus = {
    planner: offline
      ? { mode: 'offline', provider: null, reason: 'NO_API_KEY' }
      : { mode: 'model', provider: 'anthropic', reason: null },
    worker: { healthy: options.workerHealthy ?? true, lastHeartbeatAt: at(-8_000) },
    capabilities: { webFetch: true, email: true, memory: true, generalQuestions: !offline },
    version: '0.1.0',
  };

  const approval: Approval = {
    id: IDS.approval,
    taskId: IDS.taskEmail,
    taskTitle: c.emailTitle,
    stepId: IDS.stepEmail,
    toolId: 'email.send',
    status: 'PENDING',
    riskLevel: 'MEDIUM',
    summary: c.emailSummary,
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
    title: c.emailTitle,
    request: c.emailRequest,
    status: 'AWAITING_APPROVAL',
    riskLevel: 'MEDIUM',
    source: 'text',
    progress: { completed: 2, total: 3 },
    pendingApprovalId: IDS.approval,
    resultSummary: null,
    error: null,
    createdAt: at(-9 * MIN),
    updatedAt: at(-8 * MIN),
    completedAt: null,
  };
  const runningTask: TaskSummary = {
    id: IDS.taskRunning,
    title: c.runningTitle,
    request: c.runningRequest,
    status: 'RUNNING',
    riskLevel: 'LOW',
    source: 'voice',
    progress: { completed: 1, total: 2 },
    pendingApprovalId: null,
    resultSummary: null,
    error: null,
    createdAt: at(-40_000),
    updatedAt: at(-12_000),
    completedAt: null,
  };
  const memoryTask: TaskSummary = {
    id: IDS.taskMemory,
    title: c.memoryTitle,
    request: c.memoryRequest,
    status: 'COMPLETED',
    riskLevel: 'LOW',
    source: 'text',
    progress: { completed: 1, total: 1 },
    pendingApprovalId: null,
    resultSummary: c.memoryResult,
    error: null,
    createdAt: at(-2 * HOUR - 3 * MIN),
    updatedAt: at(-2 * HOUR - 2 * MIN),
    completedAt: at(-2 * HOUR - 2 * MIN),
  };
  const failedTask: TaskSummary = {
    id: IDS.taskFailed,
    title: c.failedTitle,
    request: c.failedRequest,
    status: 'FAILED',
    riskLevel: 'LOW',
    source: 'text',
    progress: { completed: 0, total: 2 },
    pendingApprovalId: null,
    resultSummary: null,
    error: { code: 'FETCH_BLOCKED', message: c.failedError, retryable: false },
    createdAt: at(-26 * HOUR),
    updatedAt: at(-26 * HOUR + 4_000),
    completedAt: at(-26 * HOUR + 4_000),
  };
  const tasks = [runningTask, emailTask, memoryTask, failedTask];

  const emailDetail: TaskDetail = {
    ...emailTask,
    objective: c.emailTitle,
    conversationId: IDS.conversation,
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    steps: [
      {
        id: IDS.stepFetch,
        position: 0,
        title:
          locale === 'de'
            ? 'Webseite lesen'
            : locale === 'ar'
              ? 'قراءة صفحة الويب'
              : 'Read the web page',
        toolId: 'web.fetch',
        riskLevel: 'LOW',
        status: 'SUCCEEDED',
        requiresApproval: false,
        policy: { decision: 'allow', reasons: ['RISK_LOW'] },
        inputPreview: {
          url: 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
        },
        output: { title: 'AI Act | Shaping Europe’s digital future', bytes: 48213 },
        evidence: [
          {
            kind: 'http_response',
            label: 'HTTP 200',
            value: 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
            at: at(-8 * MIN - 40_000),
          },
          {
            kind: 'content_hash',
            label: 'Content SHA-256',
            value: 'sha256:5d2f8c1a9e3b7d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c6e0b4d8f2a6c0e4b8d2f',
            at: at(-8 * MIN - 40_000),
          },
        ],
        attempts: 1,
        startedAt: at(-8 * MIN - 42_000),
        completedAt: at(-8 * MIN - 40_000),
        error: null,
      },
      {
        id: IDS.stepSummarize,
        position: 1,
        title: locale === 'de' ? 'Zusammenfassen' : locale === 'ar' ? 'التلخيص' : 'Summarize',
        toolId: 'text.summarize',
        riskLevel: 'LOW',
        status: 'SUCCEEDED',
        requiresApproval: false,
        policy: { decision: 'allow', reasons: ['RISK_LOW'] },
        inputPreview: { source: '{{s1.text}}', maxSentences: 5 },
        output: { sentences: 4 },
        evidence: [],
        attempts: 1,
        startedAt: at(-8 * MIN - 39_000),
        completedAt: at(-8 * MIN - 38_000),
        error: null,
      },
      {
        id: IDS.stepEmail,
        position: 2,
        title:
          locale === 'de' ? 'E-Mail senden' : locale === 'ar' ? 'إرسال البريد' : 'Send the email',
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
  };

  const notifications: Notification[] = [
    {
      id: IDS.notificationApproval,
      kind: 'approval_requested',
      taskId: IDS.taskEmail,
      data: { taskTitle: c.emailTitle, approvalId: IDS.approval },
      readAt: null,
      createdAt: at(-8 * MIN),
    },
    {
      id: IDS.notificationCompleted,
      kind: 'task_completed',
      taskId: IDS.taskMemory,
      data: { taskTitle: c.memoryTitle },
      readAt: at(-HOUR),
      createdAt: at(-2 * HOUR - 2 * MIN),
    },
    {
      id: IDS.notificationFailed,
      kind: 'task_failed',
      taskId: IDS.taskFailed,
      data: { taskTitle: c.failedTitle, errorCode: 'FETCH_BLOCKED' },
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
      content: c.memoryResult.replace(/^[^:：]+[:：]\s*/, ''),
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
      queueDepth: 1,
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
