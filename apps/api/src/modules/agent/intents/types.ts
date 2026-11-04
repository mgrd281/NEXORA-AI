/**
 * Phase C — the offline planner's per-domain intents (docs/architecture/phase-c.md §4).
 *
 * The offline planner (models/offline.ts) asks each domain's intents, in
 * order, after the Phase B intents that look at the conversation (answers to
 * a question, follow-ups on an earlier result, schedules, documents) and
 * before the Milestone 1 intents (memory, "summarize <url>", "email me: …").
 * The first intent that returns a result wins; `null` means "not mine".
 *
 * Rules every intent follows (the same as the rest of the offline planner):
 *  - deterministic: a pure function of the request and the context, en/de/ar;
 *  - recipients, attendees, URLs, amounts and quantities come only from the
 *    user's own words (or the account), never from results or pages;
 *  - when something essential is missing, ask (`clarify`) instead of guessing;
 *  - titles, objectives and step titles are ServerMessages (i18n MESSAGES keys);
 *  - plan only tools that are registered (the plan is validated against them);
 *    a tool whose connection is missing is still planned: the Policy Engine
 *    then explains it (CONNECTION_MISSING / CONNECTION_EXPIRED).
 * This file is frozen; the domain arrays are owned by their engineers.
 */
import type { Locale, MissingInfo, ServerMessage } from '@jarvis/contracts';
import { truncate } from '../../../lib/redact';
import { msg, render } from '../i18n';
import type { OfflinePlanContext, OfflinePlanResult } from '../models/offline';

export type { OfflinePlanContext, OfflinePlanResult };

export interface OfflineIntent {
  /** Stable id (tests, evals, logs), e.g. 'email.unread-summary'. */
  id: string;
  /** A plan (or a refusal, or a clarifying question) when the request is this intent; null otherwise. */
  plan(request: string, ctx: OfflinePlanContext): OfflinePlanResult | null;
}

/** A plan title as a server sentence (rendered in the request language, kept as a message). */
export const titled = (lang: Locale, m: ServerMessage) => ({
  title: truncate(render(lang, m), 80),
  titleMessage: m,
});

export const stepTitled = (lang: Locale, m: ServerMessage) => ({
  title: render(lang, m),
  titleMessage: m,
});

export const objective = (lang: Locale, m: ServerMessage) => ({
  objective: render(lang, m),
  objectiveMessage: m,
});

/** A one-step plan that asks the user (assistant.clarify) instead of guessing. */
export function clarify(lang: Locale, missing: MissingInfo[]): OfflinePlanResult {
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.clarify')),
      ...objective(lang, msg('objective.clarify')),
      steps: [
        {
          key: 's1',
          toolId: 'assistant.clarify',
          ...stepTitled(lang, msg('step.clarify')),
          input: { missing },
        },
      ],
    },
  };
}

/** Whether the user has an active connection of `provider` granting `capability`. */
export function hasCapability(
  ctx: OfflinePlanContext,
  capability: NonNullable<OfflinePlanContext['connections']>[number]['capabilities'][number],
): boolean {
  return (ctx.connections ?? []).some(
    (c) => c.status === 'active' && c.capabilities.includes(capability),
  );
}
