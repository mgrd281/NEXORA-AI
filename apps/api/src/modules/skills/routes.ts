/**
 * Skills catalog (docs/architecture/phase-b.md §3.4): a thin layer over the
 * runtime's registry (AgentServices.skills). Switching a skill off only ever
 * removes capability (the Policy Engine denies its tools, SKILL_DISABLED);
 * no request here can grant a permission.
 */
import type { FastifyInstance } from 'fastify';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';

export function registerSkillRoutes(app: FastifyInstance, deps: AppDeps) {
  defineRoute(app, deps, 'listSkills', async ({ ctx }) => ({
    items: await deps.agent.skills.list(ctx),
  }));

  defineRoute(app, deps, 'updateSkill', async ({ ctx, params, body }) =>
    deps.agent.skills.setEnabled(ctx, params.id, body.enabled),
  );
}
