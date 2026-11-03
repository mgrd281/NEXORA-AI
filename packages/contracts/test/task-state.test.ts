import { describe, expect, it } from 'vitest';
import { TaskStatus } from '../src/enums';
import {
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  assertTransition,
  canCancel,
  canRetry,
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
