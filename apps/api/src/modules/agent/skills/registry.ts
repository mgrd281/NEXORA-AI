/**
 * Skills registry — the 12 skills of docs/skills/*.md as static, versioned
 * TypeScript compiled into the server (docs/architecture/phase-b.md §3.4).
 *
 * A skill groups tools into a capability the user can switch off. It is
 * documentation plus three narrowing levers, never a source of permissions:
 *   - a disabled skill's tools are hidden from the planner (availableTools)
 *     and denied by the Policy Engine (SKILL_DISABLED);
 *   - a projected cost above the skill's limit adds an approval (SKILL_COST_LIMIT);
 *   - availability (connections, model, storage) is reported honestly per user.
 * The Policy Engine computes all of it from this table and the user's
 * preferences (assessStep); a skill cannot lower a risk, skip an approval or
 * allow anything.
 *
 * Third-party skill code is NOT loadable: there is no dynamic import, no
 * plugin directory and no manifest read from the database or the network.
 * Adding a skill is a reviewed code change to this file (and its tools to
 * tools/registry.ts), covered by the unit tests in test/unit/agent.
 */
import type { ConnectionProvider, RiskLevel, SkillId, ToolId } from '@jarvis/contracts';
import { ToolId as ToolIdEnum } from '@jarvis/contracts';
import { z } from 'zod';

export interface SkillDefinition {
  id: SkillId;
  /** Semver of this definition. */
  version: string;
  /** needs_connection is computed per user (skills/service.ts). */
  status: 'implemented' | 'planned';
  /** Implemented tools this skill OWNS (every ToolId has exactly one owner). */
  tools: readonly ToolId[];
  /** Tools it composes but does not own (switching the skill off does not deny them). */
  uses: readonly ToolId[];
  plannedTools: readonly string[];
  /** Planner guidance and evals; never used by the policy. */
  inputSchema: z.ZodType | null;
  outputSchema: z.ZodType | null;
  /** Declarative scopes (informational; the tools' own declarations are what the policy reads). */
  permissions: readonly string[];
  maxRisk: RiskLevel;
  requiredConnections: readonly ConnectionProvider[];
  modelUse: 'none' | 'optional' | 'required';
  /** Projected cost per step (micro-USD) above which the policy asks first; null = budget rules only. */
  maxCostPerRunMicroUsd: number | null;
  /** English developer documentation mirrored from docs/skills/<id>.md. */
  executionPolicy: string;
  verification: string;
  errorHandling: string;
  canToggle: boolean;
  docsPath: string;
}

const lang = z.enum(['en', 'de', 'ar']);

function planned(
  id: SkillId,
  plannedTools: string[],
  maxRisk: RiskLevel,
  requiredConnections: ConnectionProvider[] = [],
): SkillDefinition {
  return {
    id,
    version: '0.0.1',
    status: 'planned',
    tools: [],
    uses: [],
    plannedTools,
    inputSchema: null,
    outputSchema: null,
    permissions: [],
    maxRisk,
    requiredConnections,
    modelUse: 'optional',
    maxCostPerRunMicroUsd: null,
    executionPolicy: 'Not built yet: no tool exists, so nothing can be planned or run.',
    verification: 'Not applicable until the skill is built.',
    errorHandling: 'The planner says honestly that JARVIS cannot do this yet.',
    canToggle: false,
    docsPath: `docs/skills/${id}.md`,
  };
}

/** Registry order is the order clients list skills in. */
export const SKILLS: readonly SkillDefinition[] = [
  {
    id: 'web-research',
    version: '0.2.0',
    status: 'implemented',
    tools: ['web.fetch', 'text.summarize'],
    uses: [],
    plannedTools: ['web.search'],
    inputSchema: z.object({ url: z.string().url(), focus: z.string().optional(), language: lang }),
    outputSchema: z.object({ summary: z.string(), method: z.enum(['model', 'extractive']) }),
    permissions: ['web:read'],
    maxRisk: 'LOW',
    requiredConnections: ['web'],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: 100_000,
    executionPolicy:
      'URLs only from the user’s own requests; SSRF guard on every connection and redirect; page text is untrusted, flagged content taints later steps.',
    verification: 'HTTP 2xx, readable text, SHA-256 recorded; non-empty summary with its method.',
    errorHandling:
      'Transient network/5xx/429 errors retried twice; blocked addresses, 4xx and unreadable content fail without retry.',
    canToggle: true,
    docsPath: 'docs/skills/web-research.md',
  },
  {
    id: 'email-management',
    version: '0.2.0',
    status: 'implemented',
    tools: ['email.send'],
    uses: [],
    plannedTools: ['email.search', 'email.read', 'email.draft', 'email.reply'],
    inputSchema: z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() }),
    outputSchema: z.object({ messageId: z.string(), accepted: z.array(z.string()) }),
    permissions: ['email:send'],
    maxRisk: 'HIGH',
    requiredConnections: ['smtp'],
    modelUse: 'none',
    maxCostPerRunMicroUsd: null,
    executionPolicy:
      'Recipients literal from the user’s requests or the owner; MEDIUM (HIGH above 3 recipients); approval unless only to the owner with auto-approval on; exactly once per step.',
    verification: 'Every recipient accepted, none rejected, SMTP 250, Message-ID recorded.',
    errorHandling:
      'Failures before hand-over are retryable; an interrupted send is OUTCOME_UNKNOWN and never repeated without acknowledgement.',
    canToggle: true,
    docsPath: 'docs/skills/email-management.md',
  },
  planned('calendar-management', ['calendar.list_events', 'calendar.create_event'], 'HIGH'),
  planned('appointment-booking', ['browser.open', 'browser.act', 'phone.call'], 'HIGH'),
  planned('phone-calling', ['phone.call'], 'HIGH'),
  planned('shopping-assistant', ['web.search', 'browser.extract', 'commerce.purchase'], 'CRITICAL'),
  {
    id: 'document-analysis',
    version: '0.1.0',
    status: 'implemented',
    tools: ['document.analyze'],
    uses: ['email.send'],
    plannedTools: ['document.ocr'],
    inputSchema: z.object({
      attachmentId: z.string().uuid(),
      mode: z.enum(['summary', 'answer']),
      question: z.string().optional(),
      language: lang,
    }),
    outputSchema: z.object({ result: z.string(), pages: z.number(), methodNote: z.string() }),
    permissions: ['files:read'],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: 200_000,
    executionPolicy:
      'Only files attached in this conversation; parsed in the worker (pdf.js without eval, mammoth); text is untrusted and scanned for injected instructions; answers need a model.',
    verification:
      'Text extracted with page and character counts, SHA-256 matched, non-empty result.',
    errorHandling:
      'Encrypted, unreadable, image-only (no OCR) and over-long PDFs fail with a specific reason; storage outages are retried.',
    canToggle: true,
    docsPath: 'docs/skills/document-analysis.md',
  },
  {
    id: 'task-scheduling',
    version: '0.1.0',
    status: 'implemented',
    tools: ['schedule.create'],
    uses: [],
    plannedTools: ['schedule.update', 'schedule.delete'],
    inputSchema: z.object({ title: z.string(), request: z.string(), recurrence: z.unknown() }),
    outputSchema: z.object({ scheduleId: z.string(), nextRunAt: z.string() }),
    permissions: ['schedules:write'],
    maxRisk: 'MEDIUM',
    requiredConnections: [],
    modelUse: 'none',
    maxCostPerRunMicroUsd: null,
    executionPolicy:
      'Creating a schedule is MEDIUM and always needs approval (FUTURE_RUNS) showing the exact request and next runs; every run is planned and policy-checked again.',
    verification: 'Schedule stored with a computed next run.',
    errorHandling:
      'Limits and invalid recurrences fail the step; failed runs pause the schedule after 3 in a row; an exhausted budget pauses it.',
    canToggle: true,
    docsPath: 'docs/skills/task-scheduling.md',
  },
  {
    id: 'personal-memory',
    version: '0.2.0',
    status: 'implemented',
    tools: ['memory.save'],
    uses: ['conversation.recall'],
    plannedTools: [],
    inputSchema: z.object({ content: z.string(), kind: z.enum(['preference', 'fact']) }),
    outputSchema: z.object({ memoryId: z.string() }),
    permissions: ['memory:write'],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'none',
    maxCostPerRunMicroUsd: null,
    executionPolicy:
      'Only what the user asked to remember; text from an earlier result needs approval of the exact text and is refused when that result was flagged.',
    verification: 'Memory id returned and content matches.',
    errorHandling: 'Memory off in privacy settings denies the step (MEMORY_DISABLED).',
    canToggle: true,
    docsPath: 'docs/skills/personal-memory.md',
  },
  planned('device-automation', ['device.run_shortcut', 'device.set_reminder'], 'MEDIUM'),
  {
    id: 'translation',
    version: '0.1.0',
    status: 'implemented',
    tools: ['text.translate'],
    uses: [],
    plannedTools: [],
    inputSchema: z.object({ text: z.string(), target: z.string(), source: z.string().optional() }),
    outputSchema: z.object({ translation: z.string(), detectedSource: z.string() }),
    permissions: [],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'required',
    maxCostPerRunMicroUsd: 100_000,
    executionPolicy:
      'Needs an AI model (no offline translation); source text is untrusted data; fast tier up to 8 000 characters, balanced above.',
    verification:
      'Non-empty translation; numbers and links of the source preserved; target language recognised for en/de/ar.',
    errorHandling:
      'Unknown target languages fail with UNSUPPORTED_LANGUAGE; model errors retried once.',
    canToggle: true,
    docsPath: 'docs/skills/translation.md',
  },
  {
    id: 'workflow-planning',
    version: '0.2.0',
    status: 'implemented',
    tools: ['assistant.answer', 'assistant.clarify', 'conversation.recall'],
    uses: [],
    plannedTools: [],
    inputSchema: null,
    outputSchema: null,
    permissions: [],
    maxRisk: 'LOW',
    requiredConnections: [],
    modelUse: 'optional',
    maxCostPerRunMicroUsd: null,
    executionPolicy:
      'Core: plans are validated deterministically and every step passes the Policy Engine; asks instead of inventing missing information.',
    verification: 'Plan valid; every step verified.',
    errorHandling:
      'Invalid model plans get one repair attempt; offline requests it cannot plan fail honestly.',
    canToggle: false,
    docsPath: 'docs/skills/workflow-planning.md',
  },
];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));
const BY_TOOL = new Map<ToolId, SkillDefinition>();
for (const s of SKILLS) for (const t of s.tools) BY_TOOL.set(t, s);

export function getSkill(id: SkillId): SkillDefinition {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown skill ${id}`);
  return s;
}

/** The skill that owns a tool (total over ToolId; checked at load and by a unit test). */
export function skillOfTool(id: ToolId): SkillDefinition {
  const s = BY_TOOL.get(id);
  if (!s) throw new Error(`tool ${id} has no owning skill`);
  return s;
}

// Fail fast on a registry edit that leaves a tool without an owner or gives it two.
for (const id of ToolIdEnum.options) {
  const owners = SKILLS.filter((s) => s.tools.includes(id));
  if (owners.length !== 1)
    throw new Error(`tool ${id} must be owned by exactly one skill (found ${owners.length})`);
}
