/**
 * Skills registry and the Phase B policy rules: every tool has exactly one
 * owning skill; skills can only deny, hide or add an approval (never allow,
 * lower a risk or skip an approval); SKILL_DISABLED, SKILL_COST_LIMIT,
 * MEMORY_FROM_CONTENT, UNTRUSTED_MEMORY and FUTURE_RUNS; per-user
 * availability reasons.
 */
import {
  DEFAULT_PREFERENCES,
  RISK_ORDER,
  SkillId,
  ToolId,
  type ConnectionProvider,
  type Preferences,
  type RiskLevel,
} from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../../src/modules/agent/context';
import { denyReason, evaluatePolicy, type PolicyInput } from '../../../src/modules/agent/policy';
import { SKILLS, skillOfTool } from '../../../src/modules/agent/skills/registry';
import { skillEntry } from '../../../src/modules/agent/skills/service';
import { assessStep, denyError } from '../../../src/modules/agent/step-policy';
import { availableTools, getTool } from '../../../src/modules/agent/tools/registry';
import type { ConnectionRow } from '../../../src/db/types';
import { testConfigUnit } from './support';

const OWN = 'me@example.com';

function prefs(over: Partial<Preferences> = {}): Preferences {
  return { ...DEFAULT_PREFERENCES, ...over };
}

function agent(
  over: {
    preferences?: Preferences;
    connections?: ConnectionProvider[];
    mode?: 'model' | 'offline';
  } = {},
): AgentContext {
  const connections = new Map<ConnectionProvider, ConnectionRow>();
  for (const c of over.connections ?? ['web', 'smtp']) connections.set(c, {} as ConnectionRow);
  return {
    account: {
      userId: 'u',
      tenantId: 't',
      email: OWN,
      displayName: 'Me',
      locale: 'en',
      timeZone: 'Europe/Berlin',
    },
    preferences: over.preferences ?? prefs(),
    connections,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    route:
      over.mode === 'model'
        ? { mode: 'model', provider: 'anthropic', reason: null }
        : { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
  };
}

describe('skills registry', () => {
  it('lists the 12 skills of docs/skills, each once', () => {
    expect(SKILLS.map((s) => s.id).sort()).toEqual([...SkillId.options].sort());
  });

  it('gives every tool exactly one owning skill (skillOfTool is total)', () => {
    for (const id of ToolId.options) {
      expect(
        SKILLS.filter((s) => s.tools.includes(id)),
        id,
      ).toHaveLength(1);
      expect(skillOfTool(id).tools).toContain(id);
    }
  });

  it('planned skills own no tools and cannot be switched; core skills cannot be switched', () => {
    for (const s of SKILLS.filter((x) => x.status === 'planned')) {
      expect(s.tools).toEqual([]);
      expect(s.canToggle).toBe(false);
    }
    expect(SKILLS.find((s) => s.id === 'workflow-planning')!.canToggle).toBe(false);
  });

  it('declares a max risk no lower than any owned tool can have', () => {
    const samples: Record<string, Record<string, unknown>> = {
      'email.send': {
        to: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'],
        subject: 's',
        body: 'b',
      },
    };
    for (const s of SKILLS) {
      for (const id of s.tools) {
        // Phase C tools are owned by their skills before they are registered (stage 2).
        const tool = getTool(id);
        if (!tool) continue;
        const risk = tool.riskLevel(samples[id] ?? {}, { accountEmail: OWN }) as RiskLevel;
        expect(RISK_ORDER[s.maxRisk], `${s.id}/${id}`).toBeGreaterThanOrEqual(RISK_ORDER[risk]);
      }
    }
  });
});

describe('policy: skills only ever narrow', () => {
  const base: PolicyInput = {
    toolId: 'email.send',
    risk: 'MEDIUM',
    requiredConnection: 'smtp',
    activeConnections: new Set(['smtp', 'web']),
    preferences: prefs({ autonomy: { autoApproveEmailToSelf: true } }),
    accountEmail: OWN,
    recipients: [OWN],
    sideEffect: 'external',
    modelUse: 'none',
    model: { available: false, offlineReason: 'NO_API_KEY' },
    projectedCostMicro: 0,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
  };
  const strictness = { allow: 0, require_approval: 1, deny: 2 } as const;

  it('no skill setting turns a deny into allow, lowers strictness or removes a reason', () => {
    const variants: Partial<PolicyInput>[] = [
      {},
      { recipients: ['x@y.test'] },
      { risk: 'HIGH' },
      { risk: 'LOW', toolId: 'web.fetch', sideEffect: 'none', outbound: true, recipients: [] },
      { risk: 'CRITICAL' },
      { untrustedContent: true },
      { activeConnections: new Set() },
      {
        projectedCostMicro: 50_000,
        modelUse: 'optional',
        model: { available: true, offlineReason: null },
      },
      { toolId: 'memory.save', risk: 'LOW', sideEffect: 'internal', recipients: [] },
      {
        toolId: 'memory.save',
        risk: 'LOW',
        sideEffect: 'internal',
        recipients: [],
        fromContent: true,
      },
    ];
    const skillSettings: Partial<PolicyInput>[] = [
      { skillEnabled: true, skillCostLimitMicro: null },
      { skillEnabled: true, skillCostLimitMicro: 0 },
      { skillEnabled: true, skillCostLimitMicro: 1_000_000_000 },
      { skillEnabled: false },
    ];
    for (const v of variants) {
      const without = evaluatePolicy({ ...base, ...v });
      for (const k of skillSettings) {
        const withSkill = evaluatePolicy({ ...base, ...v, ...k });
        expect(strictness[withSkill.decision]).toBeGreaterThanOrEqual(strictness[without.decision]);
        // Every reason stays (AUTO_APPROVED_SELF only annotates an allow that became an approval).
        if (withSkill.decision !== 'deny' && without.decision !== 'deny')
          for (const r of without.reasons.filter((x) => x !== 'AUTO_APPROVED_SELF'))
            expect(withSkill.reasons).toContain(r);
      }
    }
  });

  it('a switched-off skill denies its tools with SKILL_DISABLED', () => {
    const r = evaluatePolicy({ ...base, skillEnabled: false });
    expect(r).toEqual({ decision: 'deny', reasons: ['SKILL_DISABLED'], denyCode: 'POLICY_DENIED' });
    expect(denyReason('POLICY_DENIED', r.reasons)).toBe('SKILL_DISABLED');
  });

  it('a projected cost above the skill limit asks first (SKILL_COST_LIMIT)', () => {
    const r = evaluatePolicy({
      ...base,
      toolId: 'web.fetch',
      risk: 'LOW',
      sideEffect: 'none',
      recipients: [],
      projectedCostMicro: 150_000,
      skillCostLimitMicro: 100_000,
    });
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toContain('SKILL_COST_LIMIT');
  });

  it('memory from an earlier result needs approval; from flagged content it is refused', () => {
    const memory = {
      ...base,
      toolId: 'memory.save' as const,
      risk: 'LOW' as const,
      sideEffect: 'internal' as const,
      recipients: [],
    };
    expect(evaluatePolicy(memory)).toMatchObject({ decision: 'allow' });
    expect(evaluatePolicy({ ...memory, fromContent: true })).toMatchObject({
      decision: 'require_approval',
      reasons: ['RISK_LOW', 'MEMORY_FROM_CONTENT'],
    });
    const tainted = evaluatePolicy({ ...memory, fromContent: true, untrustedContent: true });
    expect(tainted).toEqual({
      decision: 'deny',
      reasons: ['UNTRUSTED_MEMORY'],
      denyCode: 'POLICY_DENIED',
    });
    expect(denyReason('POLICY_DENIED', tainted.reasons)).toBe('UNTRUSTED_MEMORY');
  });

  it('a schedule always needs approval (FUTURE_RUNS), never auto-approved', () => {
    const r = evaluatePolicy({
      ...base,
      toolId: 'schedule.create',
      risk: 'MEDIUM',
      requiredConnection: null,
      sideEffect: 'internal',
      recipients: [],
    });
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toEqual(['RISK_MEDIUM', 'FUTURE_RUNS']);
  });
});

describe('assessStep computes the skill fields from the registry and preferences', () => {
  const config = testConfigUnit();

  it('denies the tools of a disabled skill, with the skill as a parameter', () => {
    const a = agent({ preferences: prefs({ skills: { disabled: ['web-research'] } }) });
    const tool = getTool('web.fetch')!;
    const res = assessStep(tool, { url: 'https://example.com' }, a, config);
    expect(res.policy.decision).toBe('deny');
    expect(denyError(tool, 'Read example.com', res.policy)).toMatchObject({
      code: 'POLICY_DENIED',
      reason: 'SKILL_DISABLED',
      params: { step: 'Read example.com', skill: 'web-research' },
    });
    // Tools the skill only uses are not denied.
    expect(
      assessStep(getTool('email.send')!, { to: [OWN], subject: 's', body: 'b' }, a, config).policy
        .decision,
    ).not.toBe('deny');
  });

  it('treats a reference in memory content as content (MEMORY_FROM_CONTENT)', () => {
    const tool = getTool('memory.save')!;
    const planned = assessStep(tool, { content: '{{s1.excerpt}}', kind: 'fact' }, agent(), config);
    expect(planned.policy.reasons).toContain('MEMORY_FROM_CONTENT');
    // At execution the input is resolved, so the caller says where it came from.
    const resolved = assessStep(
      tool,
      { content: 'Renewables overtook coal.', kind: 'fact' },
      agent(),
      config,
      { fromContent: true, untrustedContent: true },
    );
    expect(resolved.policy.reasons).toEqual(['UNTRUSTED_MEMORY']);
  });

  it('availableTools hides disabled skills, files without attachments and recall without results', () => {
    const ids = (o: Partial<Parameters<typeof availableTools>[0]> = {}) =>
      availableTools({
        activeConnections: new Set(['web', 'smtp']),
        memoryEnabled: true,
        modelAvailable: true,
        ...o,
      }).map((t) => t.id);
    expect(ids()).not.toContain('document.analyze');
    expect(ids()).not.toContain('conversation.recall');
    expect(ids({ hasAttachments: true, hasRecallable: true })).toEqual(
      expect.arrayContaining([
        'document.analyze',
        'conversation.recall',
        'text.translate',
        'schedule.create',
        'assistant.clarify',
      ]),
    );
    expect(ids({ disabledSkills: ['translation', 'task-scheduling'] })).not.toEqual(
      expect.arrayContaining(['text.translate']),
    );
    expect(ids({ disabledSkills: ['task-scheduling'] })).not.toContain('schedule.create');
    expect(ids({ modelAvailable: false })).not.toContain('text.translate');
    // The core skill cannot be switched off, so its tools stay.
    expect(ids({ disabledSkills: ['workflow-planning'] })).toContain('assistant.clarify');
  });
});

describe('skill availability per user', () => {
  const entry = (id: string, a: AgentContext, storage = true) =>
    skillEntry(
      SKILLS.find((s) => s.id === id)!,
      a,
      storage,
    );

  it('reports the first reason a skill cannot run', () => {
    expect(entry('phone-calling', agent())).toMatchObject({
      status: 'planned',
      available: false,
      unavailableReason: 'PLANNED',
      canToggle: false,
    });
    expect(
      entry(
        'web-research',
        agent({ preferences: prefs({ skills: { disabled: ['web-research'] } }) }),
      ),
    ).toMatchObject({
      enabled: false,
      available: false,
      unavailableReason: 'DISABLED_BY_USER',
    });
    expect(
      entry('personal-memory', agent({ preferences: prefs({ memory: { enabled: false } }) })),
    ).toMatchObject({
      enabled: false,
      unavailableReason: 'MEMORY_DISABLED',
    });
    expect(entry('email-management', agent({ connections: ['web'] }))).toMatchObject({
      status: 'needs_connection',
      unavailableReason: 'CONNECTION_REQUIRED',
    });
    expect(entry('translation', agent())).toMatchObject({ unavailableReason: 'MODEL_REQUIRED' });
    expect(entry('translation', agent({ mode: 'model' }))).toMatchObject({ available: true });
    expect(entry('document-analysis', agent(), false)).toMatchObject({
      unavailableReason: 'STORAGE_NOT_CONFIGURED',
    });
    expect(entry('workflow-planning', agent())).toMatchObject({
      available: true,
      canToggle: false,
      enabled: true,
    });
  });
});
