import type { Approval, TaskDetail, TaskEvent, TaskStatus } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  attemptOf,
  completedSteps,
  describeEvent,
  durationMs,
  emailDelivery,
  failedStep,
  filterHref,
  guidanceFor,
  historyMilestones,
  isCancelRequested,
  isStepAhead,
  needsModel,
  nextAction,
  parseCheck,
  parseEvidence,
  parseFilter,
  pendingApproval,
  previewEntries,
  previewValue,
  requiresAcknowledgement,
  restatesTitle,
  safeExternalUrl,
  savedMemory,
  shortHash,
  stepDecision,
  stepDisplayStatus,
  TASK_FILTERS,
  timelineRows,
  writtenSummary,
} from './model';

const at = '2026-11-03T14:05:32.000Z';
const label = (s: TaskStatus) => `«${s}»`;
let id = 0;
const event = (type: TaskEvent['type'], data: Record<string, unknown> = {}): TaskEvent => ({
  id: String(++id),
  taskId: '3e90bd61-5f84-4a0d-8b43-8c6f5d4e0a04',
  type,
  at,
  data,
});

describe('filters', () => {
  it('parses ?status= and falls back to All', () => {
    expect(parseFilter('needs_approval')).toBe('needs_approval');
    expect(parseFilter('failed')).toBe('failed');
    expect(parseFilter(null)).toBe('all');
    expect(parseFilter('')).toBe('all');
    expect(parseFilter('FAILED')).toBe('all');
    expect(parseFilter('<script>')).toBe('all');
  });

  it('puts the default (All) first, so a phone shows it without scrolling', () => {
    expect(TASK_FILTERS[0]).toBe('all');
  });

  it('builds the Task Center URL (All is the bare path)', () => {
    expect(filterHref('all')).toBe('/tasks');
    expect(filterHref('active')).toBe('/tasks?status=active');
  });
});

describe('evidence', () => {
  it('reads an SMTP receipt with its Message-ID', () => {
    const view = parseEvidence({
      kind: 'smtp_receipt',
      label: 'SMTP 250 · 1 accepted',
      value: '250 2.0.0 Ok: queued as 4QzX7b1kT9z · Message-ID <c4f1@jarvis.example>',
      at,
    });
    expect(view).toEqual({
      kind: 'smtp_receipt',
      code: '250',
      accepted: 1,
      messageId: '<c4f1@jarvis.example>',
      // The code is shown once ("SMTP 250"), not again at the start of the reply.
      response: '2.0.0 Ok: queued as 4QzX7b1kT9z',
    });
  });

  it('reads an HTTP response: status, safe final URL, type and size', () => {
    const view = parseEvidence({
      kind: 'http_response',
      label: 'HTTP 200',
      value: 'GET https://www.w3.org/TR/WCAG22/ → 200 (text/html; charset=utf-8, 412388 bytes)',
      at,
    });
    expect(view).toEqual({
      kind: 'http_response',
      status: 200,
      url: 'https://www.w3.org/TR/WCAG22/',
      contentType: 'text/html; charset=utf-8',
      bytes: 412388,
    });
  });

  it('accepts a bare URL value and the status from the label', () => {
    const view = parseEvidence({
      kind: 'http_response',
      label: 'HTTP 404',
      value: 'https://a.example/x',
      at,
    });
    expect(view).toMatchObject({ status: 404, url: 'https://a.example/x', bytes: null });
  });

  it('never links non-http(s) URLs', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl('http://example.com/a b')).toBe('http://example.com/a%20b');
    const view = parseEvidence({
      kind: 'http_response',
      label: 'HTTP 200',
      value: 'javascript:alert(1)',
      at,
    });
    expect(view).toMatchObject({ url: null });
  });

  it('reads a content hash and model output', () => {
    expect(
      parseEvidence({
        kind: 'content_hash',
        label: 'SHA-256 of the response body',
        value: 'sha256:5d2f8c1a',
        at,
      }),
    ).toEqual({
      kind: 'content_hash',
      algorithm: 'SHA-256',
      hex: '5d2f8c1a',
      value: 'sha256:5d2f8c1a',
    });
    expect(
      parseEvidence({
        kind: 'model_output',
        label: 'claude-sonnet-4-5',
        value: '412 input / 268 output tokens',
        at,
      }),
    ).toEqual({
      kind: 'model_output',
      model: 'claude-sonnet-4-5',
      inputTokens: 412,
      outputTokens: 268,
    });
  });

  it('reads the offline summarizer note', () => {
    expect(
      parseEvidence({
        kind: 'note',
        label: 'Extractive summary',
        value: '5 key sentences from 3693 characters; no AI model was used.',
        at,
      }),
    ).toEqual({ kind: 'extractive', sentences: 5, chars: 3693 });
  });

  it('keeps notes and records as written', () => {
    expect(
      parseEvidence({ kind: 'note', label: 'Length limit', value: 'Max reached.', at }),
    ).toEqual({
      kind: 'note',
      label: 'Length limit',
      value: 'Max reached.',
    });
  });

  it('shortens hashes but leaves short values alone', () => {
    expect(shortHash('5d2f8c1a9e3b7d6f0a4c8e2b6d0f4a8c', 8, 8)).toBe('5d2f8c1a…6d0f4a8c');
    expect(shortHash('abc', 8, 8)).toBe('abc');
  });
});

describe('events', () => {
  const describe_ = (e: TaskEvent) => describeEvent(e, label, 'a step');

  it('localizes status changes with a tone', () => {
    expect(describe_(event('task.status_changed', { from: 'VERIFYING', to: 'COMPLETED' }))).toEqual(
      {
        key: 'tasks.events.statusChanged',
        params: { status: '«COMPLETED»' },
        tone: 'success',
      },
    );
    expect(describe_(event('task.status_changed', { to: 'BOGUS' })).params).toEqual({
      status: '—',
    });
  });

  it('names the planner', () => {
    expect(
      describe_(
        event('plan.ready', {
          stepCount: 3,
          planner: { mode: 'offline', provider: null, model: null },
        }),
      ),
    ).toMatchObject({ key: 'tasks.events.planReadyOffline', params: { count: 3 } });
    expect(
      describe_(
        event('plan.ready', {
          stepCount: 1,
          planner: { mode: 'model', provider: 'anthropic', model: 'claude-x' },
        }),
      ),
    ).toMatchObject({
      key: 'tasks.events.planReadyModel',
      params: { count: 1, model: 'claude-x' },
    });
  });

  it('carries step titles, messages and checks', () => {
    expect(
      describe_(event('step.failed', { title: 'Send the email', message: 'No reply' })),
    ).toEqual({
      key: 'tasks.events.stepFailed',
      params: { title: 'Send the email' },
      details: ['No reply'],
      tone: 'danger',
    });
    // A known code is shown localized instead of the server's English message.
    expect(
      describe_(
        event('step.failed', { title: 'Read x', code: 'FETCH_BLOCKED', message: 'English' }),
      ),
    ).toEqual({
      key: 'tasks.events.stepFailed',
      params: { title: 'Read x' },
      errorCode: 'FETCH_BLOCKED',
      tone: 'danger',
    });
    expect(describe_(event('step.started')).params).toEqual({ title: 'a step' });
    expect(
      describe_(event('verification.passed', { checks: ['1/1 accepted', 3, ''] })).checks,
    ).toEqual([{ step: null, key: null, params: {}, text: '1/1 accepted' }]);
  });

  it('localizes the verification lines the tools write', () => {
    expect(parseCheck('Read 127.0.0.1:4599: HTTP 200 from http://127.0.0.1:4599/article')).toEqual({
      step: 'Read 127.0.0.1:4599',
      key: 'tasks.checks.http',
      params: { status: '200', url: 'http://127.0.0.1:4599/article' },
      text: 'Read 127.0.0.1:4599: HTTP 200 from http://127.0.0.1:4599/article',
    });
    expect(parseCheck('Email the summary to you: 1/1 recipients accepted')).toMatchObject({
      step: 'Email the summary to you',
      key: 'tasks.checks.recipientsAccepted',
      params: { accepted: 1, count: 1 },
    });
    expect(parseCheck('Summarize: a: Summary of 642 characters')).toMatchObject({
      step: 'Summarize: a',
      key: 'tasks.checks.summaryLength',
      params: { count: 642 },
    });
    expect(parseCheck('Extractive summary (no AI model used)')).toMatchObject({
      step: null,
      key: 'tasks.checks.extractive',
    });
    expect(parseCheck({ key: 'hashRecorded', step: 'Read x' })).toMatchObject({
      step: 'Read x',
      key: 'tasks.checks.hashRecorded',
    });
    expect(parseCheck('Something new')).toEqual({
      step: null,
      key: null,
      params: {},
      text: 'Something new',
    });
    expect(parseCheck(42)).toBeNull();
  });

  it('merges step start and end rows and drops status rows that restate a neighbour', () => {
    const t0 = '2026-11-03T14:05:00.000Z';
    const t1 = '2026-11-03T14:05:00.031Z';
    const ev = (type: TaskEvent['type'], data: Record<string, unknown> = {}, when = t0) => ({
      ...event(type, data),
      at: when,
    });
    const events = [
      ev('task.created', { status: 'QUEUED' }),
      ev('task.status_changed', { to: 'PLANNING' }),
      ev('plan.ready', { stepCount: 1 }),
      ev('task.status_changed', { to: 'RUNNING' }),
      ev('step.started', { stepId: 's1', title: 'Read' }),
      ev('step.succeeded', { stepId: 's1', title: 'Read' }, t1),
      ev('task.status_changed', { to: 'VERIFYING' }),
      ev('verification.passed', { checks: [] }),
      ev('task.status_changed', { to: 'COMPLETED' }),
      ev('task.answer.delta', { text: 'x' }),
    ];
    const rows = timelineRows(events);
    expect(rows.map((r) => r.event.type)).toEqual([
      'task.created',
      'plan.ready',
      'step.succeeded',
      'verification.passed',
      'task.status_changed',
    ]);
    expect(rows[2]?.durationMs).toBe(31);
    expect(rows[4]?.event.data.to).toBe('COMPLETED');
    // A step that has not finished keeps its start row.
    expect(timelineRows([ev('step.started', { stepId: 's2' })]).map((r) => r.event.type)).toEqual([
      'step.started',
    ]);
  });

  it('summarizes the history in milestones', () => {
    const done = [
      event('task.created'),
      event('approval.decided', { decision: 'approved' }),
      event('step.succeeded', { toolId: 'email.send' }),
    ];
    expect(historyMilestones(done, 'COMPLETED')).toEqual([
      'tasks.history.milestones.asked',
      'tasks.history.milestones.approved',
      'tasks.history.milestones.sent',
    ]);
    expect(historyMilestones([event('task.created')], 'FAILED')).toEqual([
      'tasks.history.milestones.asked',
      'tasks.history.milestones.failed',
    ]);
    expect(historyMilestones([event('task.created')], 'COMPLETED')).toEqual([
      'tasks.history.milestones.asked',
      'tasks.history.milestones.done',
    ]);
    expect(historyMilestones([event('task.created')], 'AWAITING_APPROVAL')).toEqual([
      'tasks.history.milestones.asked',
      'tasks.history.milestones.waiting',
    ]);
  });

  it('maps approval decisions', () => {
    expect(describe_(event('approval.decided', { decision: 'approved' })).key).toBe(
      'tasks.events.approvalApproved',
    );
    expect(describe_(event('approval.decided', { decision: 'rejected' })).key).toBe(
      'tasks.events.approvalRejected',
    );
    expect(describe_(event('approval.decided', { decision: 'expired' })).key).toBe(
      'tasks.events.approvalExpired',
    );
    expect(describe_(event('approval.decided')).key).toBe('tasks.events.approvalDecided');
  });
});

describe('task state', () => {
  const base = { status: 'RUNNING' as TaskStatus, events: [] as TaskEvent[] };

  it('counts attempts from task.retried', () => {
    expect(attemptOf(base)).toBe(1);
    expect(
      attemptOf({
        events: [event('task.retried', { attempt: 2 }), event('task.retried', { attempt: 3 })],
      }),
    ).toBe(3);
  });

  it('knows a cancellation is pending only in the current attempt', () => {
    expect(isCancelRequested({ ...base, events: [event('task.cancel_requested')] })).toBe(true);
    expect(
      isCancelRequested({
        ...base,
        events: [event('task.cancel_requested'), event('task.retried', { attempt: 2 })],
      }),
    ).toBe(false);
    expect(
      isCancelRequested({ status: 'CANCELLED', events: [event('task.cancel_requested')] }),
    ).toBe(false);
  });

  it('requires an acknowledgement only for OUTCOME_UNKNOWN', () => {
    expect(
      requiresAcknowledgement({
        error: { code: 'OUTCOME_UNKNOWN', message: '', retryable: false },
      }),
    ).toBe(true);
    expect(
      requiresAcknowledgement({ error: { code: 'TOOL_TIMEOUT', message: '', retryable: true } }),
    ).toBe(false);
    expect(requiresAcknowledgement({ error: null })).toBe(false);
  });

  it('gives specific guidance and links', () => {
    expect(guidanceFor({ code: 'FETCH_BLOCKED', retryable: false })).toEqual({
      key: 'tasks.guidance.FETCH_BLOCKED',
      link: null,
    });
    expect(guidanceFor({ code: 'CONNECTION_REQUIRED', retryable: false }).link?.href).toBe(
      '/connections',
    );
    expect(guidanceFor({ code: 'BUDGET_EXCEEDED', retryable: false }).link?.href).toBe('/settings');
    expect(guidanceFor({ code: 'TOOL_FAILED', retryable: true }).key).toBe(
      'tasks.guidance.retryable',
    );
    expect(guidanceFor({ code: 'INTERNAL', retryable: false }).key).toBe(
      'tasks.guidance.notRetryable',
    );
  });

  it('finds the failed step, completed steps and durations', () => {
    const steps = [
      { status: 'SUCCEEDED' },
      { status: 'SKIPPED' },
      { status: 'FAILED' },
      { status: 'PENDING' },
    ] as TaskDetail['steps'];
    expect(completedSteps(steps)).toBe(2);
    expect(failedStep({ steps })).toBe(steps[2]);
    expect(durationMs('2026-11-03T14:00:00Z', '2026-11-03T14:00:02.5Z')).toBe(2500);
    expect(durationMs('2026-11-03T14:00:02Z', '2026-11-03T14:00:00Z')).toBeNull();
    expect(durationMs(null, '2026-11-03T14:00:00Z')).toBeNull();
  });

  it('offers Ask again instead of a Retry that would fail the same way', () => {
    const failed = (code: 'FETCH_BLOCKED' | 'PLANNER_UNSUPPORTED' | 'TOOL_TIMEOUT') => ({
      status: 'FAILED' as TaskStatus,
      error: { code, message: '', retryable: code === 'TOOL_TIMEOUT' },
      canRetry: true,
    });
    expect(nextAction(failed('FETCH_BLOCKED'))).toBe('askAgain');
    expect(nextAction({ ...failed('PLANNER_UNSUPPORTED'), canRetry: false })).toBe('askAgain');
    expect(nextAction(failed('TOOL_TIMEOUT'))).toBe('retry');
    expect(nextAction({ status: 'EXPIRED', error: null, canRetry: true })).toBe('retry');
    expect(nextAction({ status: 'COMPLETED', error: null, canRetry: false })).toBeNull();
    expect(needsModel({ code: 'PLANNER_UNSUPPORTED' })).toBe(true);
    expect(needsModel({ code: 'FETCH_BLOCKED' })).toBe(false);
  });

  it('shows steps that will never run as not run', () => {
    expect(stepDisplayStatus({ status: 'PENDING' }, 'FAILED')).toBe('NOT_RUN');
    expect(stepDisplayStatus({ status: 'AWAITING_APPROVAL' }, 'CANCELLED')).toBe('NOT_RUN');
    expect(stepDisplayStatus({ status: 'SKIPPED' }, 'COMPLETED')).toBe('NOT_RUN');
    expect(stepDisplayStatus({ status: 'PENDING' }, 'RUNNING')).toBe('PENDING');
    expect(stepDisplayStatus({ status: 'FAILED' }, 'FAILED')).toBe('FAILED');
    expect(isStepAhead({ status: 'PENDING' }, 'RUNNING')).toBe(true);
    expect(isStepAhead({ status: 'PENDING' }, 'FAILED')).toBe(false);
    expect(isStepAhead({ status: 'SUCCEEDED' }, 'RUNNING')).toBe(false);
  });

  it('finds the decision on a step, the written summary and where it was emailed', () => {
    const approval = (status: Approval['status'], decidedAt: string | null) =>
      ({
        id: `a-${status}`,
        stepId: 's3',
        status,
        decidedAt,
        details: { kind: 'email', from: '', to: ['me@x.example'], subject: 'S', body: '' },
      }) as Approval;
    const approvals = [
      approval('EXPIRED', '2026-11-03T10:00:00Z'),
      approval('APPROVED', '2026-11-03T11:00:00Z'),
      approval('PENDING', null),
    ];
    expect(stepDecision(approvals, 's3')?.status).toBe('APPROVED');
    expect(stepDecision(approvals, 'other')).toBeNull();
    const steps = [
      {
        id: 's2',
        toolId: 'text.summarize',
        status: 'SUCCEEDED',
        output: { summary: ' Text ', method: 'extractive', suspectedInjection: true },
        inputPreview: {},
        completedAt: null,
      },
      {
        id: 's3',
        toolId: 'email.send',
        status: 'SUCCEEDED',
        output: { accepted: ['me@x.example'] },
        inputPreview: {},
        completedAt: '2026-11-03T11:00:01Z',
      },
    ] as unknown as TaskDetail['steps'];
    expect(writtenSummary(steps)).toBe('Text');
    expect(emailDelivery({ steps, approvals })).toEqual({
      to: ['me@x.example'],
      at: '2026-11-03T11:00:01Z',
    });
    expect(emailDelivery({ steps: [], approvals })).toBeNull();
    expect(
      savedMemory([
        { toolId: 'memory.save', status: 'SUCCEEDED', output: { content: ' Aisle seats ' } },
      ] as unknown as TaskDetail['steps']),
    ).toBe('Aisle seats');
    expect(savedMemory(steps)).toBeNull();
  });

  it('knows when the quoted request only repeats the title', () => {
    expect(
      restatesTitle(
        'What will the weather be like in Berlin tomorrow?',
        'What will the weather be like in Berlin tomorrow?',
      ),
    ).toBe(true);
    expect(restatesTitle('remember that  I like tea.', 'Remember that I like tea')).toBe(true);
    expect(
      restatesTitle(
        'Summarize http://127.0.0.1:4599/article and email it to me',
        'Summarize 127.0.0.1:4599 and email it to you',
      ),
    ).toBe(false);
  });

  it('picks the pending approval', () => {
    const a = (status: string, aid: string) =>
      ({ id: aid, status }) as TaskDetail['approvals'][number];
    expect(
      pendingApproval({
        approvals: [a('APPROVED', 'x'), a('PENDING', 'y')],
        pendingApprovalId: 'y',
      })?.id,
    ).toBe('y');
    expect(
      pendingApproval({ approvals: [a('APPROVED', 'x')], pendingApprovalId: null }),
    ).toBeNull();
  });
});

describe('previews', () => {
  it('formats preview values by type', () => {
    expect(previewValue('{{s1.text}}')).toEqual({ type: 'reference', ref: 's1.text' });
    expect(previewValue('see {{s1.text}} here')).toMatchObject({ type: 'text', url: null });
    expect(previewValue('https://a.example/')).toEqual({
      type: 'text',
      text: 'https://a.example/',
      url: 'https://a.example/',
    });
    expect(previewValue(['a@x.example', 'b@x.example'])).toEqual({
      type: 'list',
      items: ['a@x.example', 'b@x.example'],
    });
    expect(previewValue(true)).toEqual({ type: 'boolean', value: true });
    expect(previewValue(5)).toEqual({ type: 'number', value: 5 });
    expect(previewValue({ a: 1 })).toEqual({ type: 'json', text: '{"a":1}' });
  });

  it('drops empty fields', () => {
    expect(previewEntries({ a: '', b: null, c: 'x', d: [] }).map(([k]) => k)).toEqual(['c', 'd']);
    expect(previewEntries(null)).toEqual([]);
  });
});
