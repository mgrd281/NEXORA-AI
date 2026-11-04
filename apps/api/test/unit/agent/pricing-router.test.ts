import { describe, expect, it } from 'vitest';
import {
  costMicro,
  estimateTokens,
  isKnownModel,
  priceFor,
  usdToMicro,
} from '../../../src/modules/agent/models/pricing';
import {
  decideRoute,
  LONG_TEXT_CHARS,
  selectModel,
} from '../../../src/modules/agent/models/router';

const models = {
  MODEL_FAST: 'claude-haiku-5-5',
  MODEL_BALANCED: 'claude-sonnet-5-5',
  MODEL_DEEP: 'claude-opus-5-5',
};

describe('cost math (micro-USD)', () => {
  it('prices the 5.5 generation per million tokens', () => {
    // Haiku below its 100k-token long-context threshold: 100k × $0.10 + 100k × $0.50
    expect(costMicro('claude-haiku-5-5', { input: 100_000, output: 100_000 })).toBe(60_000);
    // Sonnet / Opus: 1M input + 1M output
    expect(costMicro('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000 })).toBe(
      12_000_000,
    );
    expect(costMicro('claude-opus-5-5', { input: 1_000_000, output: 1_000_000 })).toBe(24_000_000);
  });

  it('computes realistic request costs and rounds up once', () => {
    // Opus planning: 3,000 in × $4 + 1,200 out × $20 = 12,000 + 24,000 µ$
    expect(costMicro('claude-opus-5-5', { input: 3_000, output: 1_200 })).toBe(36_000);
    // Haiku: 3 tokens × $0.10 = 0.3 µ$ → 1 µ$
    expect(costMicro('claude-haiku-5-5', { input: 3, output: 0 })).toBe(1);
    expect(costMicro('claude-haiku-5-5', { input: 0, output: 0 })).toBe(0);
  });

  it('bills cache reads and writes', () => {
    // Sonnet: 10k cache read × $0.20 + 10k cache write × $2.50
    expect(
      costMicro('claude-sonnet-5-5', {
        input: 0,
        output: 0,
        cacheRead: 10_000,
        cacheWrite: 10_000,
      }),
    ).toBe(27_000);
  });

  it('applies Haiku long-context pricing above 100k input tokens', () => {
    expect(costMicro('claude-haiku-5-5', { input: 200_000, output: 1_000 })).toBe(
      200_000 * 0.5 + 1_000 * 2.5,
    );
  });

  it('bills unknown models at the most expensive known rate', () => {
    expect(isKnownModel('claude-mystery-9')).toBe(false);
    expect(priceFor('claude-mystery-9').outputPerMTok).toBeGreaterThanOrEqual(
      priceFor('claude-opus-5-5').outputPerMTok,
    );
  });

  it('converts USD and estimates tokens', () => {
    expect(usdToMicro(20)).toBe(20_000_000);
    expect(usdToMicro(0.000001)).toBe(1);
    expect(estimateTokens(3_500)).toBe(1_000);
  });
});

describe('model router', () => {
  const base = {
    apiKeyConfigured: true,
    allowExternalModels: true,
    budgetMicro: 20_000_000,
    spentMicro: 0,
  };
  it('routes to the model when everything allows it', () => {
    expect(decideRoute(base)).toEqual({ mode: 'model', provider: 'anthropic', reason: null });
  });
  it.each([
    [{ apiKeyConfigured: false }, 'NO_API_KEY'],
    [{ allowExternalModels: false }, 'USER_DISABLED_EXTERNAL_MODELS'],
    [{ spentMicro: 20_000_000 }, 'BUDGET_EXHAUSTED'],
    [{ budgetMicro: 0 }, 'BUDGET_EXHAUSTED'],
  ])('%o → offline %s', (patch, reason) => {
    expect(decideRoute({ ...base, ...patch })).toEqual({ mode: 'offline', provider: null, reason });
  });

  it('maps purposes to tiers', () => {
    // Planning: Sonnet by default; Opus only when the user chose it (preferences.ai.planningModel).
    expect(selectModel(models, 'planning')).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    });
    expect(selectModel(models, 'planning', { planningModel: 'balanced' }).model).toBe(
      'claude-sonnet-5-5',
    );
    expect(selectModel(models, 'planning', { planningModel: 'deep' })).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
    expect(selectModel(models, 'answer').model).toBe('claude-sonnet-5-5');
    expect(selectModel(models, 'summarize', { inputChars: 1_000 }).model).toBe('claude-haiku-5-5');
    expect(selectModel(models, 'summarize', { inputChars: LONG_TEXT_CHARS + 1 }).model).toBe(
      'claude-sonnet-5-5',
    );
    expect(selectModel(models, 'result_summary').model).toBe('claude-haiku-5-5');
    // Phase D: one structured decision per callee turn on a call — balanced, low effort, small.
    expect(selectModel(models, 'call_dialog')).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      maxTokens: 1_000,
    });
  });
});
