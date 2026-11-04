/**
 * Tool registry — the backend source of truth for what JARVIS can do.
 * Each tool declares its contract (schemas, risk, side effects, idempotency,
 * timeout, retry policy, cost estimate, preview, approval details, execute,
 * verify); the planner sees only the catalog derived from it and the policy
 * engine and executor enforce it.
 */
import type { ConnectionProvider, SkillId, ToolId } from '@jarvis/contracts';
import { z } from 'zod';
import { skillOfTool } from '../skills/registry';
import { assistantAnswerTool } from './assistant-answer';
import { browserTools } from './browser';
import { assistantClarifyTool } from './assistant-clarify';
import { conversationRecallTool } from './conversation-recall';
import { documentAnalyzeTool } from './document-analyze';
import { emailSendTool } from './email-send';
import { integrationTools } from './integrations';
import { memorySaveTool } from './memory-save';
import { scheduleCreateTool } from './schedule-create';
import { telephonyTools } from './telephony';
import { textSummarizeTool } from './text-summarize';
import { textTranslateTool } from './text-translate';
import type { AnyTool, ConnectionRequirement, ConnectionState } from './types';
import { webFetchTool } from './web-fetch';
import { RECALLABLE_FIELD } from '../conversation-context';

export type { AnyTool, ToolDefinition, ToolResult, ToolRuntime, Verification } from './types';

const ALL: AnyTool[] = [
  webFetchTool,
  textSummarizeTool,
  emailSendTool,
  memorySaveTool,
  assistantAnswerTool,
  // Phase B
  documentAnalyzeTool,
  textTranslateTool,
  scheduleCreateTool,
  conversationRecallTool,
  assistantClarifyTool,
  // Phase C: one array per domain, each owned by one engineer (docs/architecture/phase-c.md §2).
  ...integrationTools,
  ...browserTools,
  // Phase D (docs/architecture/phase-d.md §2): owned by the telephony engineer.
  ...telephonyTools,
];

// A domain array must not register an id twice or shadow a core tool.
{
  const seen = new Set<string>();
  for (const t of ALL) {
    if (seen.has(t.id)) throw new Error(`tool ${t.id} is registered twice`);
    seen.add(t.id);
  }
}

// Phase C: a tool's text result is what conversation.recall returns and JARVIS says.
for (const t of ALL) if (t.resultTextField) RECALLABLE_FIELD[t.id] = t.resultTextField;

export const TOOLS: ReadonlyMap<ToolId, AnyTool> = new Map(ALL.map((t) => [t.id, t]));

export function getTool(id: string): AnyTool | undefined {
  return TOOLS.get(id as ToolId);
}

export function listTools(): AnyTool[] {
  return [...ALL];
}

/**
 * Tools the planner may use for this user: required connection active,
 * capability enabled (memory, model), skill switched on, and (Phase B) what
 * the context makes meaningful — document.analyze only with files in the
 * conversation (and storage), conversation.recall only with an earlier result.
 * Hiding never grants anything: the policy still checks every step. Order is
 * fixed so the prompt is stable for a given tool set.
 */
/** Phase C: whether an active connection satisfies a requirement (provider, and capability if any). */
export function satisfies(
  req: ConnectionRequirement,
  connections: readonly ConnectionState[] | undefined,
  activeProviders: ReadonlySet<ConnectionProvider>,
): boolean {
  if (!connections) return !req.capability && activeProviders.has(req.provider);
  return connections.some(
    (c) =>
      c.provider === req.provider &&
      c.status === 'active' &&
      (!req.capability || c.capabilities.includes(req.capability)),
  );
}

export function availableTools(opts: {
  activeConnections: ReadonlySet<ConnectionProvider>;
  memoryEnabled: boolean;
  modelAvailable: boolean;
  /** Phase B (default: none disabled). */
  disabledSkills?: ReadonlySet<SkillId> | readonly SkillId[];
  /** Phase B: files of the conversation can be read (storage configured and files present). */
  hasAttachments?: boolean;
  /** Phase B: an earlier turn has a result conversation.recall can return. */
  hasRecallable?: boolean;
  /** Phase C: the user's connections with their capabilities (connectionOptions). */
  connections?: readonly ConnectionState[];
  /** Phase C: a browser worker is running and evidence storage is configured (default false). */
  browserAvailable?: boolean;
  /** Phase D: a telephony gateway is configured on this server (default false). */
  telephonyAvailable?: boolean;
}): AnyTool[] {
  const disabled = new Set(opts.disabledSkills ?? []);
  return ALL.filter((t) => {
    if (t.connectionOptions) {
      // Any one of the options will do (e.g. email.send: SMTP, or Google / Microsoft with mail.send).
      const options = t.requiredConnection
        ? [{ provider: t.requiredConnection }, ...t.connectionOptions]
        : t.connectionOptions;
      if (!options.some((o) => satisfies(o, opts.connections, opts.activeConnections)))
        return false;
    } else if (t.requiredConnection && !opts.activeConnections.has(t.requiredConnection)) {
      return false;
    }
    if (t.runsInBrowser && !opts.browserAvailable) return false;
    if (t.needsTelephony && !opts.telephonyAvailable) return false;
    if (t.id === 'memory.save' && !opts.memoryEnabled) return false;
    if (t.modelUse === 'required' && !opts.modelAvailable) return false;
    const skill = skillOfTool(t.id);
    if (skill.canToggle && disabled.has(skill.id)) return false;
    if (t.id === 'document.analyze' && !opts.hasAttachments) return false;
    if (t.id === 'conversation.recall' && !opts.hasRecallable) return false;
    return true;
  });
}

/** JSON Schema of a tool's input (deterministic; used in the planner prompt). */
export function inputJsonSchema(tool: AnyTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
