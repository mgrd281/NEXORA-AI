import type { AssistantStatus } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { AssistantStatusService } from '../../services';
import { workerHealth } from '../jobs/queue';
import { loadAgentContext } from './context';
import type { AgentDeps } from './index';
import { getSkill } from './skills/registry';
import { skillEntry } from './skills/service';

/** Real status: planner route for this user, worker heartbeat, connected capabilities. */
export function createStatusService(deps: AgentDeps): AssistantStatusService {
  return {
    async get(ctx: DbContext): Promise<AssistantStatus> {
      const [agent, health] = await Promise.all([
        withContext(deps.db, ctx, (trx) => loadAgentContext(trx, deps.config, ctx.userId)),
        workerHealth(deps.db),
      ]);
      // Phase B capabilities: the same availability the skills list reports.
      const available = (id: Parameters<typeof getSkill>[0]) =>
        skillEntry(getSkill(id), agent, deps.storage !== null).available;
      return {
        planner: {
          mode: agent.route.mode,
          provider: agent.route.provider,
          reason: agent.route.reason,
        },
        worker: {
          healthy: health.healthy,
          lastHeartbeatAt: health.lastHeartbeatAt ? health.lastHeartbeatAt.toISOString() : null,
        },
        capabilities: {
          webFetch: agent.connections.has('web'),
          email: agent.connections.has('smtp'),
          memory: agent.preferences.memory.enabled,
          generalQuestions: agent.route.mode === 'model',
          attachments: available('document-analysis'),
          translation: available('translation'),
          schedules: available('task-scheduling'),
        },
        version: deps.config.APP_VERSION,
      };
    },
  };
}
