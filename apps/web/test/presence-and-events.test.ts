import { describe, expect, it } from 'vitest';
import { deriveAssistantPresence, presenceFromTask } from '@/components/presence/model';
import { qk } from '@/lib/api/query-keys';
import { queriesToInvalidate } from '@/lib/events/invalidation';
import { safeNextPath } from '@/lib/safe-next';
import { buildCsp } from '@/lib/security/csp';

const base = {
  online: true,
  stream: 'open' as const,
  workerHealthy: true,
  activeTasks: [],
  pendingApprovals: 0,
  flash: null,
  listening: false,
};

describe('presenceFromTask', () => {
  it('maps every task status to a real presence state', () => {
    expect(presenceFromTask({ status: 'QUEUED', progress: { completed: 0, total: 0 } }).state).toBe(
      'idle',
    );
    expect(
      presenceFromTask({ status: 'PLANNING', progress: { completed: 0, total: 0 } }).state,
    ).toBe('thinking');
    expect(
      presenceFromTask({ status: 'VERIFYING', progress: { completed: 3, total: 3 } }).state,
    ).toBe('thinking');
    const running = presenceFromTask({ status: 'RUNNING', progress: { completed: 1, total: 3 } });
    expect(running).toMatchObject({ state: 'running', progress: { completed: 1, total: 3 } });
    expect(running.labelParams).toEqual({ completed: 1, total: 3 });
    expect(
      presenceFromTask({ status: 'AWAITING_APPROVAL', progress: { completed: 1, total: 3 } }).state,
    ).toBe('awaiting');
    expect(
      presenceFromTask({ status: 'COMPLETED', progress: { completed: 3, total: 3 } }).state,
    ).toBe('completed');
    expect(presenceFromTask({ status: 'FAILED', progress: { completed: 1, total: 3 } }).state).toBe(
      'failed',
    );
    expect(
      presenceFromTask({ status: 'CANCELLED', progress: { completed: 0, total: 3 } }).state,
    ).toBe('idle');
    expect(
      presenceFromTask({ status: 'EXPIRED', progress: { completed: 0, total: 3 } }).state,
    ).toBe('idle');
  });
});

describe('deriveAssistantPresence', () => {
  const task = (status: 'RUNNING' | 'PLANNING' | 'QUEUED', title = 'Summarize') => ({
    status,
    title,
    progress: { completed: 1, total: 3 },
  });

  it('is idle when nothing happens', () => {
    expect(deriveAssistantPresence(base)).toMatchObject({
      state: 'idle',
      labelKey: 'common.presence.idle',
    });
  });

  it('puts connectivity first', () => {
    expect(deriveAssistantPresence({ ...base, online: false, pendingApprovals: 2 }).state).toBe(
      'offline',
    );
    expect(deriveAssistantPresence({ ...base, stream: 'reconnecting' }).state).toBe('reconnecting');
    expect(deriveAssistantPresence({ ...base, workerHealthy: false }).labelKey).toBe(
      'common.presence.unavailable',
    );
  });

  it('shows approvals before running work, and running work with progress', () => {
    expect(
      deriveAssistantPresence({ ...base, pendingApprovals: 1, activeTasks: [task('RUNNING')] })
        .state,
    ).toBe('awaiting');
    const running = deriveAssistantPresence({
      ...base,
      activeTasks: [task('PLANNING'), task('RUNNING', 'Email')],
    });
    expect(running).toMatchObject({ state: 'running', labelParams: { title: 'Email' } });
    expect(deriveAssistantPresence({ ...base, activeTasks: [task('PLANNING')] }).state).toBe(
      'thinking',
    );
  });

  it('flashes completion/failure only when nothing else is active', () => {
    expect(deriveAssistantPresence({ ...base, flash: 'completed' }).state).toBe('completed');
    expect(deriveAssistantPresence({ ...base, flash: 'failed' }).state).toBe('failed');
    expect(
      deriveAssistantPresence({ ...base, flash: 'completed', activeTasks: [task('PLANNING')] })
        .state,
    ).toBe('thinking');
  });

  it('labels queued work honestly', () => {
    expect(deriveAssistantPresence({ ...base, activeTasks: [task('QUEUED')] }).labelKey).toBe(
      'common.presence.queued',
    );
  });

  it('shows listening while voice capture is active', () => {
    expect(deriveAssistantPresence({ ...base, listening: true }).state).toBe('listening');
  });
});

describe('queriesToInvalidate', () => {
  const taskId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
  it('refreshes the task, lists, home and conversation threads for task events', () => {
    expect(queriesToInvalidate({ type: 'step.succeeded', taskId })).toEqual([
      qk.tasks.detail(taskId),
      qk.tasks.lists,
      qk.home,
      qk.conversations.all,
    ]);
  });
  it('refreshes schedules when a task starts or ends, and for schedule events', () => {
    expect(queriesToInvalidate({ type: 'task.status_changed', taskId })).toContainEqual(
      qk.schedules.all,
    );
    expect(queriesToInvalidate({ type: 'schedule.changed', taskId: null })).toEqual([
      qk.schedules.all,
    ]);
    expect(
      queriesToInvalidate({ type: 'step.succeeded', taskId, data: { toolId: 'schedule.create' } }),
    ).toContainEqual(qk.schedules.all);
  });
  it('refreshes the thread and the task a conversation message belongs to', () => {
    const keys = queriesToInvalidate({
      type: 'conversation.message',
      taskId: null,
      data: { conversationId: taskId, taskId, role: 'assistant', kind: 'question' },
    });
    expect(keys).toContainEqual(qk.conversations.all);
    expect(keys).toContainEqual(qk.tasks.detail(taskId));
    expect(queriesToInvalidate({ type: 'conversation.changed', taskId: null })).toContainEqual(
      qk.conversations.all,
    );
  });
  it('refreshes webhooks for delivery and endpoint events', () => {
    expect(queriesToInvalidate({ type: 'webhook.delivery_failed', taskId: null })).toEqual([
      qk.webhooks.all,
    ]);
    expect(queriesToInvalidate({ type: 'webhook.endpoint_changed', taskId: null })).toEqual([
      qk.webhooks.all,
    ]);
  });
  it('also refreshes approvals for approval events', () => {
    expect(queriesToInvalidate({ type: 'approval.requested', taskId })).toContainEqual(
      qk.approvals,
    );
  });
  it('refreshes notifications and connections for their events', () => {
    expect(queriesToInvalidate({ type: 'notification.created', taskId: null })).toEqual([
      qk.notifications,
      qk.home,
    ]);
    expect(queriesToInvalidate({ type: 'connection.changed', taskId: null })).toContainEqual(
      qk.assistantStatus,
    );
  });
  it('ignores answer deltas and heartbeats', () => {
    expect(
      queriesToInvalidate({ type: 'step.succeeded', taskId, data: { toolId: 'memory.save' } }),
    ).toContainEqual(qk.memories.all);
    expect(queriesToInvalidate({ type: 'task.answer.delta', taskId })).toEqual([]);
    expect(queriesToInvalidate({ type: 'heartbeat', taskId: null })).toEqual([]);
  });
});

describe('safeNextPath', () => {
  it('allows same-origin paths', () => {
    expect(safeNextPath('/tasks/abc?x=1#y')).toBe('/tasks/abc?x=1#y');
    expect(safeNextPath('/')).toBe('/');
  });
  it('rejects open redirects and loops', () => {
    for (const bad of [
      '//evil.com',
      'https://evil.com',
      '/\\evil.com',
      'javascript:alert(1)',
      '/sign-in',
      '',
      null,
      '/%0d',
    ]) {
      const result = safeNextPath(bad);
      expect(result.startsWith('//')).toBe(false);
      expect(result === '/' || result.startsWith('/%')).toBe(true);
    }
    expect(safeNextPath('/sign-in?next=/x')).toBe('/');
  });
});

describe('buildCsp', () => {
  it('uses a nonce, forbids framing and only allows self-hosted fonts', () => {
    const csp = buildCsp('abc123', false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(buildCsp('n', true)).toContain("'unsafe-eval'");
  });
});
