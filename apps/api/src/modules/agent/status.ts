import type { AssistantStatus } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { AssistantStatusService } from '../../services';
import { workerHealth } from '../jobs/queue';
import { loadAgentContext } from './context';
import type { AgentDeps } from './index';

/** Real status: planner route for this user, worker heartbeat, connected capabilities. */
export function createStatusService(deps: AgentDeps): AssistantStatusService {
  return {
    async get(ctx: DbContext): Promise<AssistantStatus> {
      const [agent, health] = await Promise.all([
        withContext(deps.db, ctx, (trx) => loadAgentContext(trx, deps.config, ctx.userId)),
        workerHealth(deps.db),
      ]);
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
        },
        version: deps.config.APP_VERSION,
      };
    },
  };
}
