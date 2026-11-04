/**
 * validatePlan, Phase C hooks (docs/architecture/phase-c.md §4): `bind` fills
 * deterministic defaults (which connected account) before the input is
 * validated and stored — and is validated again; `attendees` are literal
 * addresses from the user's requests (never references, never from content).
 * Exercised with a synthetic calendar tool, so the hooks are frozen before the
 * real tools land.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validatePlan, type PlanValidationContext } from '../../../src/modules/agent/plan';
import {
  genericApprovalSummary,
  type AnyTool,
  type BindContext,
} from '../../../src/modules/agent/tools/types';

const OWN = 'me@example.com';

const Input = z.object({
  provider: z.enum(['google', 'microsoft']).optional(),
  title: z.string().min(1),
  attendees: z.array(z.string()).max(20).default([]),
});
type Input = z.infer<typeof Input>;

/** A calendar tool as the integrations engineer will declare it (only the planning hooks matter here). */
function calendarTool(bind?: (input: Input, ctx: BindContext) => Input): AnyTool {
  return {
    id: 'calendar.create_event',
    version: '0.0.0-test',
    description: 'test',
    inputSchema: Input,
    outputFields: ['eventId'],
    requiredConnection: null,
    connectionOptions: [
      { provider: 'google', capability: 'calendar.write' },
      { provider: 'microsoft', capability: 'calendar.write' },
    ],
    requires: (i: Input) =>
      i.provider ? { provider: i.provider, capability: 'calendar.write' } : null,
    bind,
    attendees: (i: Input) => i.attendees,
    permissions: [],
    sideEffect: 'external',
    idempotency: 'once_per_step',
    timeoutMs: 1000,
    retry: { maxAttempts: 1, retryableCodes: [] },
    modelUse: 'none',
    riskLevel: () => 'MEDIUM',
    estimateCostMicro: () => 0,
    preview: (i: Input) => i,
    approvalDetails: (_i: Input, c) => ({
      details: { kind: 'generic', toolId: 'calendar.create_event', fields: [] },
      ...genericApprovalSummary(c, 'calendar.create_event'),
    }),
    execute: () => Promise.reject(new Error('not run in this test')),
    verify: () => ({ ok: true, checks: [] }),
  };
}

const firstCalendar = (input: Input, c: BindContext): Input =>
  input.provider
    ? input
    : {
        ...input,
        provider: c.connections.find(
          (x) =>
            (x.provider === 'google' || x.provider === 'microsoft') &&
            x.status === 'active' &&
            x.capabilities.includes('calendar.write'),
        )?.provider as Input['provider'],
      };

const bindCtx: BindContext = {
  accountEmail: OWN,
  timeZone: 'Europe/Berlin',
  connections: [
    {
      connectionId: '00000000-0000-4000-8000-000000000001',
      provider: 'microsoft',
      status: 'active',
      capabilities: ['calendar.read', 'calendar.write'],
      accountIdentifier: 'me@contoso.example',
    },
  ],
};

const ctx = (tool: AnyTool, over: Partial<PlanValidationContext> = {}): PlanValidationContext => ({
  tools: new Map([[tool.id, tool]]),
  ownEmail: OWN,
  requests: ['set up a sync with bob@example.org tomorrow at 10'],
  bind: bindCtx,
  ...over,
});

const plan = (input: Record<string, unknown>) => ({
  title: 'T',
  objective: 'O',
  steps: [{ key: 's1', toolId: 'calendar.create_event', title: 'Create', input }],
});

describe('tool.bind', () => {
  it('fills the account into the stored input, so the approval hash binds it', () => {
    const tool = calendarTool(firstCalendar);
    const r = validatePlan(plan({ title: 'Sync', attendees: ['bob@example.org'] }), ctx(tool));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.steps[0]!.input).toMatchObject({ provider: 'microsoft' });
  });

  it('is skipped without a bind context, and leaves an explicit choice alone', () => {
    const tool = calendarTool(firstCalendar);
    const r1 = validatePlan(plan({ title: 'Sync' }), ctx(tool, { bind: undefined }));
    expect(r1.ok && r1.plan.steps[0]!.input.provider).toBeUndefined();
    const r2 = validatePlan(plan({ title: 'Sync', provider: 'google' }), ctx(tool));
    expect(r2.ok && r2.plan.steps[0]!.input.provider).toBe('google');
  });

  it('cannot smuggle an invalid input past the schema', () => {
    const tool = calendarTool((i) => ({ ...i, title: '' }));
    const r = validatePlan(plan({ title: 'Sync' }), ctx(tool));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toMatch(/after binding/);
  });
});

describe('tool.attendees literalness', () => {
  const tool = calendarTool();

  it('accepts addresses the user wrote and the owner', () => {
    expect(
      validatePlan(plan({ title: 'Sync', attendees: ['Bob@Example.org', OWN] }), ctx(tool)).ok,
    ).toBe(true);
  });

  it('refuses an address that is not in the user’s requests (e.g. from an email)', () => {
    const r = validatePlan(plan({ title: 'Sync', attendees: ['mallory@evil.example'] }), ctx(tool));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toMatch(/neither the account owner nor/);
  });

  it('refuses references in attendees', () => {
    const r = validatePlan(
      {
        title: 'T',
        objective: 'O',
        steps: [
          { key: 's1', toolId: 'calendar.create_event', title: 'A', input: { title: 'x' } },
          {
            key: 's2',
            toolId: 'calendar.create_event',
            title: 'B',
            input: { title: 'y', attendees: ['{{s1.eventId}}'] },
          },
        ],
      },
      ctx(tool),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toMatch(/attendees must be written literally/);
  });
});
