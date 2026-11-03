import type { TaskDetail, TaskEvent, TaskStatus } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  attemptOf,
  completedSteps,
  describeEvent,
  durationMs,
  failedStep,
  filterHref,
  guidanceFor,
  isCancelRequested,
  parseEvidence,
  parseFilter,
  pendingApproval,
  previewEntries,
  previewValue,
  requiresAcknowledgement,
  safeExternalUrl,
  shortHash,
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
      response: '250 2.0.0 Ok: queued as 4QzX7b1kT9z',
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
    expect(describe_(event('step.started')).params).toEqual({ title: 'a step' });
    expect(
      describe_(event('verification.passed', { checks: ['1/1 accepted', 3, ''] })).details,
    ).toEqual(['1/1 accepted']);
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
