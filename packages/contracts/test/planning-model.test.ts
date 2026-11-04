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

describe('natural voice', () => {
  it('speech requests carry text and a language, bounded', async () => {
    const { SpeechRequest, SPEECH_LIMITS } = await import('../src/schemas');
    const { routes } = await import('../src/routes');
    expect(SpeechRequest.safeParse({ text: 'Hallo', language: 'de' }).success).toBe(true);
    expect(SpeechRequest.safeParse({ text: ' ', language: 'de' }).success).toBe(false);
    expect(
      SpeechRequest.safeParse({ text: 'x'.repeat(SPEECH_LIMITS.maxTextChars + 1), language: 'de' })
        .success,
    ).toBe(false);
    expect(routes.synthesizeSpeech.download.mediaTypes).toEqual(['audio/mpeg']);
    expect(routes.synthesizeSpeech.auth).toBe('user');
  });
});
