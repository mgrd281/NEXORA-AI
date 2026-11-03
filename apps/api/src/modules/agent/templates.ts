/**
 * Step references: a string field of a planned step may contain
 * `{{s1.text}}` to use an earlier step's output field. Resolution is a
 * single pass of plain substitution — substituted values are never parsed
 * again, so content fetched from the web cannot inject new references.
 */
import { AgentError } from './errors';

const REF = /\{\{\s*([A-Za-z][\w-]{0,31})\.([A-Za-z][\w]{0,63})\s*\}\}/g;
const ANY_BRACES = /\{\{|\}\}/;

export interface TemplateRef {
  stepKey: string;
  field: string;
}

export function hasTemplate(s: string): boolean {
  return ANY_BRACES.test(s);
}

function walkStrings(value: unknown, visit: (s: string, path: string) => void, path = ''): void {
  if (typeof value === 'string') return visit(value, path);
  if (Array.isArray(value)) return value.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, visit, path ? `${path}.${k}` : k);
  }
}

/** All references in a (possibly nested) input object. */
export function findRefs(value: unknown): TemplateRef[] {
  const out: TemplateRef[] = [];
  walkStrings(value, (s) => {
    for (const m of s.matchAll(REF)) out.push({ stepKey: m[1]!, field: m[2]! });
  });
  return out;
}

/**
 * Strings that contain `{{` or `}}` but are not well-formed references.
 * Returned as "path: text" for validation messages.
 */
export function findMalformedRefs(value: unknown): string[] {
  const out: string[] = [];
  walkStrings(value, (s, path) => {
    const stripped = s.replace(REF, '');
    if (ANY_BRACES.test(stripped)) out.push(path || '(value)');
  });
  return out;
}

export type StepOutputs = Record<string, Record<string, unknown> | null | undefined>;

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function resolveString(s: string, outputs: StepOutputs): string {
  return s.replace(REF, (_m, key: string, field: string) => {
    const out = outputs[key];
    if (!out || !(field in out)) {
      throw new AgentError(
        'TOOL_FAILED',
        `This step needs “${field}” from step ${key}, which is not available.`,
        { retryable: true },
      );
    }
    return stringify(out[field]);
  });
}

/** Deep-copies `value`, substituting every reference. Throws if one is unavailable. */
export function resolveTemplates<T>(value: T, outputs: StepOutputs): T {
  if (typeof value === 'string') return resolveString(value, outputs) as T;
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, outputs)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplates(v, outputs);
    return out as T;
  }
  return value;
}
