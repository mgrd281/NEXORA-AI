import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, Preferences, UpdateMeRequest } from '../src/schemas';

describe('preferences.ai.planningModel', () => {
  it('defaults to the balanced tier (Sonnet) for stored preferences without it', () => {
    const stored = { ...DEFAULT_PREFERENCES, ai: { allowExternalModels: true } };
    expect(Preferences.parse(stored).ai.planningModel).toBe('balanced');
  });

  it('a PATCH that omits planningModel does not reset it', () => {
    const patch = UpdateMeRequest.parse({ preferences: { ai: { allowExternalModels: false } } });
    expect(patch.preferences?.ai).toEqual({ allowExternalModels: false });
  });

  it('accepts deep and rejects unknown tiers', () => {
    expect(
      UpdateMeRequest.parse({ preferences: { ai: { planningModel: 'deep' } } }).preferences?.ai,
    ).toEqual({ planningModel: 'deep' });
    expect(
      UpdateMeRequest.safeParse({ preferences: { ai: { planningModel: 'gpt' } } }).success,
    ).toBe(false);
  });
});
