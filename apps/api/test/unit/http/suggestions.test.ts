import { describe, expect, it } from 'vitest';
import { Suggestion } from '@jarvis/contracts';
import {
  deriveSuggestions,
  MAX_SUGGESTIONS,
  type SuggestionState,
} from '../../../src/modules/home/suggestions';

const base: SuggestionState = {
  webActive: false,
  emailActive: false,
  plannerOffline: false,
  memoryEnabled: true,
  hasMemories: false,
};
const keys = (s: Partial<SuggestionState>) =>
  deriveSuggestions({ ...base, ...s }).map((x) => x.messageKey);

describe('deriveSuggestions', () => {
  it('asks a new user to connect services first, capped at three', () => {
    expect(keys({ plannerOffline: true })).toEqual([
      'suggest.enableWeb',
      'suggest.connectEmail',
      'suggest.configureModel',
    ]);
    expect(keys({})).toEqual(['suggest.enableWeb', 'suggest.connectEmail', 'suggest.remember']);
  });

  it('suggests the summarize-and-email command only when web and email both work', () => {
    expect(keys({ webActive: true, emailActive: true, hasMemories: true })).toEqual([
      'suggest.summarizeAndEmail',
    ]);
    expect(keys({ webActive: true, emailActive: false, hasMemories: true })).toEqual([
      'suggest.connectEmail',
    ]);
    expect(keys({ webActive: false, emailActive: true, hasMemories: true })).toEqual([
      'suggest.enableWeb',
    ]);
  });

  it('suggests remembering something only when memory is on and empty', () => {
    const ready = { webActive: true, emailActive: true };
    expect(keys({ ...ready })).toEqual(['suggest.summarizeAndEmail', 'suggest.remember']);
    expect(keys({ ...ready, hasMemories: true })).toEqual(['suggest.summarizeAndEmail']);
    expect(keys({ ...ready, memoryEnabled: false })).toEqual(['suggest.summarizeAndEmail']);
  });

  it('points an offline planner at the assistant settings', () => {
    const [s] = deriveSuggestions({
      ...base,
      webActive: true,
      emailActive: true,
      hasMemories: true,
      plannerOffline: true,
    });
    expect(s).toEqual({
      id: 'configure-model',
      kind: 'review',
      messageKey: 'suggest.configureModel',
      command: null,
      href: '/settings#assistant',
    });
  });

  it('offers no setup suggestions once everything is set up', () => {
    const out = deriveSuggestions({
      webActive: true,
      emailActive: true,
      plannerOffline: false,
      memoryEnabled: false,
      hasMemories: false,
    });
    expect(out.map((s) => s.kind)).toEqual(['command']);
  });

  it('always produces contract-valid suggestions with unique ids', () => {
    for (let mask = 0; mask < 32; mask++) {
      const out = deriveSuggestions({
        webActive: !!(mask & 1),
        emailActive: !!(mask & 2),
        plannerOffline: !!(mask & 4),
        memoryEnabled: !!(mask & 8),
        hasMemories: !!(mask & 16),
      });
      expect(out.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
      expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
      for (const s of out) {
        expect(Suggestion.parse(s)).toEqual(s);
        if (s.kind === 'command') expect([s.command, s.href]).toEqual([null, null]);
        else expect(s.href).toMatch(/^\//);
      }
    }
  });
});
