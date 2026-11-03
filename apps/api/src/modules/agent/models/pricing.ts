/**
 * Model price table and cost math. All money is integer micro-USD.
 *
 * Prices are USD per million tokens, which is numerically identical to
 * micro-USD per token — so cost = Σ tokens × price, rounded up once.
 * Source: Anthropic first-party API list prices (Claude 5.5 generation:
 * Haiku $0.10/$0.50, Sonnet $2/$10, Opus $4/$20). Cache writes (5-minute TTL)
 * bill at 1.25× input; cache reads at the listed read price (or 0.1× input).
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** Higher rate once a single request's input exceeds `thresholdTokens`. */
  longContext?: { thresholdTokens: number; inputPerMTok: number; outputPerMTok: number };
}

function price(input: number, output: number, cacheRead?: number): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead ?? input * 0.1,
    cacheWritePerMTok: input * 1.25,
  };
}

const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    ...price(0.1, 0.5),
    longContext: { thresholdTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  },
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-opus-5-5': price(4, 20, 0.2),
  // Models a server-side refusal fallback may hand a request to.
  'claude-sonnet-5': price(2, 10),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-fable-5': price(10, 50),
  'claude-fable-5-1': price(10, 50, 0.25),
};

/** Unknown model ids are billed at the most expensive known rate — never under-count. */
const MOST_EXPENSIVE = Object.values(PRICES).reduce((a, b) =>
  b.outputPerMTok > a.outputPerMTok ? b : a,
);

export function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? MOST_EXPENSIVE;
}

export function isKnownModel(model: string): boolean {
  return model in PRICES;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function costMicro(model: string, t: TokenCounts): number {
  const p = priceFor(model);
  const cacheRead = t.cacheRead ?? 0;
  const cacheWrite = t.cacheWrite ?? 0;
  const totalInput = t.input + cacheRead + cacheWrite;
  const long = p.longContext && totalInput > p.longContext.thresholdTokens ? p.longContext : null;
  const inRate = long ? long.inputPerMTok : p.inputPerMTok;
  const outRate = long ? long.outputPerMTok : p.outputPerMTok;
  const raw =
    t.input * inRate +
    t.output * outRate +
    cacheRead * p.cacheReadPerMTok +
    cacheWrite * p.cacheWritePerMTok;
  // Round once, up, and guard against float noise (e.g. 0.1 × 3 = 0.30000000000000004).
  return Math.max(0, Math.ceil(raw - 1e-9));
}

/** Rough token estimate for budgeting before a call (≈3.5 chars/token, conservative). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 3.5);
}

export const usdToMicro = (usd: number): number => Math.round(usd * 1_000_000);
