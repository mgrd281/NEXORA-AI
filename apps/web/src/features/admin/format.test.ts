import { describe, expect, it } from 'vitest';
import { orderedStatusCounts, shortId, successRate, toolLabelKey } from './format';

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
