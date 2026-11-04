/**
 * Eval scenario format (docs/evals.md, docs/architecture/phase-b.md §3.11).
 *
 * One JSON file per scenario under evals/scenarios/<suite>/. The core shape
 * is the one frozen in phase-b.md §3.11; the fields marked "extension" are
 * optional additions for things that design left open (pipeline-only checks,
 * fault injection, scripted model output, capability requirements).
 *
 * Placeholders, substituted per runner in every string of `given` and
 * `expect`:
 *   {{me}}     the account's own email address
 *   {{site}}   origin of the fixture website (pipeline: the local server;
 *              offline/model: https://site.eval.test, never contacted)
 *   {{down}}   origin of a host that refuses connections (network failure)
 *   {{turnN}}  task id of the N-th earlier turn of given.conversation (0-based)
 *   {{fileN}}  attachment id of the N-th file of given.attachments
 */
import {
  AttachmentMediaType,
  ConnectionCapability,
  ConnectionProvider,
  ConnectionStatus,
  Locale,
  MissingInfo,
  OAuthProvider,
  RiskLevel,
  TaskErrorReason,
  TaskOutcome,
  TaskStatus,
  ToolId,
} from '@jarvis/contracts';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Version of this file format; bump on incompatible changes (scenarios carry their own version). */
export const SCENARIO_FORMAT = 1;

export const SUITES = [
  'planning',
  'policy',
  'injection',
  'literalness',
  'clarify',
  'followup',
  'documents',
  'schedules',
  'spec',
  // Phase C (docs/architecture/phase-c.md §9): one suite per domain, each owned by its engineer.
  'connections',
  'email',
  'calendar',
  'booking',
  'shopping',
  // Phase D (docs/architecture/phase-d.md §9): the phone agent, owned by the telephony engineer.
  'telephony',
] as const;
export const Suite = z.enum(SUITES);
export type Suite = z.infer<typeof Suite>;

export const MODES = ['offline', 'model', 'pipeline'] as const;
export const Mode = z.enum(MODES);
export type Mode = z.infer<typeof Mode>;

const PolicyExpectation = z.object({
  step: z.number().int(),
  decision: z.enum(['allow', 'require_approval', 'deny']),
  reasonsInclude: z.array(z.string()).default([]),
  /** Extension: reasons that must not be present (e.g. AUTO_APPROVED_SELF under injection). */
  reasonsExclude: z.array(z.string()).default([]),
});

/** A simulated callee of the mock Twilio (pipeline mode): how the call ends and what is said. */
export const CalleeScenario = z.object({
  outcome: z.enum(['answer', 'busy', 'no-answer', 'failed', 'machine']).default('answer'),
  /** What the callee says to each of JARVIS's questions, in order. */
  turns: z.array(z.string().min(1)).default([]),
});
export type CalleeScenario = z.infer<typeof CalleeScenario>;

export const Scenario = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    suite: Suite,
    title: z.string(),
    modes: z.array(Mode).min(1),
    /**
     * Extension: capabilities the scenario needs ("tool:<ToolId>",
     * "export:<module under src>#<name>", "service:followUp", "storage").
     * When one is missing the scenario is reported as pending with the
     * reason — never skipped silently.
     */
    requires: z.array(z.string()).default([]),
    /**
     * Extension: a known gap in the product this scenario documents. While
     * it fails, it is reported as pending with this text (and its failures),
     * so CI stays green but every report lists it; once it passes it counts
     * as passed and the field should be removed.
     */
    knownIssue: z.string().min(10).optional(),
    given: z.object({
      request: z.string(),
      language: Locale.optional(),
      account: z.object({ email: z.string(), locale: Locale, timeZone: z.string() }).optional(),
      preferences: z.record(z.string(), z.unknown()).optional(),
      connections: z.array(ConnectionProvider).default(['web', 'smtp']),
      /** Extension: a status other than active for a connection (e.g. smtp: expired). */
      connectionStatus: z.partialRecord(ConnectionProvider, ConnectionStatus).optional(),
      /** Phase C: the capabilities each OAuth connection grants (default: none). */
      connectionCapabilities: z
        .partialRecord(OAuthProvider, z.array(ConnectionCapability))
        .optional(),
      /** Phase C: purchases already committed this month (USD); the limit is preferences.spending. */
      purchases: z.object({ spentUsd: z.number().min(0) }).optional(),
      /** Phase C: a browser worker is running (browser tools are offered to the planner). */
      browserAvailable: z.boolean().default(false),
      /**
       * Phase D: the telephony facts of the server and the account (absent: telephony not
       * configured, so call steps are hidden from the model planner and denied by the policy).
       */
      telephony: z
        .object({
          configured: z.boolean().default(true),
          /** CALL_ALLOWED_COUNTRIES (ISO alpha-2). */
          allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).default(['DE', 'GB', 'US']),
          allowedHours: z
            .object({ start: z.string(), end: z.string() })
            .default({ start: '08:00', end: '20:00' }),
          /** The clock of the calling-hours check (default: 10:00 in the account's zone today). */
          now: z.iso.datetime({ offset: true }).optional(),
          callsToday: z.number().int().min(0).default(0),
          maxPerDay: z.number().int().min(1).default(10),
          /** Numbers (E.164) on the account's do-not-call list. */
          doNotCall: z.array(z.string()).default([]),
          /** The account's own number (default country of national numbers; transfers). */
          ownPhone: z.object({ number: z.string(), verified: z.boolean() }).optional(),
          /**
           * Pipeline mode: the simulated callee of the mock Twilio (tools/mock-twilio) for the
           * scenario's call, and — for an acknowledged retry — of the next attempt.
           */
          callee: CalleeScenario.optional(),
          calleeOnRetry: CalleeScenario.optional(),
        })
        .optional(),
      conversation: z
        .array(
          z.object({
            request: z.string(),
            outcome: TaskOutcome,
            resultText: z.string(),
            flagged: z.boolean().default(false),
            /** Extension: what a 'question' turn asked for (default: re-derived from its request). */
            missing: z.array(MissingInfo).optional(),
          }),
        )
        .default([]),
      attachments: z
        .array(
          z.object({
            filename: z.string(),
            mediaType: AttachmentMediaType,
            fixture: z.string(),
            /** Extension: attached to an earlier request of the conversation, not this one. */
            earlier: z.boolean().default(false),
          }),
        )
        .default([]),
      /** URL → fixture (evals/fixtures/pages/<name>): what the site serves at that URL. */
      pages: z.record(z.string(), z.string()).default({}),
      /** Extension (pipeline): approve every approval JARVIS asks for, or reject the first. */
      approve: z.enum(['none', 'all', 'reject']).default('none'),
      /** Extension (pipeline): fault injection. */
      faults: z
        .object({
          /** The worker "dies" once right after this tool's side effect, before recording it. */
          crashAfterTool: ToolId.optional(),
        })
        .default({}),
      /**
       * Extension (model mode): planning responses of the scripted model, in
       * order (the second one answers the repair prompt). Used when no
       * ANTHROPIC_API_KEY is set, or always with `scriptOnly`.
       */
      model: z
        .object({
          plans: z.array(z.unknown()).min(1),
          /** The script is the point of the scenario (adversarial model output): never use a real model. */
          scriptOnly: z.boolean().default(false),
          /** The scripted model refuses (stop_reason refusal) instead of answering. */
          refuse: z.boolean().default(false),
        })
        .optional(),
      /**
       * Extension (offline): a corpus file of evals/fixtures/injection/ run
       * through the injection detector line by line; expect.flagged true
       * means every line must be flagged, false that none may be.
       */
      corpus: z.string().optional(),
      /**
       * Extension (offline): steps of a tool that does not exist in this build,
       * evaluated by the policy engine directly (no planner) — e.g. a
       * CRITICAL purchase action.
       */
      syntheticSteps: z
        .array(
          z.object({
            toolId: z.string(),
            risk: RiskLevel,
            sideEffect: z.enum(['none', 'internal', 'external']),
            requiredConnection: ConnectionProvider.nullable().default(null),
            /** Phase C facts a tool declares (docs/architecture/phase-c.md §4.1). */
            requirement: z
              .object({ provider: ConnectionProvider, capability: ConnectionCapability.optional() })
              .optional(),
            purchase: z
              .object({ amountUsd: z.number().min(0).nullable(), currency: z.string().nullable() })
              .optional(),
            attendees: z.array(z.string()).optional(),
            binding: z.boolean().optional(),
            /**
             * Phase D: the call the step places (tool.call), decided with given.telephony —
             * exactly the facts assessStep computes (step-policy.ts callPolicyFacts).
             */
            call: z
              .object({
                to: z.string(),
                calleeTimeZone: z.string().nullable().default(null),
                recording: z.enum(['off', 'if_consented', 'required']).default('off'),
                sharedDetails: z.number().int().min(0).default(0),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
    expect: z.object({
      result: z.enum(['plan', 'question', 'unsupported', 'deny']),
      toolSequence: z.array(ToolId).optional(),
      missing: z.array(MissingInfo).optional(),
      errorReason: TaskErrorReason.optional(),
      recipientsExactly: z.array(z.string()).optional(),
      urlsExactly: z.array(z.string()).optional(),
      policy: z.array(PolicyExpectation).optional(),
      flagged: z.boolean().optional(),
      sideEffectsAtMost: z.number().int().optional(),
      /** Extension: the schedule a schedule.create step proposes. */
      schedule: z
        .object({
          recurrence: z.record(z.string(), z.unknown()).optional(),
          requestIncludes: z.array(z.string()).optional(),
        })
        .optional(),
      /** Extension: checks only the pipeline can make (the task as the worker left it). */
      pipeline: z
        .object({
          status: TaskStatus.optional(),
          outcome: TaskOutcome.nullable().optional(),
          errorCode: z.string().optional(),
          errorReason: TaskErrorReason.optional(),
          retryable: z.boolean().optional(),
          sideEffectsExactly: z.number().int().optional(),
          /** A retry without acknowledging an unknown outcome must be refused. */
          retryNeedsAcknowledgement: z.boolean().optional(),
          /** How many times each tool's side effect / read was executed. */
          executions: z.partialRecord(ToolId, z.number().int()).optional(),
          /** After the run, a schedule exists (schedule.create approved). */
          schedulesCreated: z.number().int().optional(),
          /**
           * Make the user's schedules due and run the scheduler (twice per
           * occurrence): this many tasks with source "schedule" must exist.
           */
          scheduledTasksCreated: z.number().int().optional(),
          /** Phase C: evidence files (screenshots, extracts, ICS) the task stored, at least. */
          evidenceAtLeast: z.number().int().nonnegative().optional(),
          /**
           * Phase C (scenario 10): after the checks above, retry the task acknowledging the
           * unknown outcome (approving again if asked) and check the task afterwards.
           */
          acknowledgedRetry: z
            .object({
              status: TaskStatus.optional(),
              sideEffectsExactly: z.number().int().optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  })
  .superRefine((s, ctx) => {
    if (s.given.syntheticSteps && s.modes.some((m) => m !== 'offline'))
      ctx.addIssue({
        code: 'custom',
        message: 'syntheticSteps are evaluated in offline mode only',
      });
    if (
      s.given.corpus !== undefined &&
      (s.modes.some((m) => m !== 'offline') || s.expect.flagged === undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'a corpus scenario runs offline only and needs expect.flagged',
      });
  });
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;

export interface LoadedScenario extends Scenario {
  /** Path relative to evals/scenarios. */
  file: string;
}

export const EVALS_DIR = path.resolve(import.meta.dirname, '..');
export const SCENARIOS_DIR = path.join(EVALS_DIR, 'scenarios');
export const FIXTURES_DIR = path.join(EVALS_DIR, 'fixtures');

/**
 * Every scenario, validated: ids unique, each file in the directory of its
 * suite, named after its id. Throws with all problems at once.
 */
export async function loadScenarios(dir = SCENARIOS_DIR): Promise<LoadedScenario[]> {
  const problems: string[] = [];
  const out: LoadedScenario[] = [];
  const seen = new Map<string, string>();
  for (const suite of (await readdir(dir, { withFileTypes: true })).filter((d) =>
    d.isDirectory(),
  )) {
    for (const name of (await readdir(path.join(dir, suite.name))).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = `${suite.name}/${name}`;
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      } catch (e) {
        problems.push(`${file}: invalid JSON (${(e as Error).message})`);
        continue;
      }
      const parsed = Scenario.safeParse(raw);
      if (!parsed.success) {
        for (const i of parsed.error.issues)
          problems.push(`${file}: ${i.path.join('.')}: ${i.message}`);
        continue;
      }
      const s = parsed.data;
      if (s.suite !== suite.name)
        problems.push(`${file}: suite "${s.suite}" but stored under ${suite.name}/`);
      if (`${s.id}.json` !== name) problems.push(`${file}: file name must be ${s.id}.json`);
      const other = seen.get(s.id);
      if (other) problems.push(`${file}: id ${s.id} already used by ${other}`);
      seen.set(s.id, file);
      out.push({ ...s, file });
    }
  }
  if (problems.length) throw new Error(`Invalid scenarios:\n  ${problems.join('\n  ')}`);
  return out.sort(
    (a, b) => SUITES.indexOf(a.suite) - SUITES.indexOf(b.suite) || a.id.localeCompare(b.id),
  );
}

export interface Placeholders {
  me: string;
  site: string;
  down: string;
  turns: readonly string[];
  files: readonly string[];
}

/**
 * `{{weekday+N}}`: the local date (Europe/Berlin, YYYY-MM-DD) N days from now, moved to the
 * next weekday — a date that stays in the future whenever the suite runs (booking scenarios).
 */
export function weekdayAhead(days: number, now = new Date()): string {
  let d = new Date(now.getTime() + days * 86_400_000);
  for (;;) {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
    const wd = new Date(`${local}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return local;
    d = new Date(d.getTime() + 86_400_000);
  }
}

/** Substitutes the placeholders in every string of a JSON value. */
export function substitute<T>(value: T, p: Placeholders): T {
  const one = (s: string) =>
    s
      .replace(/\{\{weekday\+(\d+)\}\}/g, (_m, n: string) => weekdayAhead(Number(n)))
      .replaceAll('{{me}}', p.me)
      .replaceAll('{{site}}', p.site)
      .replaceAll('{{down}}', p.down)
      .replace(/\{\{turn(\d+)\}\}/g, (m, n: string) => p.turns[Number(n)] ?? m)
      .replace(/\{\{file(\d+)\}\}/g, (m, n: string) => p.files[Number(n)] ?? m);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return one(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [one(k), walk(x)]));
    return v;
  };
  return walk(value) as T;
}
