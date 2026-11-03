/**
 * Scripted ModelAdapter for tests: deterministic responses, real cost math,
 * no network. Lets integration tests exercise model mode end to end.
 */
import type {
  ModelAdapter,
  ModelPurpose,
  ModelUsage,
  ObjectRequest,
  ObjectResult,
  TextRequest,
  TextResult,
} from '../../src/modules/agent/models/adapter';
import { costMicro } from '../../src/modules/agent/models/pricing';

export function usage(
  purpose: ModelPurpose,
  model: string,
  input: number,
  output: number,
): ModelUsage {
  return {
    provider: 'anthropic',
    model,
    purpose,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: costMicro(model, { input, output }),
  };
}

export interface Script {
  object?: (req: ObjectRequest<unknown>) => unknown | Promise<unknown>;
  text?: (req: TextRequest) => string | TextResult | Promise<string | TextResult>;
}

export class ScriptedModel implements ModelAdapter {
  readonly provider = 'anthropic';
  readonly calls: { purpose: ModelPurpose; model: string; system: string; user: string }[] = [];
  constructor(public script: Script = {}) {}

  private record(req: TextRequest | ObjectRequest<unknown>) {
    this.calls.push({
      purpose: req.purpose,
      model: req.model,
      system: req.system,
      user: req.messages.map((m) => m.content).join('\n'),
    });
  }

  async generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>> {
    this.record(req as ObjectRequest<unknown>);
    if (!this.script.object) throw new Error(`no scripted object response for ${req.purpose}`);
    const value = await this.script.object(req as ObjectRequest<unknown>);
    const parsed = req.schema.safeParse(value);
    const u = usage(req.purpose, req.model, 2_000, 600);
    return parsed.success
      ? { ok: true, value: parsed.data, usage: u }
      : {
          ok: false,
          raw: JSON.stringify(value),
          issues: parsed.error.issues.map((i) => i.message),
          usage: u,
        };
  }

  async generateText(req: TextRequest): Promise<TextResult> {
    this.record(req);
    if (!this.script.text) throw new Error(`no scripted text response for ${req.purpose}`);
    const out = await this.script.text(req);
    const result: TextResult =
      typeof out === 'string'
        ? { text: out, truncated: false, usage: usage(req.purpose, req.model, 1_500, 300) }
        : out;
    if (req.onDelta) {
      // Stream in a few chunks, like the real adapter.
      const text = result.text;
      const size = Math.max(1, Math.ceil(text.length / 3));
      for (let i = 0; i < text.length; i += size) await req.onDelta(text.slice(i, i + size));
    }
    return result;
  }
}
