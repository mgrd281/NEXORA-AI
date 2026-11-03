import type { Approval, TaskSummary } from '@jarvis/contracts';

/**
 * Sample data for the development-only component gallery (/dev/components). Not used by any
 * production screen; the page returns 404 in production builds.
 */
const MIN = 60_000;

export function sampleTasks(now: number): TaskSummary[] {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const base = {
    riskLevel: 'LOW' as const,
    source: 'text' as const,
    pendingApprovalId: null,
    resultSummary: null,
    error: null,
    completedAt: null,
  };
  return [
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Summarize what changed in WCAG 2.2',
      request: 'Read https://www.w3.org/TR/WCAG22/ and summarize what changed in WCAG 2.2',
      status: 'RUNNING',
      source: 'voice',
      progress: { completed: 1, total: 2 },
      createdAt: at(-MIN),
      updatedAt: at(-20_000),
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000002',
      title: 'Summarize the EU AI Act overview and email it to me',
      request: 'Summarize the EU AI Act overview and email it to me',
      status: 'AWAITING_APPROVAL',
      riskLevel: 'MEDIUM',
      progress: { completed: 2, total: 3 },
      pendingApprovalId: '00000000-0000-4000-8000-0000000000a1',
      createdAt: at(-9 * MIN),
      updatedAt: at(-8 * MIN),
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000003',
      title: 'Plan a request',
      request: 'Remember that the board meeting moved to Thursday',
      status: 'PLANNING',
      progress: { completed: 0, total: 0 },
      createdAt: at(-5_000),
      updatedAt: at(-4_000),
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000004',
      title: 'Remember: aisle seats on flights',
      request: 'Remember that I prefer aisle seats on flights',
      status: 'COMPLETED',
      progress: { completed: 1, total: 1 },
      resultSummary: 'Saved to memory: you prefer aisle seats on flights.',
      createdAt: at(-125 * MIN),
      updatedAt: at(-124 * MIN),
      completedAt: at(-124 * MIN),
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000005',
      title: 'Summarize the Q3 board report',
      request: 'Summarize http://intranet.haddad.internal/q3-board-report',
      status: 'FAILED',
      progress: { completed: 0, total: 2 },
      error: {
        code: 'FETCH_BLOCKED',
        message: 'This address points to a private network, so JARVIS will not fetch it.',
        retryable: false,
      },
      createdAt: at(-26 * 60 * MIN),
      updatedAt: at(-26 * 60 * MIN),
      completedAt: at(-26 * 60 * MIN),
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000006',
      title: 'تلخيص تقرير الربع الثالث',
      request: 'لخّص https://example.com/q3 وأرسله لي بالبريد',
      status: 'QUEUED',
      progress: { completed: 0, total: 0 },
      createdAt: at(-2_000),
      updatedAt: at(-2_000),
    },
  ];
}

export function sampleApproval(now: number): Approval {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    taskId: '00000000-0000-4000-8000-000000000002',
    taskTitle: 'Summarize the EU AI Act overview and email it to me',
    stepId: '00000000-0000-4000-8000-0000000000b1',
    toolId: 'email.send',
    status: 'PENDING',
    riskLevel: 'MEDIUM',
    summary:
      'Send an email to layla.haddad@example.com with the subject “Summary: EU AI Act overview”.',
    details: {
      kind: 'email',
      from: 'layla.haddad@example.com',
      to: ['layla.haddad@example.com'],
      subject: 'Summary: EU AI Act overview',
      body: [
        'Summary of “AI Act | Shaping Europe’s digital future”:',
        '',
        '• The AI Act is the first comprehensive legal framework on AI worldwide.',
        '• Systems with unacceptable risk are banned; high-risk systems must meet strict requirements.',
        '• Transparency obligations apply to chatbots and generated content.',
        '',
        'Source: https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
      ].join('\n'),
    },
    actionHash: 'sha256:9c1e4f7a2b6d8e0f3a5c7b9d1e2f4a6c8b0d2e4f6a8c0b2d4e6f8a0c2b4d6e8f',
    reasons: ['RISK_MEDIUM', 'RECIPIENT_SELF'],
    expiresAt: new Date(now + 23 * 60 * MIN).toISOString(),
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date(now - 8 * MIN).toISOString(),
  };
}
