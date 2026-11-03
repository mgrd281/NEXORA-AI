import { describe, expect, it } from 'vitest';
import { memoryPreview, wasEdited } from './preview';

describe('memoryPreview', () => {
  it('keeps short memories whole and collapses whitespace', () => {
    expect(memoryPreview('Prefers  aisle\nseats')).toBe('Prefers aisle seats');
  });

  it('cuts long memories at a word boundary', () => {
    const preview = memoryPreview(
      'My manager is Sam Okafor and our weekly sync is on Tuesdays at ten',
    );
    expect(preview).toBe('My manager is Sam Okafor and our weekly…');
    expect(preview.length).toBeLessThanOrEqual(41);
  });

  it('cuts text without spaces at the limit', () => {
    expect(memoryPreview('x'.repeat(60), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('wasEdited', () => {
  it('ignores clock noise between created and updated', () => {
    expect(wasEdited('2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.400Z')).toBe(false);
    expect(wasEdited('2026-11-03T10:00:00.000Z', '2026-11-03T11:00:00.000Z')).toBe(true);
  });
});
