import { describe, expect, it } from 'vitest';
import {
  auditEventKey,
  auditTargetKey,
  groupAuditEvents,
  isLowRate,
  orderedStatusCounts,
  shortId,
  successRate,
  toolLabelKey,
} from './format';

describe('admin formatting', () => {
  it('computes success rates and leaves unused tools without one', () => {
    expect(successRate(2, 3)).toBeCloseTo(2 / 3);
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(5, 4)).toBe(1);
  });

  it('orders task counts by lifecycle, drops zeros and keeps unknown statuses last', () => {
    expect(
      orderedStatusCounts({ FAILED: 1, LEGACY: 2, QUEUED: 3, RUNNING: 0, COMPLETED: 4 }),
    ).toEqual([
      { status: 'QUEUED', count: 3, known: true },
      { status: 'COMPLETED', count: 4, known: true },
      { status: 'FAILED', count: 1, known: true },
      { status: 'LEGACY', count: 2, known: false },
    ]);
  });

  it('names known tools and shortens ids', () => {
    expect(toolLabelKey('web.fetch')).toBe('common.tools.webFetch');
    expect(toolLabelKey('calendar.create')).toBeNull();
    expect(shortId('1c7e9b4f-3d62-4e8b-8f21-6a4d3b2c8e02')).toBe('1c7e9b4f');
    expect(shortId('42')).toBe('42');
  });
});

describe('audit log rows', () => {
  const ev = (id: string, action: string, actorId: string | null = 'a') => ({
    id,
    action,
    actorId,
  });

  it('words known actions and targets, and leaves unknown ones raw', () => {
    expect(auditEventKey('auth.login')).toBe('admin.audit.events.auth.login');
    expect(auditEventKey('memory.deleted_all')).toBe('admin.audit.events.memory.deleted_all');
    expect(auditEventKey('calendar.created')).toBeNull();
    expect(auditEventKey('auth')).toBeNull();
    expect(auditTargetKey('task_step')).toBe('admin.audit.targets.task_step');
    expect(auditTargetKey('invoice')).toBeNull();
  });

  it('collapses consecutive admin views by one actor and keeps everything else', () => {
    const events = [
      ev('1', 'admin.audit_viewed'),
      ev('2', 'admin.users_viewed'),
      ev('3', 'admin.users_viewed', 'b'),
      ev('4', 'auth.login'),
      ev('5', 'admin.users_viewed'),
    ];
    const rows = groupAuditEvents(events, true);
    expect(rows.map((r) => [r.kind, r.key, r.kind === 'adminViews' ? r.count : 1])).toEqual([
      ['adminViews', '1', 2],
      ['event', '3', 1],
      ['event', '4', 1],
      ['event', '5', 1],
    ]);
    expect(groupAuditEvents(events, false).every((r) => r.kind === 'event')).toBe(true);
  });

  it('flags low success rates', () => {
    expect(isLowRate(0.75)).toBe(true);
    expect(isLowRate(0.9)).toBe(false);
    expect(isLowRate(null)).toBe(false);
  });
});
