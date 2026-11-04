/**
 * SkillService (services.ts): the registry with each skill's real
 * availability for the caller, and the per-user switch.
 *
 * Availability, first match wins:
 *   planned                                  → status planned, PLANNED
 *   switched off by the user                 → DISABLED_BY_USER
 *   personal-memory with memory off          → MEMORY_DISABLED (its switch is memory.enabled)
 *   a required connection missing            → status needs_connection, CONNECTION_REQUIRED
 *   needs a model while the route is offline → MODEL_REQUIRED
 *   document-analysis without storage        → STORAGE_NOT_CONFIGURED
 *
 * Switching writes preferences.skills.disabled (personal-memory:
 * preferences.memory.enabled) under a row lock of the user, audits it, and
 * never touches risk, approvals or any other permission.
 */
import type { Skill, SkillId, SkillUnavailableReason } from '@jarvis/contracts';
import type { Config } from '../../../config';
import { withContext, type Db, type DbContext } from '../../../db/pool';
import { AppError } from '../../../lib/errors';
import type { SkillService } from '../../../services';
import { resolvePreferences } from '../../account/me';
import { audit } from '../../audit/audit';
import type { ObjectStorage } from '../../storage/types';
import { loadAgentContext, type AgentContext } from '../context';
import { getSkill, SKILLS, type SkillDefinition } from './registry';

export interface SkillServiceDeps {
  config: Config;
  db: Db;
  storage: ObjectStorage | null;
}

/** One registry entry as the contract's Skill, for this user's context. */
export function skillEntry(
  def: SkillDefinition,
  agent: Pick<AgentContext, 'preferences' | 'connections' | 'route'>,
  storageConfigured: boolean,
): Skill {
  const disabled = new Set(agent.preferences.skills?.disabled ?? []);
  const isMemory = def.id === 'personal-memory';
  const enabled =
    def.status === 'planned'
      ? false
      : isMemory
        ? agent.preferences.memory.enabled
        : !(def.canToggle && disabled.has(def.id));
  const missingConnection = def.requiredConnections.some((c) => !agent.connections.has(c));
  let reason: SkillUnavailableReason | null = null;
  if (def.status === 'planned') reason = 'PLANNED';
  else if (!enabled) reason = isMemory ? 'MEMORY_DISABLED' : 'DISABLED_BY_USER';
  else if (missingConnection) reason = 'CONNECTION_REQUIRED';
  else if (def.modelUse === 'required' && agent.route.mode !== 'model') reason = 'MODEL_REQUIRED';
  else if (def.id === 'document-analysis' && !storageConfigured) reason = 'STORAGE_NOT_CONFIGURED';
  return {
    id: def.id,
    version: def.version,
    status:
      def.status === 'planned' ? 'planned' : missingConnection ? 'needs_connection' : 'implemented',
    enabled,
    canToggle: def.canToggle,
    available: reason === null,
    unavailableReason: reason,
    tools: [...def.tools],
    plannedTools: [...def.plannedTools],
    permissions: [...def.permissions],
    maxRisk: def.maxRisk,
    requiredConnections: [...def.requiredConnections],
    modelUse: def.modelUse,
    maxCostPerRunMicroUsd: def.maxCostPerRunMicroUsd,
    docsPath: def.docsPath,
  };
}

const refuse = (reason: 'SKILL_PLANNED' | 'SKILL_NOT_TOGGLEABLE', message: string) =>
  new AppError('INVALID_STATE', message, { reason });

export function createSkillService(deps: SkillServiceDeps): SkillService {
  const storageConfigured = deps.storage !== null;

  async function list(ctx: DbContext): Promise<Skill[]> {
    const agent = await withContext(deps.db, ctx, (trx) =>
      loadAgentContext(trx, deps.config, ctx.userId),
    );
    return SKILLS.map((s) => skillEntry(s, agent, storageConfigured));
  }

  async function setEnabled(ctx: DbContext, id: SkillId, enabled: boolean): Promise<Skill> {
    const def = getSkill(id);
    if (def.status === 'planned') throw refuse('SKILL_PLANNED', 'This skill is not available yet.');
    if (!def.canToggle)
      throw refuse('SKILL_NOT_TOGGLEABLE', 'This skill is part of how JARVIS works and stays on.');
    return withContext(deps.db, ctx, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('preferences')
        .where('id', '=', ctx.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const prefs = resolvePreferences(user.preferences);
      let next: typeof prefs;
      if (id === 'personal-memory') {
        next = { ...prefs, memory: { ...prefs.memory, enabled } };
      } else {
        const disabled = new Set(prefs.skills.disabled);
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        // Registry order keeps the stored list stable.
        const list = SKILLS.map((s) => s.id).filter((s) => disabled.has(s));
        next = { ...prefs, skills: { disabled: list } };
      }
      await trx
        .updateTable('users')
        .set({ preferences: JSON.stringify(next) })
        .where('id', '=', ctx.userId)
        .execute();
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'skill.toggled',
        targetType: 'skill',
        targetId: id,
        metadata: { skill: id, enabled },
      });
      const agent = await loadAgentContext(trx, deps.config, ctx.userId);
      return skillEntry(def, agent, storageConfigured);
    });
  }

  return { list, setEnabled };
}
