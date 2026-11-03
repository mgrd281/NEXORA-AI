import { describe, expect, it } from 'vitest';
import { TaskStatus } from '../src/enums';
import {
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  assertTransition,
  canCancel,
  canRetry,
  canRetryTask,
  isTerminal,
} from '../src/task-state';
import { routes, buildPath } from '../src/routes';

describe('task state machine', () => {
  it('covers every status', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TaskStatus.options].sort());
  });
  it('terminal states have no forward transitions except retry', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(TASK_TRANSITIONS[s].every((t) => t === 'QUEUED')).toBe(true);
    }
  });
  it('completed and cancelled are final', () => {
    expect(TASK_TRANSITIONS.COMPLETED).toEqual([]);
    expect(TASK_TRANSITIONS.CANCELLED).toEqual([]);
  });
  it('verification cannot be cancelled mid-flight', () => {
    expect(canCancel('VERIFYING')).toBe(false);
    expect(canCancel('AWAITING_APPROVAL')).toBe(true);
  });
  it('only failed or expired tasks can be retried', () => {
    expect(TaskStatus.options.filter(canRetry).sort()).toEqual(['EXPIRED', 'FAILED']);
  });
  it('a retry is offered only when it can help', () => {
    const failed = (code: Parameters<typeof canRetryTask>[0]['error'] & object) => ({
      status: 'FAILED' as const,
      error: code,
    });
    // Would only fail the same way again.
    expect(canRetryTask(failed({ code: 'FETCH_BLOCKED', retryable: false }))).toBe(false);
    expect(canRetryTask(failed({ code: 'VALIDATION_FAILED', retryable: false }))).toBe(false);
    expect(canRetryTask(failed({ code: 'TOOL_FAILED', retryable: false }))).toBe(false);
    // Transient, or fixable outside the task (connect an account, raise the budget).
    expect(canRetryTask(failed({ code: 'TOOL_TIMEOUT', retryable: true }))).toBe(true);
    expect(canRetryTask(failed({ code: 'CONNECTION_REQUIRED', retryable: true }))).toBe(true);
    // Needs the user's confirmation, but is allowed.
    expect(canRetryTask(failed({ code: 'OUTCOME_UNKNOWN', retryable: false }))).toBe(true);
    // The offline planner cannot answer; a model could.
    const unsupported = failed({ code: 'PLANNER_UNSUPPORTED', retryable: false });
    expect(canRetryTask(unsupported)).toBe(false);
    expect(canRetryTask(unsupported, { modelAvailable: false })).toBe(false);
    expect(canRetryTask(unsupported, { modelAvailable: true })).toBe(true);
    // Expired approvals can always be asked again; finished or running tasks never.
    expect(
      canRetryTask({ status: 'EXPIRED', error: { code: 'APPROVAL_EXPIRED', retryable: true } }),
    ).toBe(true);
    expect(canRetryTask({ status: 'COMPLETED', error: null })).toBe(false);
    expect(canRetryTask({ status: 'RUNNING', error: null })).toBe(false);
    expect(canRetryTask({ status: 'FAILED', error: null })).toBe(true);
  });
  it('rejects illegal transitions', () => {
    expect(() => assertTransition('COMPLETED', 'RUNNING')).toThrow(/Invalid task transition/);
    expect(() => assertTransition('QUEUED', 'COMPLETED')).toThrow();
    expect(() => assertTransition('RUNNING', 'VERIFYING')).not.toThrow();
  });
  it('isTerminal matches the terminal list', () => {
    expect(TaskStatus.options.filter(isTerminal).sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
});

describe('route table', () => {
  it('has unique method+path pairs', () => {
    const keys = Object.values(routes).map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('builds paths and encodes params', () => {
    expect(buildPath('/v1/tasks/:id', { id: 'a b' })).toBe('/v1/tasks/a%20b');
    expect(() => buildPath('/v1/tasks/:id')).toThrow();
  });
});
