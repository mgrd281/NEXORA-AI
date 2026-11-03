/**
 * The plan contract shared by the model planner and the offline planner, and
 * its deterministic validator. Every plan — whoever produced it — passes
 * through validatePlan before anything is persisted or executed.
 */
import { ServerMessage, ToolId } from '@jarvis/contracts';
import { z } from 'zod';
import { sameAddress } from './policy';
import { findMalformedRefs, findRefs } from './templates';
import type { AnyTool } from './tools/types';

export const MAX_STEPS = 8;
export const MAX_TITLE = 80;

export const PlannedStep = z.object({
  key: z.string().regex(/^s[1-9]$/, 'step keys are s1 … s8'),
  toolId: ToolId,
  title: z.string().trim().min(1).max(120),
  /** Offline planner only: the title as a message, so clients render it in their locale. */
  titleMessage: ServerMessage.optional(),
  input: z.record(z.string(), z.unknown()),
});
export type PlannedStep = z.infer<typeof PlannedStep>;

export const Plan = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  /** Offline planner only (model plans are written in the request language). */
  titleMessage: ServerMessage.optional(),
  objective: z.string().trim().min(1).max(1000),
  objectiveMessage: ServerMessage.optional(),
  steps: z.array(PlannedStep).min(1).max(MAX_STEPS),
});
export type Plan = z.infer<typeof Plan>;

export interface PlanValidationContext {
  /** Tools the planner was allowed to use. */
  tools: ReadonlyMap<string, AnyTool>;
  /**
   * The user's request: recipients must appear in it literally (or be the
   * owner), fetched URLs must be on a site linked in it.
   */
  request: string;
  ownEmail: string;
}

export type PlanValidation = { ok: true; plan: Plan } | { ok: false; issues: string[] };

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Links as the offline planner reads them: with a scheme, or starting "www.".
const LINK_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»”’،؛؟]+$/;

/**
 * Origins (scheme://host[:port], normalised by URL) of the links written in
 * `text`. A link without a scheme ("www.example.com/…") stands for both
 * http and https.
 */
export function linkOrigins(text: string): Set<string> {
  const origins = new Set<string>();
  for (const m of text.matchAll(LINK_IN_TEXT)) {
    const raw = m[0].replace(TRAILING_PUNCT, '');
    for (const scheme of /^www\./i.test(raw) ? ['https://', 'http://'] : ['']) {
      try {
        origins.add(new URL(scheme + raw).origin);
      } catch {
        // Not a URL after all.
      }
    }
  }
  return origins;
}

function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Checks: shape, step keys (unique, in order), tool availability, each input
 * against its tool schema, references only to earlier steps' declared output
 * fields, no references in recipients/memory content/fetched URLs,
 * recipients limited to the owner's address or addresses written in the
 * request, and fetched URLs limited to sites (scheme + host + port) linked in
 * the request — so neither step outputs nor the owner's notes in the planner
 * prompt can pick where data is sent.
 */
export function validatePlan(candidate: unknown, ctx: PlanValidationContext): PlanValidation {
  // Titles longer than allowed are trimmed rather than rejected.
  if (candidate && typeof candidate === 'object' && typeof (candidate as Plan).title === 'string') {
    const c = candidate as Plan;
    if (c.title.length > MAX_TITLE) c.title = `${c.title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
  }
  const shape = Plan.safeParse(candidate);
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`),
    };
  }
  const plan = shape.data;
  const issues: string[] = [];
  const requestEmails = new Set(
    [...ctx.request.matchAll(EMAIL_IN_TEXT)].map((m) => m[0].toLowerCase()),
  );
  const requestOrigins = linkOrigins(ctx.request);
  const seen = new Map<string, AnyTool>();

  plan.steps.forEach((step, index) => {
    const where = `steps[${index}] (${step.key})`;
    if (step.key !== `s${index + 1}`) issues.push(`${where}: key must be "s${index + 1}"`);
    const tool = ctx.tools.get(step.toolId);
    if (!tool) {
      issues.push(`${where}: tool "${step.toolId}" is not available`);
      seen.set(step.key, undefined as unknown as AnyTool);
      return;
    }
    const planned = tool.validatePlanned?.(step.input) ?? [];
    for (const p of planned) issues.push(`${where}: ${p}`);

    const parsed = tool.inputSchema.safeParse(step.input);
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        issues.push(`${where}: input.${i.path.join('.')}: ${i.message}`);
    } else {
      // Store the normalised input (defaults applied, unknown keys stripped).
      step.input = parsed.data as Record<string, unknown>;
    }

    for (const bad of findMalformedRefs(step.input))
      issues.push(`${where}: malformed reference in input.${bad}`);
    for (const ref of findRefs(step.input)) {
      const target = seen.get(ref.stepKey);
      if (!seen.has(ref.stepKey)) {
        issues.push(
          `${where}: references {{${ref.stepKey}.${ref.field}}} — only earlier steps can be referenced`,
        );
      } else if (target && !target.outputFields.includes(ref.field)) {
        issues.push(
          `${where}: {{${ref.stepKey}.${ref.field}}} — ${target.id} has no output "${ref.field}" (available: ${target.outputFields.join(', ')})`,
        );
      }
    }

    if (parsed.success && tool.recipients && planned.length === 0) {
      for (const r of tool.recipients(parsed.data)) {
        if (!sameAddress(r, ctx.ownEmail) && !requestEmails.has(r.trim().toLowerCase()))
          issues.push(
            `${where}: recipient ${r} is neither the account owner nor an address written in the request`,
          );
      }
    }
    if (parsed.success && tool.urls && planned.length === 0) {
      for (const url of tool.urls(parsed.data)) {
        const origin = httpOrigin(url);
        if (!origin || !requestOrigins.has(origin))
          issues.push(
            `${where}: input.url (${origin ?? 'not an http(s) link'}) does not point at a site written in the request; only links the user wrote can be fetched`,
          );
      }
    }
    seen.set(step.key, tool);
  });

  return issues.length ? { ok: false, issues } : { ok: true, plan };
}
