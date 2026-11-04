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
import type {
  ConnectionProvider,
  Skill,
  SkillId,
  SkillUnavailableReason,
  ToolId,
} from '@jarvis/contracts';
import type { Config } from '../../../config';
import { withContext, type Db, type DbContext } from '../../../db/pool';
import { AppError } from '../../../lib/errors';
import type { SkillService } from '../../../services';
import { resolvePreferences } from '../../account/me';
import { audit } from '../../audit/audit';
import type { ObjectStorage } from '../../storage/types';
import { workerHealth } from '../../jobs/queue';
import { loadAgentContext, type AgentContext } from '../context';
import { satisfies, TOOLS } from '../tools/registry';
import { getSkill, SKILLS, type SkillDefinition } from './registry';

/** Phase C: what the server offers beyond the user's own settings. */
export interface SkillEnv {
  storageConfigured: boolean;
  /** OAuth providers with a client id and secret on this server (SMTP and web always are). */
  providersConfigured?: ReadonlySet<ConnectionProvider>;
  /** A browser worker is running (and storage is configured). */
  browserAvailable?: boolean;
  /** Tools registered on this server (default: the tool registry). */
  registered?: ReadonlySet<ToolId>;
}

const OAUTH: ReadonlySet<ConnectionProvider> = new Set(['google', 'microsoft']);

/** The SkillEnv of this server for one request (browser health is a database read). */
export async function skillEnv(deps: SkillServiceDeps): Promise<SkillEnv> {
  const providersConfigured = new Set<ConnectionProvider>(['web', 'smtp']);
  if (deps.config.oauth.google) providersConfigured.add('google');
  if (deps.config.oauth.microsoft) providersConfigured.add('microsoft');
  const browserAvailable =
    deps.storage !== null && (await workerHealth(deps.db, 'browser')).healthy;
  return { storageConfigured: deps.storage !== null, providersConfigured, browserAvailable };
}

export interface SkillServiceDeps {
  config: Config;
  db: Db;
  storage: ObjectStorage | null;
}

/** One registry entry as the contract's Skill, for this user's context. */
/**
 * Phase C: a skill counts as built only once at least one of its tools is
 * registered on this server (the tools of a domain land in stage 2); its
 * unregistered tools are listed as planned.
 */
export function effectiveStatus(
  def: SkillDefinition,
  registered: ReadonlySet<ToolId> = new Set(TOOLS.keys()),
): 'implemented' | 'planned' {
  if (def.status === 'planned') return 'planned';
  return def.tools.some((t) => registered.has(t)) ? 'implemented' : 'planned';
}

export function skillEntry(
  def: SkillDefinition,
  agent: Pick<AgentContext, 'preferences' | 'connections' | 'route' | 'connectionStates'>,
  envOrStorage: SkillEnv | boolean,
): Skill {
  const env: SkillEnv =
    typeof envOrStorage === 'boolean' ? { storageConfigured: envOrStorage } : envOrStorage;
  const registered = env.registered ?? new Set(TOOLS.keys());
  const status = effectiveStatus(def, registered);
  const disabled = new Set(agent.preferences.skills?.disabled ?? []);
  const isMemory = def.id === 'personal-memory';
  const enabled =
    status === 'planned'
      ? false
      : isMemory
        ? agent.preferences.memory.enabled
        : !(def.canToggle && disabled.has(def.id));
  const active = new Set(agent.connections.keys());
  const missingRequired = def.requiredConnections.some((c) => !agent.connections.has(c));
  const options = def.connectionOptions ?? [];
  const noOption =
    options.length > 0 && !options.some((o) => satisfies(o, agent.connectionStates, active));
  // None of the services the skill could use can be connected on this server at all.
  const unconfigurable =
    noOption &&
    options.every((o) => OAUTH.has(o.provider)) &&
    options.every((o) => !(env.providersConfigured ?? new Set()).has(o.provider));
  const missingConnection = missingRequired || noOption;
  let reason: SkillUnavailableReason | null = null;
  if (status === 'planned') reason = 'PLANNED';
  else if (!enabled) reason = isMemory ? 'MEMORY_DISABLED' : 'DISABLED_BY_USER';
  else if (unconfigurable && !missingRequired) reason = 'PROVIDER_NOT_CONFIGURED';
  else if (missingConnection) reason = 'CONNECTION_REQUIRED';
  else if (def.needsBrowser && !env.browserAvailable) reason = 'BROWSER_UNAVAILABLE';
  else if (def.modelUse === 'required' && agent.route.mode !== 'model') reason = 'MODEL_REQUIRED';
  else if (def.id === 'document-analysis' && !env.storageConfigured)
    reason = 'STORAGE_NOT_CONFIGURED';
  return {
    id: def.id,
    version: def.version,
    status:
      status === 'planned' ? 'planned' : missingConnection ? 'needs_connection' : 'implemented',
    enabled,
    // A skill that is not built yet cannot be switched (contracts Skill.canToggle).
    canToggle: status === 'planned' ? false : def.canToggle,
    available: reason === null,
    unavailableReason: reason,
    tools: def.tools.filter((t) => registered.has(t)),
    plannedTools: [...def.tools.filter((t) => !registered.has(t)), ...def.plannedTools],
    permissions: [...def.permissions],
    maxRisk: def.maxRisk,
    requiredConnections: [...def.requiredConnections],
    ...(options.length > 0 ? { connectionOptions: options.map((o) => ({ ...o })) } : {}),
    modelUse: def.modelUse,
    maxCostPerRunMicroUsd: def.maxCostPerRunMicroUsd,
    docsPath: def.docsPath,
  };
}

const refuse = (reason: 'SKILL_PLANNED' | 'SKILL_NOT_TOGGLEABLE', message: string) =>
  new AppError('INVALID_STATE', message, { reason });

export function createSkillService(deps: SkillServiceDeps): SkillService {
  async function list(ctx: DbContext): Promise<Skill[]> {
    const [agent, env] = await Promise.all([
      withContext(deps.db, ctx, (trx) => loadAgentContext(trx, deps.config, ctx.userId)),
      skillEnv(deps),
    ]);
    return SKILLS.map((s) => skillEntry(s, agent, env));
  }

  async function setEnabled(ctx: DbContext, id: SkillId, enabled: boolean): Promise<Skill> {
    const def = getSkill(id);
    if (effectiveStatus(def) === 'planned')
      throw refuse('SKILL_PLANNED', 'This skill is not available yet.');
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
      return skillEntry(def, agent, await skillEnv(deps));
    });
  }

  return { list, setEnabled };
}
