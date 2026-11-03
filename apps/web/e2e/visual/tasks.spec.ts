/**
 * Task Center (/tasks) and task detail (/tasks/[id]) with the contract-validated mock API:
 * visual capture in light + dark × en + de + ar on desktop and mobile, axe on every state, and
 * behaviour checks (filter ↔ URL, Load more, approvals, cancel, retry with the unknown-outcome
 * acknowledgement, streamed answers and live updates over a real SSE stream).
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3101 pnpm --filter @jarvis/web exec playwright test e2e/visual/tasks.spec.ts
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  canRetryTask,
  TaskSummary,
  type Approval,
  type StreamEvent,
  type TaskDetail,
  type TaskEvent,
} from '@jarvis/contracts';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  evidence,
  HOSTS,
  IDS,
  msg,
  text,
  type FixtureLocale,
  type Fixtures,
} from '../support/fixtures';
import { mockApi, signInWithMock, type MockApiOptions } from '../support/mock-api';
import { capture, expectNoSeriousA11yViolations } from '../support/visual';

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'de', 'ar'] as const;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/* ------------------------------------------------------------------ fixtures */

export const TASK_IDS = {
  sent: 'c0a80001-0000-4000-8000-000000000001',
  sentFetch: 'c0a80001-0000-4000-8000-000000000011',
  sentSummarize: 'c0a80001-0000-4000-8000-000000000012',
  sentEmail: 'c0a80001-0000-4000-8000-000000000013',
  sentApproval: 'c0a80001-0000-4000-8000-000000000014',
  unknown: 'c0a80001-0000-4000-8000-000000000002',
  unknownFetch: 'c0a80001-0000-4000-8000-000000000021',
  unknownSummarize: 'c0a80001-0000-4000-8000-000000000022',
  unknownEmail: 'c0a80001-0000-4000-8000-000000000023',
  unknownApproval: 'c0a80001-0000-4000-8000-000000000024',
  blockedFetch: 'c0a80001-0000-4000-8000-000000000031',
  blockedSummarize: 'c0a80001-0000-4000-8000-000000000032',
  runningFetch: 'c0a80001-0000-4000-8000-000000000041',
  runningSummarize: 'c0a80001-0000-4000-8000-000000000042',
  answer: 'c0a80001-0000-4000-8000-000000000005',
  answerStep: 'c0a80001-0000-4000-8000-000000000051',
  older1: 'c0a80001-0000-4000-8000-000000000071',
  older2: 'c0a80001-0000-4000-8000-000000000072',
  older3: 'c0a80001-0000-4000-8000-000000000073',
} as const;

const URL_AI_ACT = 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai';
const URL_WCAG = 'https://www.w3.org/TR/WCAG22/';
const EMAIL = 'layla.haddad@example.com';
const MESSAGE_ID = '<c4f1e2a9-7b3d-4e8a-9f60-2d5c8b1a0e37@jarvis.haddad.example>';
const SHA = 'sha256:5d2f8c1a9e3b7d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c6e0b4d8f2a6c0e4b8d2f';

/**
 * What people and the model wrote (in the request's language). Server sentences (offline plan
 * titles, result lines) are built from messages with the fixtures' msg() / text(), like the API.
 */
interface Copy {
  /** The model-written step title of the answer task. */
  answerStep: string;
  question: string;
  questionTitle: string;
  answer: string;
  answerResult: string;
  /** Older tasks: a note to remember, a newsletter summary (page text) and a note to email. */
  olderNote: string;
  olderSummary: string;
  olderEmail: string;
}

/** English developer messages (the API's AgentError text; never shown to the user). */
const DEV_MESSAGES = {
  sendInterrupted:
    'The mail server stopped responding while the email was being sent, so JARVIS cannot tell whether it was delivered. Check your Sent folder or inbox before retrying.',
  fetchTimeout: 'Fetching www.w3.org timed out after 15 seconds.',
};

const COPY: Record<FixtureLocale, Copy> = {
  en: {
    answerStep: 'Answer the question',
    question: 'What changed between WCAG 2.1 and WCAG 2.2?',
    questionTitle: 'What changed between WCAG 2.1 and 2.2',
    answer: [
      'WCAG 2.2 adds nine success criteria and removes one.',
      '',
      'The new criteria mainly help people with cognitive and motor disabilities and people on mobile devices: Focus Not Obscured (2.4.11, AA), Dragging Movements (2.5.7, AA), Target Size (Minimum) (2.5.8, AA), Consistent Help (3.2.6, A), Redundant Entry (3.3.7, A) and Accessible Authentication (Minimum) (3.3.8, AA). Three more are at level AAA.',
      '',
      '4.1.1 Parsing was removed, because modern browsers and assistive technologies no longer depend on it.',
    ].join('\n'),
    answerResult: 'Answered your question about WCAG 2.2.',
    olderNote: 'My passport expires in March 2027',
    olderSummary:
      'The Q3 newsletter announces offline mode, a new approvals inbox and the end of the legacy API in January.',
    olderEmail: 'Call the dentist on Friday',
  },
  de: {
    answerStep: 'Frage beantworten',
    question: 'Was hat sich zwischen WCAG 2.1 und WCAG 2.2 geändert?',
    questionTitle: 'Änderungen zwischen WCAG 2.1 und 2.2',
    answer: [
      'WCAG 2.2 ergänzt neun Erfolgskriterien und streicht eines.',
      '',
      'Die neuen Kriterien helfen vor allem Menschen mit kognitiven und motorischen Einschränkungen sowie bei mobiler Nutzung: Fokus nicht verdeckt (2.4.11, AA), Ziehbewegungen (2.5.7, AA), Zielgröße (Minimum) (2.5.8, AA), Konsistente Hilfe (3.2.6, A), Redundante Eingabe (3.3.7, A) und Barrierefreie Authentifizierung (Minimum) (3.3.8, AA). Drei weitere gelten für Stufe AAA.',
      '',
      '4.1.1 Syntaxanalyse entfällt, weil moderne Browser und assistive Technologien nicht mehr darauf angewiesen sind.',
    ].join('\n'),
    answerResult: 'Ihre Frage zu WCAG 2.2 wurde beantwortet.',
    olderNote: 'Mein Reisepass läuft im März 2027 ab',
    olderSummary:
      'Der Newsletter für Q3 kündigt den Offlinemodus, einen neuen Freigabe-Eingang und das Ende der alten API im Januar an.',
    olderEmail: 'Freitag Zahnarzt anrufen',
  },
  ar: {
    answerStep: 'الإجابة عن السؤال',
    question: 'ما الذي تغيّر بين WCAG 2.1 وWCAG 2.2؟',
    questionTitle: 'التغييرات بين WCAG 2.1 و2.2',
    answer: [
      'تضيف WCAG 2.2 تسعة معايير نجاح وتحذف معيارًا واحدًا.',
      '',
      'تساعد المعايير الجديدة بشكل خاص ذوي الإعاقات الإدراكية والحركية ومستخدمي الأجهزة المحمولة، ومنها: عدم حجب التركيز (2.4.11، AA)، وحركات السحب (2.5.7، AA)، والحد الأدنى لحجم الهدف (2.5.8، AA)، والمساعدة المتسقة (3.2.6، A)، والإدخال المكرر (3.3.7، A)، والمصادقة الميسّرة (3.3.8، AA). وتنتمي ثلاثة معايير أخرى إلى المستوى AAA.',
      '',
      'أُلغي المعيار 4.1.1 (التحليل) لأن المتصفحات والتقنيات المساعدة الحديثة لم تعد تعتمد عليه.',
    ].join('\n'),
    answerResult: 'تمت الإجابة عن سؤالك حول WCAG 2.2.',
    olderNote: 'ينتهي جواز سفري في مارس 2027',
    olderSummary:
      'تعلن النشرة الإخبارية للربع الثالث عن الوضع دون اتصال وصندوق موافقات جديد وإيقاف الواجهة البرمجية القديمة في يناير.',
    olderEmail: 'الاتصال بطبيب الأسنان يوم الجمعة',
  },
};

let eventSeq = 1000;
function ev(
  taskId: string,
  type: TaskEvent['type'],
  at: string,
  data: Record<string, unknown> = {},
) {
  return { id: String(eventSeq++), taskId, type, at, data } satisfies TaskEvent;
}

/** Adds realistic task details (sent email, unknown outcome, blocked fetch, running, answer). */
export function withTaskDetails(f: Fixtures, locale: FixtureLocale, now: number): Fixtures {
  const c = COPY[locale];
  const at = (offset: number) => new Date(now + offset).toISOString();
  const email = f.taskDetails[IDS.taskEmail]!;
  const approval = f.approvals[0]!;
  const [fetchStep, summarizeStep, emailStep] = email.steps as [
    TaskDetail['steps'][number],
    TaskDetail['steps'][number],
    TaskDetail['steps'][number],
  ];
  // How step events name their step (apps/api …/events-data.ts stepRef).
  const ref = (step: TaskDetail['steps'][number], id = step.id) => ({
    stepId: id,
    toolId: step.toolId,
    title: step.title,
    ...(step.titleMessage ? { titleMessage: step.titleMessage } : {}),
  });

  // ---- Sent: the email task after approval, completed with evidence.
  const sentT0 = -3 * HOUR;
  const sentEvidence = {
    http: evidence.http(URL_AI_ACT, 200, 'text/html; charset=utf-8', 48213, at(sentT0 + 4 * SEC)),
    hash: evidence.hash(SHA.slice('sha256:'.length), at(sentT0 + 4 * SEC)),
    note: evidence.extractive(4, 9120, 0, at(sentT0 + 5 * SEC)),
    smtp: evidence.smtp(
      '250 2.0.0 Ok: queued as 4QzX7b1kT9z',
      MESSAGE_ID,
      1,
      1,
      at(sentT0 + 2 * MIN + 12 * SEC),
    ),
  };
  const sentApproval: Approval = {
    ...approval,
    id: TASK_IDS.sentApproval,
    taskId: TASK_IDS.sent,
    stepId: TASK_IDS.sentEmail,
    status: 'APPROVED',
    createdAt: at(sentT0 + 6 * SEC),
    decidedAt: at(sentT0 + 2 * MIN + 9 * SEC),
    expiresAt: at(sentT0 + 24 * HOUR),
  };
  const subject = approval.details.kind === 'email' ? approval.details.subject : '';
  const sentResult = msg('result.emailSent', { subject, recipients: EMAIL });
  const sentSummary: TaskSummary = {
    id: TASK_IDS.sent,
    title: email.title,
    titleMessage: email.titleMessage,
    request: email.request,
    status: 'COMPLETED',
    riskLevel: 'MEDIUM',
    source: 'text',
    progress: { completed: 3, total: 3 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: text(locale, sentResult),
    resultSummaryMessage: sentResult,
    error: null,
    createdAt: at(sentT0),
    updatedAt: at(sentT0 + 2 * MIN + 14 * SEC),
    completedAt: at(sentT0 + 2 * MIN + 14 * SEC),
  };
  const sentSteps: TaskDetail['steps'] = [
    {
      ...fetchStep,
      id: TASK_IDS.sentFetch,
      inputPreview: { url: URL_AI_ACT },
      output: {
        finalUrl: URL_AI_ACT,
        status: 200,
        title: 'AI Act | Shaping Europe’s digital future',
        contentType: 'text/html; charset=utf-8',
        bytes: 48213,
        sha256: SHA.slice(7),
        suspectedInjection: false,
      },
      evidence: [sentEvidence.http, sentEvidence.hash],
      startedAt: at(sentT0 + 2 * SEC),
      completedAt: at(sentT0 + 4 * SEC),
    },
    {
      ...summarizeStep,
      id: TASK_IDS.sentSummarize,
      inputPreview: { text: '{{s1.text}}', language: locale, maxSentences: 5 },
      output: { method: 'extractive', suspectedInjection: false, excludedSentences: 0 },
      evidence: [sentEvidence.note],
      startedAt: at(sentT0 + 4 * SEC),
      completedAt: at(sentT0 + 5 * SEC),
    },
    {
      ...emailStep,
      id: TASK_IDS.sentEmail,
      status: 'SUCCEEDED',
      output: {
        messageId: MESSAGE_ID,
        accepted: [EMAIL],
        rejected: [],
        response: '250 2.0.0 Ok: queued as 4QzX7b1kT9z',
      },
      evidence: [sentEvidence.smtp],
      attempts: 1,
      startedAt: at(sentT0 + 2 * MIN + 10 * SEC),
      completedAt: at(sentT0 + 2 * MIN + 12 * SEC),
    },
  ];
  // Structured verification results (contracts VerificationCheck).
  const check = (
    step: TaskDetail['steps'][number],
    key: string,
    params: Record<string, string | number>,
    english: string,
  ) => ({ stepId: step.id, step: step.title, key, params, text: english });
  const sentDetail: TaskDetail = {
    ...sentSummary,
    objective: email.objective,
    objectiveMessage: email.objectiveMessage,
    conversationId: email.conversationId,
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    steps: sentSteps,
    approvals: [sentApproval],
    events: [
      ev(TASK_IDS.sent, 'task.created', at(sentT0), { status: 'QUEUED' }),
      ev(TASK_IDS.sent, 'task.status_changed', at(sentT0 + 1 * SEC), {
        from: 'QUEUED',
        to: 'PLANNING',
      }),
      ev(TASK_IDS.sent, 'plan.ready', at(sentT0 + 1 * SEC), {
        stepCount: 3,
        planner: { mode: 'offline', provider: null, model: null },
      }),
      ev(TASK_IDS.sent, 'step.started', at(sentT0 + 2 * SEC), {
        ...ref(sentSteps[0]!),
        attempt: 1,
      }),
      ev(TASK_IDS.sent, 'step.succeeded', at(sentT0 + 4 * SEC), ref(sentSteps[0]!)),
      ev(TASK_IDS.sent, 'step.succeeded', at(sentT0 + 5 * SEC), ref(sentSteps[1]!)),
      ev(TASK_IDS.sent, 'approval.requested', at(sentT0 + 6 * SEC), {
        approvalId: TASK_IDS.sentApproval,
        stepId: TASK_IDS.sentEmail,
        summary: approval.summary,
        summaryMessage: approval.summaryMessage,
      }),
      ev(TASK_IDS.sent, 'approval.decided', at(sentT0 + 2 * MIN + 9 * SEC), {
        approvalId: TASK_IDS.sentApproval,
        decision: 'approved',
      }),
      ev(TASK_IDS.sent, 'step.succeeded', at(sentT0 + 2 * MIN + 12 * SEC), ref(sentSteps[2]!)),
      ev(TASK_IDS.sent, 'verification.passed', at(sentT0 + 2 * MIN + 14 * SEC), {
        checks: [
          check(
            sentSteps[2]!,
            'recipientsAccepted',
            { accepted: 1, count: 1 },
            '1/1 recipients accepted',
          ),
          check(sentSteps[2]!, 'noneRejected', {}, 'No recipients rejected'),
          check(
            sentSteps[2]!,
            'serverResponse',
            { response: '250 2.0.0 Ok: queued as 4QzX7b1kT9z' },
            'Server response: 250 2.0.0 Ok: queued as 4QzX7b1kT9z',
          ),
        ],
      }),
      ev(TASK_IDS.sent, 'task.status_changed', at(sentT0 + 2 * MIN + 14 * SEC), {
        from: 'VERIFYING',
        to: 'COMPLETED',
      }),
    ],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [sentEvidence.http, sentEvidence.hash, sentEvidence.note, sentEvidence.smtp],
    canCancel: false,
    canRetry: false,
    startedAt: at(sentT0 + 1 * SEC),
  };

  // ---- Unknown outcome: the SMTP server went silent after accepting the message.
  const uT0 = -50 * MIN;
  const unknownError = {
    code: 'OUTCOME_UNKNOWN' as const,
    message: DEV_MESSAGES.sendInterrupted,
    retryable: false,
    reason: 'SEND_INTERRUPTED' as const,
  };
  const unknownSummary: TaskSummary = {
    ...sentSummary,
    id: TASK_IDS.unknown,
    status: 'FAILED',
    progress: { completed: 2, total: 3 },
    resultSummary: null,
    resultSummaryMessage: null,
    error: unknownError,
    createdAt: at(uT0),
    updatedAt: at(uT0 + 3 * MIN),
    completedAt: at(uT0 + 3 * MIN),
  };
  const unknownEmailStep: TaskDetail['steps'][number] = {
    ...sentSteps[2]!,
    id: TASK_IDS.unknownEmail,
    status: 'FAILED',
    output: null,
    evidence: [],
    error: unknownError,
    startedAt: at(uT0 + 2 * MIN),
    completedAt: at(uT0 + 3 * MIN),
  };
  const unknownDetail: TaskDetail = {
    ...sentDetail,
    ...unknownSummary,
    steps: [
      { ...sentSteps[0]!, id: TASK_IDS.unknownFetch },
      { ...sentSteps[1]!, id: TASK_IDS.unknownSummarize },
      unknownEmailStep,
    ],
    approvals: [
      {
        ...sentApproval,
        id: TASK_IDS.unknownApproval,
        taskId: TASK_IDS.unknown,
        stepId: TASK_IDS.unknownEmail,
      },
    ],
    events: [
      ev(TASK_IDS.unknown, 'task.created', at(uT0), { status: 'QUEUED' }),
      ev(TASK_IDS.unknown, 'plan.ready', at(uT0 + SEC), {
        stepCount: 3,
        planner: { mode: 'offline', provider: null, model: null },
      }),
      ev(TASK_IDS.unknown, 'approval.decided', at(uT0 + 2 * MIN), {
        approvalId: TASK_IDS.unknownApproval,
        decision: 'approved',
      }),
      ev(TASK_IDS.unknown, 'step.started', at(uT0 + 2 * MIN), {
        ...ref(unknownEmailStep),
        attempt: 1,
      }),
      ev(TASK_IDS.unknown, 'step.failed', at(uT0 + 3 * MIN), {
        ...ref(unknownEmailStep),
        code: unknownError.code,
        message: unknownError.message,
        reason: unknownError.reason,
      }),
      ev(TASK_IDS.unknown, 'task.status_changed', at(uT0 + 3 * MIN), {
        from: 'RUNNING',
        to: 'FAILED',
      }),
    ],
    evidence: [],
    canCancel: false,
    // OUTCOME_UNKNOWN: retry allowed after the user confirms they checked (canRetryTask).
    canRetry: true,
    startedAt: at(uT0 + SEC),
  };

  // ---- Blocked: the existing FETCH_BLOCKED task (a private address). Its remaining step is
  // SKIPPED, and asking differently is the way forward, so there is no retry.
  const failed = f.tasks.find((t) => t.id === IDS.taskFailed)!;
  const failedAt = failed.createdAt;
  const blockedFetchTitle = msg('step.fetch', { host: HOSTS.intranet });
  const blockedFetch: TaskDetail['steps'][number] = {
    id: TASK_IDS.blockedFetch,
    position: 0,
    title: text(locale, blockedFetchTitle),
    titleMessage: blockedFetchTitle,
    toolId: 'web.fetch',
    riskLevel: 'LOW',
    status: 'FAILED',
    requiresApproval: false,
    policy: { decision: 'allow', reasons: ['RISK_LOW'] },
    inputPreview: { url: 'http://intranet.haddad.internal/q3-board-report' },
    output: null,
    evidence: [],
    attempts: 1,
    startedAt: failedAt,
    completedAt: failed.completedAt,
    error: failed.error,
  };
  const blockedDetail: TaskDetail = {
    ...failed,
    objective: text(
      locale,
      msg('objective.summarize', { url: 'http://intranet.haddad.internal/q3-board-report' }),
    ),
    objectiveMessage: msg('objective.summarize', {
      url: 'http://intranet.haddad.internal/q3-board-report',
    }),
    conversationId: IDS.conversation,
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    steps: [
      blockedFetch,
      {
        ...summarizeStep,
        id: TASK_IDS.blockedSummarize,
        position: 1,
        status: 'SKIPPED',
        inputPreview: { text: '{{s1.text}}', language: locale },
        output: null,
        evidence: [],
        attempts: 0,
        startedAt: null,
        completedAt: null,
        error: null,
      },
    ],
    approvals: [],
    events: [
      ev(IDS.taskFailed, 'task.created', failedAt, { status: 'QUEUED' }),
      ev(IDS.taskFailed, 'plan.ready', failedAt, {
        stepCount: 2,
        planner: { mode: 'offline', provider: null, model: null },
      }),
      ev(IDS.taskFailed, 'step.failed', failed.completedAt!, {
        ...ref(blockedFetch),
        code: failed.error!.code,
        message: failed.error!.message,
        reason: failed.error!.reason,
        params: failed.error!.params,
      }),
      ev(IDS.taskFailed, 'task.status_changed', failed.completedAt!, {
        from: 'RUNNING',
        to: 'FAILED',
      }),
    ],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [],
    canCancel: false,
    canRetry: canRetryTask(failed),
    startedAt: failedAt,
  };

  // ---- Running (voice): reading WCAG 2.2, summarizing now.
  const running = f.tasks.find((t) => t.id === IDS.taskRunning)!;
  const runningFetchTitle = msg('step.fetch', { host: HOSTS.wcag });
  const runningFetch: TaskDetail['steps'][number] = {
    id: TASK_IDS.runningFetch,
    position: 0,
    title: text(locale, runningFetchTitle),
    titleMessage: runningFetchTitle,
    toolId: 'web.fetch',
    riskLevel: 'LOW',
    status: 'SUCCEEDED',
    requiresApproval: false,
    policy: { decision: 'allow', reasons: ['RISK_LOW'] },
    inputPreview: { url: URL_WCAG },
    output: {
      finalUrl: URL_WCAG,
      status: 200,
      title: 'Web Content Accessibility Guidelines (WCAG) 2.2',
      bytes: 412_388,
    },
    evidence: [evidence.http(URL_WCAG, 200, 'text/html; charset=utf-8', 412_388, at(-20 * SEC))],
    attempts: 1,
    startedAt: at(-24 * SEC),
    completedAt: at(-20 * SEC),
    error: null,
  };
  const runningSummarize: TaskDetail['steps'][number] = {
    ...summarizeStep,
    id: TASK_IDS.runningSummarize,
    position: 1,
    status: 'RUNNING',
    inputPreview: { text: '{{s1.text}}', language: locale, maxSentences: 5 },
    output: null,
    evidence: [],
    attempts: 1,
    startedAt: at(-12 * SEC),
    completedAt: null,
    error: null,
  };
  const runningObjective = msg('objective.summarize', { url: URL_WCAG });
  const runningDetail: TaskDetail = {
    ...running,
    objective: text(locale, runningObjective),
    objectiveMessage: runningObjective,
    conversationId: IDS.conversation,
    planner: { mode: 'offline', provider: null, model: null },
    answer: null,
    steps: [runningFetch, runningSummarize],
    approvals: [],
    events: [
      ev(IDS.taskRunning, 'task.created', running.createdAt, { status: 'QUEUED' }),
      ev(IDS.taskRunning, 'plan.ready', at(-26 * SEC), {
        stepCount: 2,
        planner: { mode: 'offline', provider: null, model: null },
      }),
      ev(IDS.taskRunning, 'step.succeeded', at(-20 * SEC), ref(runningFetch)),
      ev(IDS.taskRunning, 'step.started', at(-12 * SEC), { ...ref(runningSummarize), attempt: 1 }),
    ],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [],
    canCancel: true,
    canRetry: false,
    startedAt: at(-26 * SEC),
  };

  // ---- Answer (model planner): completed, with the model's evidence and cost. The model wrote
  // the title, the step and the result line, so they exist only in the request's language.
  const aT0 = -5 * HOUR;
  const answerSummary: TaskSummary = {
    id: TASK_IDS.answer,
    title: c.questionTitle,
    titleMessage: null,
    request: c.question,
    status: 'COMPLETED',
    riskLevel: 'LOW',
    source: 'voice',
    progress: { completed: 1, total: 1 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: c.answerResult,
    resultSummaryMessage: null,
    error: null,
    createdAt: at(aT0),
    updatedAt: at(aT0 + 9 * SEC),
    completedAt: at(aT0 + 9 * SEC),
  };
  const modelEvidence = evidence.model('claude-sonnet-4-5', 412, 268, at(aT0 + 8 * SEC));
  const answerStep: TaskDetail['steps'][number] = {
    id: TASK_IDS.answerStep,
    position: 0,
    title: c.answerStep,
    titleMessage: null,
    toolId: 'assistant.answer',
    riskLevel: 'LOW',
    status: 'SUCCEEDED',
    requiresApproval: false,
    policy: { decision: 'allow', reasons: ['RISK_LOW'] },
    inputPreview: { question: c.question },
    output: { answer: c.answer.split('\n')[0], model: 'claude-sonnet-4-5' },
    evidence: [modelEvidence],
    attempts: 1,
    startedAt: at(aT0 + 2 * SEC),
    completedAt: at(aT0 + 8 * SEC),
    error: null,
  };
  const answerDetail: TaskDetail = {
    ...answerSummary,
    objective: c.question,
    objectiveMessage: null,
    conversationId: IDS.conversation,
    planner: { mode: 'model', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    answer: c.answer,
    steps: [answerStep],
    approvals: [],
    events: [
      ev(TASK_IDS.answer, 'task.created', at(aT0), { status: 'QUEUED' }),
      ev(TASK_IDS.answer, 'plan.ready', at(aT0 + 2 * SEC), {
        stepCount: 1,
        planner: { mode: 'model', provider: 'anthropic', model: 'claude-sonnet-4-5' },
      }),
      ev(TASK_IDS.answer, 'step.succeeded', at(aT0 + 8 * SEC), ref(answerStep)),
      ev(TASK_IDS.answer, 'verification.passed', at(aT0 + 9 * SEC), {
        checks: [
          check(
            answerStep,
            'answerLength',
            { count: c.answer.length },
            `Answer of ${c.answer.length} characters`,
          ),
        ],
      }),
      ev(TASK_IDS.answer, 'task.status_changed', at(aT0 + 9 * SEC), {
        from: 'VERIFYING',
        to: 'COMPLETED',
      }),
    ],
    cost: { estimatedMicroUsd: 4_200, actualMicroUsd: 3_180 },
    evidence: [modelEvidence],
    canCancel: false,
    canRetry: false,
    startedAt: at(aT0 + 1 * SEC),
  };

  // ---- Older tasks (second page of the Task Center), planned offline: server-written titles
  // and result lines as messages; the newsletter's result is the page summary (no message).
  const olderTitles = [
    msg('plan.remember', { text: c.olderNote }),
    msg('plan.summarize', { host: 'newsletter.haddad.example' }),
    msg('plan.emailSelf', { text: c.olderEmail }),
  ];
  const olderResults = [
    msg('result.memorySaved', { text: c.olderNote }),
    null,
    msg('result.emailSent', { subject: c.olderEmail, recipients: EMAIL }),
  ];
  const older: TaskSummary[] = olderTitles.map((title, i) => {
    const result = olderResults[i] ?? null;
    return {
      id: [TASK_IDS.older1, TASK_IDS.older2, TASK_IDS.older3][i]!,
      title: text(locale, title),
      titleMessage: title,
      request: text(locale, title),
      status: 'COMPLETED',
      riskLevel: i === 2 ? 'MEDIUM' : 'LOW',
      source: i === 1 ? 'voice' : 'text',
      progress: { completed: i === 1 ? 2 : 1, total: i === 1 ? 2 : 1 },
      pendingApprovalId: null,
      pendingApproval: null,
      resultSummary: result ? text(locale, result) : c.olderSummary,
      resultSummaryMessage: result,
      error: null,
      createdAt: at(-(3 + i) * 24 * HOUR),
      updatedAt: at(-(3 + i) * 24 * HOUR + 30 * SEC),
      completedAt: at(-(3 + i) * 24 * HOUR + 30 * SEC),
    };
  });

  // The awaiting-approval task with its history so far.
  const emailDetail: TaskDetail = {
    ...email,
    events: [
      ev(IDS.taskEmail, 'task.created', email.createdAt, { status: 'QUEUED' }),
      ev(IDS.taskEmail, 'plan.ready', at(-8 * MIN - 43 * SEC), {
        stepCount: 3,
        planner: { mode: 'offline', provider: null, model: null },
      }),
      ev(IDS.taskEmail, 'step.succeeded', fetchStep.completedAt!, ref(fetchStep)),
      ev(IDS.taskEmail, 'step.succeeded', summarizeStep.completedAt!, ref(summarizeStep)),
      ev(IDS.taskEmail, 'approval.requested', approval.createdAt, {
        approvalId: approval.id,
        stepId: IDS.stepEmail,
        summary: approval.summary,
        summaryMessage: approval.summaryMessage,
      }),
      ev(IDS.taskEmail, 'task.status_changed', approval.createdAt, {
        from: 'RUNNING',
        to: 'AWAITING_APPROVAL',
      }),
    ],
  };

  const summaries = [unknownSummary, sentSummary, answerSummary];
  return {
    ...f,
    tasks: [...f.tasks.slice(0, 2), ...summaries, ...f.tasks.slice(2), ...older],
    taskDetails: {
      ...f.taskDetails,
      [IDS.taskEmail]: emailDetail,
      [TASK_IDS.sent]: sentDetail,
      [TASK_IDS.unknown]: unknownDetail,
      [IDS.taskFailed]: blockedDetail,
      [IDS.taskRunning]: runningDetail,
      [TASK_IDS.answer]: answerDetail,
    },
  };
}

/** Pages of PAGE tasks with an opaque cursor (the real API pages by 25). */
const PAGE = 7;
function pagedListTasks(): NonNullable<MockApiOptions['overrides']>['listTasks'] {
  return (req, s) => {
    const status = req.query.get('status') ?? 'all';
    const match: Record<string, (t: TaskSummary) => boolean> = {
      active: (t) =>
        ['QUEUED', 'PLANNING', 'AWAITING_APPROVAL', 'RUNNING', 'VERIFYING'].includes(t.status),
      needs_approval: (t) => t.status === 'AWAITING_APPROVAL',
      completed: (t) => t.status === 'COMPLETED',
      failed: (t) => ['FAILED', 'CANCELLED', 'EXPIRED'].includes(t.status),
      all: () => true,
    };
    // Newest first, like the API.
    const items = s.tasks
      .filter(match[status] ?? match.all!)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = Number(req.query.get('cursor')?.replace('page-', '') ?? 0);
    const slice = items.slice(start, start + PAGE);
    const next = start + PAGE < items.length ? `page-${start + PAGE}` : null;
    return { body: { items: slice, nextCursor: next } };
  };
}

/** Cancel / retry handlers that update the mock state like the API does. */
const taskActions: MockApiOptions['overrides'] = {
  cancelTask: (req, s) => {
    const d = s.taskDetails[req.params.id ?? ''];
    if (!d)
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Task not found' } } };
    const running = d.status === 'RUNNING' || d.status === 'PLANNING';
    const next: TaskDetail = running
      ? {
          ...d,
          events: [...d.events, ev(d.id, 'task.cancel_requested', new Date().toISOString())],
        }
      : {
          ...d,
          status: 'CANCELLED',
          canCancel: false,
          canRetry: false,
          completedAt: new Date().toISOString(),
        };
    s.taskDetails[d.id] = next;
    return { body: TaskSummary.parse(next) };
  },
  retryTask: (req, s) => {
    const d = s.taskDetails[req.params.id ?? ''];
    if (!d)
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Task not found' } } };
    const body = req.body as { acknowledgeUnknownOutcome: boolean };
    if (d.error?.code === 'OUTCOME_UNKNOWN' && !body.acknowledgeUnknownOutcome) {
      return {
        status: 409,
        body: {
          error: {
            code: 'INVALID_STATE',
            message: 'Confirm the retry first.',
            requestId: 'mock',
            details: { requiresAcknowledgement: true },
          },
        },
      };
    }
    const at = new Date().toISOString();
    const next: TaskDetail = {
      ...d,
      status: 'QUEUED',
      error: null,
      resultSummary: null,
      completedAt: null,
      canRetry: false,
      canCancel: true,
      steps: d.steps.map((st) =>
        st.status === 'SUCCEEDED'
          ? st
          : { ...st, status: 'PENDING', error: null, startedAt: null, completedAt: null },
      ),
      events: [...d.events, ev(d.id, 'task.retried', at, { attempt: 2 })],
    };
    s.taskDetails[d.id] = next;
    return { status: 202, body: TaskSummary.parse(next) };
  },
};

/* ------------------------------------------------------------------ live SSE */

/**
 * A real Server-Sent Events stream for the page: /api/v1/events is routed to a local server
 * that keeps the connection open, so the app sees an open stream and receives what we send.
 */
async function liveStream(page: Page) {
  const clients = new Set<ServerResponse>();
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    res.on('close', () => clients.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let seq = 5000;
  return {
    /** Call after mockApi(): routes registered later take precedence. */
    async attach() {
      await page.route('**/api/v1/events*', (route: Route) =>
        route.continue({ url: `http://127.0.0.1:${port}/events` }),
      );
    },
    async connected() {
      await expect.poll(() => clients.size, { timeout: 10_000 }).toBeGreaterThan(0);
    },
    send(event: Omit<StreamEvent, 'id' | 'at'> & { at?: string }) {
      const full: StreamEvent = { id: String(seq++), at: new Date().toISOString(), ...event };
      for (const res of clients) res.write(`id: ${full.id}\ndata: ${JSON.stringify(full)}\n\n`);
    },
    async close() {
      for (const res of clients) res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------ helpers */

async function open(
  page: Page,
  context: Parameters<typeof signInWithMock>[0],
  baseURL: string,
  {
    locale,
    theme,
    path,
    options = {},
    stream,
  }: {
    locale: FixtureLocale;
    theme: 'light' | 'dark';
    path: string;
    options?: MockApiOptions;
    stream?: { attach: () => Promise<void> };
  },
) {
  const now = Date.now();
  await signInWithMock(context, baseURL, { locale, theme });
  const api = await mockApi(page, {
    locale,
    theme,
    now,
    ...options,
    fixtures: (f) => {
      const withDetails = withTaskDetails(f, locale, now);
      return options.fixtures ? options.fixtures(withDetails) : withDetails;
    },
    overrides: { listTasks: pagedListTasks(), ...taskActions, ...options.overrides },
  });
  await stream?.attach();
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  return api;
}

/* ------------------------------------------------------------------ visual matrix */

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    const variant = `${theme}--${locale}`;

    test(`task center — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, { locale, theme, path: '/tasks' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('main ul li').first()).toBeVisible();
      await expect(
        page.locator('main').getByRole('button', { name: /^(Load more|Mehr laden|عرض المزيد)$/ }),
      ).toBeVisible();
      await capture(page, testInfo, `tasks--all--${variant}`);
      await expectNoSeriousA11yViolations(page);

      // Needs approval filter → URL, list, Review opens the approval sheet. (All comes first in
      // the filter row since the round-1 redesign, so the option is picked by its value.)
      await page.locator('main fieldset label:has(input[value="needs_approval"])').click();
      await expect(page).toHaveURL(/\?status=needs_approval$/);
      const rows = page.locator('main ul[aria-label] > li');
      await expect(rows).toHaveCount(1);
      await capture(page, testInfo, `tasks--needs-approval--${variant}`);
      await rows.getByRole('button').click();
      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();
      await capture(page, testInfo, `tasks--review-sheet--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
      expect(api.errors).toEqual([]);
    });

    test(`task detail: awaiting approval — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${IDS.taskEmail}`,
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('main section').first()).toBeVisible();
      await capture(page, testInfo, `task--awaiting--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`task detail: completed with evidence — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${TASK_IDS.sent}`,
      });
      // The result leads with what JARVIS wrote; the proof (with the SMTP Message-ID) is a
      // disclosure, open on desktop and collapsed on phones. It must always be one click away.
      const proof = page.locator('main button[aria-expanded]', {
        hasText: /^(Proof|Nachweise|الأدلة)/,
      });
      if ((await proof.getAttribute('aria-expanded')) === 'false') await proof.click();
      await expect(proof).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('main code', { hasText: MESSAGE_ID })).toBeVisible();
      // The fetched page is an external link that does not leak the opener or referrer.
      const link = page.locator(`main a[href="${URL_AI_ACT}"]`).first();
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(link).toHaveAttribute('target', '_blank');
      await capture(page, testInfo, `task--completed--${variant}`);
      await expectNoSeriousA11yViolations(page);
      // Expand the email step's details (input, output, evidence).
      await page
        .locator('main section ol')
        .first()
        .locator(':scope > li')
        .nth(2)
        .getByRole('button', { expanded: false })
        .click();
      await capture(page, testInfo, `task--completed-step--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`task detail: failed — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${IDS.taskFailed}`,
      });
      await expect(
        page.locator('main [role="alert"], main [class*="banner"]').first(),
      ).toBeVisible();
      await capture(page, testInfo, `task--failed--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });

    test(`task detail: unknown outcome retry — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${TASK_IDS.unknown}`,
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await capture(page, testInfo, `task--unknown-outcome--${variant}`);
      await page.locator('main header').getByRole('button').last().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('checkbox')).not.toBeChecked();
      await capture(page, testInfo, `task--retry-ack--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
      expect(api.errors).toEqual([]);
    });

    test(`task detail: model answer — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${TASK_IDS.answer}`,
        options: { planner: 'model' },
      });
      await expect(
        page.locator('main').getByText(COPY[locale].answer.split('\n')[0]!),
      ).toBeVisible();
      await capture(page, testInfo, `task--answer--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);
    });
  }
}

test.describe('task detail: running, streaming and states', () => {
  for (const [theme, locale] of [
    ['light', 'en'],
    ['dark', 'ar'],
    ['light', 'de'],
  ] as const) {
    const variant = `${theme}--${locale}`;

    test(`running with a streamed answer — ${variant}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const stream = await liveStream(page);
      const c = COPY[locale];
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${TASK_IDS.answer}`,
        stream,
        options: {
          planner: 'model',
          fixtures: (f) => {
            const d = f.taskDetails[TASK_IDS.answer]!;
            const recent = (ms: number) => new Date(Date.now() - ms).toISOString();
            f.taskDetails[TASK_IDS.answer] = {
              ...d,
              createdAt: recent(9_000),
              updatedAt: recent(4_000),
              startedAt: recent(8_000),
              cost: { estimatedMicroUsd: 4_200, actualMicroUsd: 0 },
              status: 'RUNNING',
              answer: null,
              resultSummary: null,
              completedAt: null,
              progress: { completed: 0, total: 1 },
              canCancel: true,
              evidence: [],
              steps: d.steps.map((s) => ({
                ...s,
                status: 'RUNNING',
                evidence: [],
                output: null,
                startedAt: recent(5_000),
                completedAt: null,
              })),
              events: d.events.slice(0, 2).map((e, i) => ({ ...e, at: recent(9_000 - i * 3_000) })),
            };
            return f;
          },
        },
      });
      await stream.connected();
      // Deltas are not replayed: send them once the task screen is listening.
      await expect(page.locator('main section ol').first()).toBeVisible();
      const words = c.answer.split(' ');
      const half = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      for (const chunk of half.match(/.{1,40}/gs) ?? []) {
        stream.send({ type: 'task.answer.delta', taskId: TASK_IDS.answer, data: { text: chunk } });
      }
      await expect(page.locator('main').getByText(c.answer.split('\n')[0]!)).toBeVisible();
      await capture(page, testInfo, `task--streaming--${variant}`);
      await expectNoSeriousA11yViolations(page);
      await stream.close();
      expect(api.errors).toEqual([]);
    });

    test(`running voice task — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: `/tasks/${IDS.taskRunning}`,
      });
      await expect(page.locator('main section ol').first().locator(':scope > li')).toHaveCount(2);
      await capture(page, testInfo, `task--running--${variant}`);
      // Cancel asks first.
      await page.locator('main header').getByRole('button').first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await capture(page, testInfo, `task--cancel-dialog--${variant}`, { fullPage: false });
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
      expect(api.errors).toEqual([]);
    });

    test(`not found and load error — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: '/tasks/7d0c5b0e-1111-4c2b-9d3e-0a1b2c3d4e5f',
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await capture(page, testInfo, `task--not-found--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);

      await page.unroute('**/api/v1/**');
      const failing = await mockApi(page, {
        locale,
        theme,
        overrides: {
          getTask: () => ({
            status: 503,
            body: {
              error: { code: 'INTERNAL', message: 'Database unavailable', requestId: 'req_7f3a9c' },
            },
          }),
          listTasks: () => ({
            status: 503,
            body: {
              error: { code: 'INTERNAL', message: 'Database unavailable', requestId: 'req_7f3a9c' },
            },
          }),
        },
      });
      await page.goto(`/tasks/${IDS.taskEmail}`);
      await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
      await capture(page, testInfo, `task--load-error--${variant}`);
      await page.goto('/tasks?status=completed');
      await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
      await capture(page, testInfo, `tasks--load-error--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(failing.errors).toEqual([]);
    });

    test(`empty filters and loading — ${variant}`, async ({ page, context, baseURL }, testInfo) => {
      const api = await open(page, context, baseURL!, {
        locale,
        theme,
        path: '/tasks?status=completed',
        options: {
          fixtures: (f) => ({ ...f, tasks: f.tasks.filter((t) => t.status !== 'COMPLETED') }),
        },
      });
      await expect(page.locator('main').getByRole('button')).toHaveCount(0);
      await capture(page, testInfo, `tasks--empty-completed--${variant}`);
      await expectNoSeriousA11yViolations(page);
      expect(api.errors).toEqual([]);

      await page.unroute('**/api/v1/**');
      const slow = await mockApi(page, {
        locale,
        theme,
        overrides: {
          listTasks: (_r, s) => ({ body: { items: s.tasks, nextCursor: null }, delayMs: 4000 }),
        },
      });
      await page.goto('/tasks');
      await expect(page.locator('main [aria-busy="true"]')).toBeVisible();
      await capture(page, testInfo, `tasks--loading--${variant}`);
      expect(slow.errors).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ behaviour */

test.describe('task behaviour', () => {
  test.skip(({ isMobile }) => isMobile, 'Behaviour is covered once on desktop');

  test('screens run without console errors or CSP violations', async ({
    page,
    context,
    baseURL,
  }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) =>
        console.error(`csp: ${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    const api = await open(page, context, baseURL!, { locale: 'en', theme: 'light', path: '/' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Layla');
    for (const path of [
      '/tasks',
      '/tasks?status=failed',
      `/tasks/${IDS.taskEmail}`,
      `/tasks/${TASK_IDS.sent}`,
      `/tasks/${TASK_IDS.unknown}`,
      `/tasks/${TASK_IDS.answer}`,
      `/tasks/${IDS.taskRunning}`,
      `/tasks/${IDS.taskFailed}`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
    }
    expect(problems).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test('filter syncs with ?status= and Load more pages by cursor', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: '/tasks?status=failed',
    });
    await expect(page.getByRole('radio', { name: 'Failed' })).toBeChecked();
    await expect(page.locator('main ul[aria-label] > li')).toHaveCount(2);
    // The URL is the source of truth, so the radio updates once the URL has changed.
    await page.locator('main fieldset label').filter({ hasText: /^All$/ }).click();
    await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
    await expect(page).toHaveURL(/\/tasks$/);
    // Each filter is a history entry: Back returns to the previous filter, Forward again.
    await page.goBack();
    await expect(page).toHaveURL(/\?status=failed$/);
    await expect(page.getByRole('radio', { name: 'Failed' })).toBeChecked();
    await page.goForward();
    await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
    await expect(page.locator('main ul[aria-label] > li')).toHaveCount(PAGE);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.locator('main ul[aria-label] > li')).toHaveCount(10);
    // Focus moves to the first newly loaded task.
    await expect(page.locator('main ul[aria-label] > li').nth(PAGE).locator('a')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    // Back to a filter through the URL.
    await page.goto('/tasks?status=active');
    await expect(page.getByRole('radio', { name: 'Active' })).toBeChecked();
    expect(api.errors).toEqual([]);
  });

  test('cancel asks first, then cancels and moves focus', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: `/tasks/${IDS.taskEmail}`,
    });
    await page.getByRole('button', { name: 'Cancel task' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this task?' });
    await expect(dialog).toBeVisible();
    const request = page.waitForRequest((r) => r.url().endsWith(`/tasks/${IDS.taskEmail}/cancel`));
    await dialog.getByRole('button', { name: 'Cancel task' }).click();
    await request;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('main h1 + p').getByText('Cancelled').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
    await expect(page.locator('main header [tabindex="-1"]')).toBeFocused();
    expect(api.calls).toContain('cancelTask');
    expect(api.errors).toEqual([]);
  });

  test('approving on the task screen continues the task and keeps focus on the page', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: `/tasks/${IDS.taskEmail}`,
      options: {
        overrides: {
          decideApproval: (req, s) => {
            const a = s.approvals.find((x) => x.id === req.params.id)!;
            const decided = {
              ...a,
              status: 'APPROVED' as const,
              decidedAt: new Date().toISOString(),
            };
            s.approvals = s.approvals.map((x) => (x.id === a.id ? decided : x));
            const d = s.taskDetails[a.taskId]!;
            s.taskDetails[a.taskId] = {
              ...d,
              status: 'RUNNING',
              pendingApprovalId: null,
              approvals: d.approvals.map((x) => (x.id === a.id ? decided : x)),
              steps: d.steps.map((st) => (st.id === a.stepId ? { ...st, status: 'RUNNING' } : st)),
            };
            return { body: decided };
          },
        },
      },
    });
    await page.getByRole('button', { name: 'Review and decide' }).click();
    const sheet = page.getByRole('dialog');
    // The task link is hidden on the task's own screen.
    await expect(sheet.getByRole('link')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Approve and send this email' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review and decide' })).toHaveCount(0);
    await expect(page.locator('main h1 + p').getByText('Running').first()).toBeVisible();
    await expect(page.locator('main header [tabindex="-1"]')).toBeFocused();
    expect(api.calls).toContain('decideApproval');
    expect(api.errors).toEqual([]);
  });

  test('retry after an unknown outcome needs the acknowledgement', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: `/tasks/${TASK_IDS.unknown}`,
    });
    await page.getByRole('button', { name: 'Retry' }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Retry anyway', exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    const request = page.waitForRequest((r) =>
      r.url().endsWith(`/tasks/${TASK_IDS.unknown}/retry`),
    );
    await confirm.click();
    const sent = await request;
    expect(sent.postDataJSON()).toEqual({ acknowledgeUnknownOutcome: true });
    expect(sent.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('main h1 + p').getByText('Queued').first()).toBeVisible();
    expect(api.errors).toEqual([]);
  });

  test('an approval on flagged page content names the page and what JARVIS left out', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    // The policy added UNTRUSTED_CONTENT; the server attaches the facts (details.untrusted) and
    // flags the task's pending approval (pendingApproval.untrustedSource).
    const flag = (f: Fixtures): Fixtures => {
      const untrusted = { host: HOSTS.aiAct, excludedSentences: 2, signals: ['ignore_previous'] };
      const mark = (a: Approval): Approval =>
        a.id === IDS.approval && a.details.kind === 'email'
          ? {
              ...a,
              reasons: [...a.reasons, 'UNTRUSTED_CONTENT'],
              details: { ...a.details, untrusted },
            }
          : a;
      const d = f.taskDetails[IDS.taskEmail]!;
      f.approvals = f.approvals.map(mark);
      f.home = { ...f.home, pendingApprovals: f.home.pendingApprovals.map(mark) };
      f.tasks = f.tasks.map((t) =>
        t.id === IDS.taskEmail
          ? { ...t, pendingApproval: { id: IDS.approval, untrustedSource: true } }
          : t,
      );
      f.taskDetails[IDS.taskEmail] = {
        ...d,
        pendingApproval: { id: IDS.approval, untrustedSource: true },
        approvals: d.approvals.map(mark),
      };
      return f;
    };
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: '/tasks?status=needs_approval',
      options: { fixtures: flag },
    });
    // The list row carries the chip.
    const row = page.locator('main ul[aria-label] > li');
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Untrusted source')).toBeVisible();
    // The task screen names the page and how many sentences the summary left out.
    await page.goto(`/tasks/${IDS.taskEmail}`);
    const panel = page.locator('main section').first();
    await expect(panel.getByText(/Text on .digital-strategy\.ec\.europa\.eu. tried/)).toBeVisible();
    await expect(
      panel.getByText(/JARVIS left those 2 sentences out of the summary\./),
    ).toBeVisible();
    await expect(panel.getByText('Untrusted source')).toBeVisible();
    // The sheet says the same.
    await panel.getByRole('button', { name: 'Review and decide' }).click();
    const sheet = page.getByRole('dialog');
    await expect(
      sheet.getByText(/JARVIS left those 2 sentences out of the summary\./),
    ).toBeVisible();
    await capture(page, testInfo, 'task--approval-untrusted--light--en', { fullPage: false });
    await expectNoSeriousA11yViolations(page);
    expect(api.errors).toEqual([]);
  });

  test('retry of a retryable failure goes straight through', async ({ page, context, baseURL }) => {
    // A transient failure (the page timed out). The blocked-address task no longer offers Retry
    // (it would fail the same way: "Ask again" instead), so this uses a retryable error.
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: `/tasks/${IDS.taskFailed}`,
      options: {
        fixtures: (f) => {
          const d = f.taskDetails[IDS.taskFailed]!;
          const error = {
            code: 'TOOL_TIMEOUT' as const,
            message: DEV_MESSAGES.fetchTimeout,
            retryable: true,
            reason: 'FETCH_TIMEOUT' as const,
            params: { host: HOSTS.wcag, seconds: 15 },
          };
          f.taskDetails[IDS.taskFailed] = {
            ...d,
            error,
            steps: d.steps.map((st) => (st.status === 'FAILED' ? { ...st, error } : st)),
            canRetry: canRetryTask({ status: d.status, error }),
          };
          return f;
        },
      },
    });
    // The banner says what happened in the interface language, not the English message.
    await expect(page.getByText(/didn’t respond within 15 seconds/).first()).toBeVisible();
    await expect(page.getByText(DEV_MESSAGES.fetchTimeout)).toBeHidden();
    const request = page.waitForRequest((r) => r.url().endsWith(`/tasks/${IDS.taskFailed}/retry`));
    await page.getByRole('button', { name: 'Retry' }).click();
    expect((await request).postDataJSON()).toEqual({ acknowledgeUnknownOutcome: false });
    await expect(page.locator('main h1 + p').getByText('Queued').first()).toBeVisible();
    expect(api.errors).toEqual([]);
  });

  test('live events refresh the task and stream the answer', async ({ page, context, baseURL }) => {
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: `/tasks/${IDS.taskRunning}`,
      stream,
    });
    await stream.connected();
    await expect(
      page.locator('main section ol').first().locator(':scope > li').nth(1).getByText('Running'),
    ).toBeVisible();
    // The worker finishes the step and the task: the mock state changes, then the events arrive.
    const d = api.state.taskDetails[IDS.taskRunning]!;
    api.state.taskDetails[IDS.taskRunning] = {
      ...d,
      status: 'COMPLETED',
      progress: { completed: 2, total: 2 },
      resultSummary: 'Summary of “Web Content Accessibility Guidelines (WCAG) 2.2” is ready.',
      completedAt: new Date().toISOString(),
      canCancel: false,
      steps: d.steps.map((s) => ({
        ...s,
        status: 'SUCCEEDED',
        completedAt: new Date().toISOString(),
      })),
    };
    stream.send({
      type: 'step.succeeded',
      taskId: IDS.taskRunning,
      data: { stepId: TASK_IDS.runningSummarize },
    });
    stream.send({
      type: 'task.status_changed',
      taskId: IDS.taskRunning,
      data: { from: 'VERIFYING', to: 'COMPLETED' },
    });
    await expect(page.locator('main h1 + p').getByText('Completed').first()).toBeVisible();
    await expect(
      page.getByText('Summary of “Web Content Accessibility Guidelines (WCAG) 2.2” is ready.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
    await stream.close();
    expect(api.errors).toEqual([]);
  });

  test('a completed voice task is read aloud when the preference is on', async ({
    page,
    context,
    baseURL,
  }) => {
    // Record what would be spoken (headless Chromium has no speech output).
    await page.addInitScript(() => {
      const spoken: string[] = [];
      const w = window as unknown as Record<string, unknown> & { __spoken: string[] };
      w.__spoken = spoken;
      if (typeof w.SpeechSynthesisUtterance !== 'function') {
        w.SpeechSynthesisUtterance = class {
          lang = '';
          voice: unknown = null;
          constructor(readonly text: string) {}
        };
      }
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speak: (u: { text: string }) => spoken.push(u.text),
          cancel: () => undefined,
          getVoices: () => [],
        },
      });
    });
    const stream = await liveStream(page);
    const api = await open(page, context, baseURL!, {
      locale: 'en',
      theme: 'light',
      path: `/tasks/${IDS.taskRunning}`,
      stream,
      options: {
        fixtures: (f) => ({
          ...f,
          me: {
            ...f.me,
            preferences: {
              ...f.me.preferences,
              voice: { ...f.me.preferences.voice, speakResponses: true },
            },
          },
        }),
      },
    });
    await stream.connected();
    // The preference comes from the profile; wait until the screen and profile are loaded.
    await expect(page.locator('main section ol').first()).toBeVisible();
    await expect(page.getByText('Layla Haddad').first()).toBeVisible();
    const d = api.state.taskDetails[IDS.taskRunning]!;
    const result = 'Summary of “Web Content Accessibility Guidelines (WCAG) 2.2” is ready.';
    api.state.taskDetails[IDS.taskRunning] = {
      ...d,
      status: 'COMPLETED',
      resultSummary: result,
      canCancel: false,
    };
    stream.send({
      type: 'task.status_changed',
      taskId: IDS.taskRunning,
      data: { from: 'VERIFYING', to: 'COMPLETED' },
    });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken))
      .toEqual([result]);
    // The same completion arriving again is not read twice.
    stream.send({
      type: 'task.status_changed',
      taskId: IDS.taskRunning,
      data: { from: 'VERIFYING', to: 'COMPLETED' },
    });
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken),
    ).toEqual([result]);
    await stream.close();
    expect(api.errors).toEqual([]);
  });
});
