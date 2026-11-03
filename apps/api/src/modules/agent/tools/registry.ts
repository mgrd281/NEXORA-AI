/**
 * Tool registry — the backend source of truth for what JARVIS can do.
 * Each tool declares its contract (schemas, risk, side effects, idempotency,
 * timeout, retry policy, cost estimate, preview, approval details, execute,
 * verify); the planner sees only the catalog derived from it and the policy
 * engine and executor enforce it.
 */
import type { ConnectionProvider, ToolId } from '@jarvis/contracts';
import { z } from 'zod';
import { assistantAnswerTool } from './assistant-answer';
import { emailSendTool } from './email-send';
import { memorySaveTool } from './memory-save';
import { textSummarizeTool } from './text-summarize';
import type { AnyTool } from './types';
import { webFetchTool } from './web-fetch';

export type { AnyTool, ToolDefinition, ToolResult, ToolRuntime, Verification } from './types';

const ALL: AnyTool[] = [
  webFetchTool,
  textSummarizeTool,
  emailSendTool,
  memorySaveTool,
  assistantAnswerTool,
];

export const TOOLS: ReadonlyMap<ToolId, AnyTool> = new Map(ALL.map((t) => [t.id, t]));

export function getTool(id: string): AnyTool | undefined {
  return TOOLS.get(id as ToolId);
}

export function listTools(): AnyTool[] {
  return [...ALL];
}

/**
 * Tools the planner may use for this user: required connection active, and
 * capability enabled (memory, model). Order is fixed so the prompt is stable.
 */
export function availableTools(opts: {
  activeConnections: ReadonlySet<ConnectionProvider>;
  memoryEnabled: boolean;
  modelAvailable: boolean;
}): AnyTool[] {
  return ALL.filter((t) => {
    if (t.requiredConnection && !opts.activeConnections.has(t.requiredConnection)) return false;
    if (t.id === 'memory.save' && !opts.memoryEnabled) return false;
    if (t.modelUse === 'required' && !opts.modelAvailable) return false;
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
