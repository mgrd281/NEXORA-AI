import type { AssistantStatus } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { AssistantStatusService } from '../../services';
import { workerHealth } from '../jobs/queue';
import { loadAgentContext } from './context';
import type { AgentDeps } from './index';
import { getSkill } from './skills/registry';
import { skillEntry, skillEnv } from './skills/service';
import { TOOLS } from './tools/registry';

/** Real status: planner route for this user, worker heartbeat, connected capabilities. */
export function createStatusService(deps: AgentDeps): AssistantStatusService {
  return {
    async get(ctx: DbContext): Promise<AssistantStatus> {
      const [agent, health, env] = await Promise.all([
        withContext(deps.db, ctx, (trx) => loadAgentContext(trx, deps.config, ctx.userId)),
        workerHealth(deps.db),
        skillEnv(deps),
      ]);
      // Phase B capabilities: the same availability the skills list reports.
      const available = (id: Parameters<typeof getSkill>[0]) =>
        skillEntry(getSkill(id), agent, env).available;
      // Phase C: a capability needs its tools built here, the skill available, and what
      // the tools themselves need (an OAuth connection granting it, the browser agent).
      const registered = (...ids: Parameters<typeof TOOLS.has>[0][]) =>
        ids.some((t) => TOOLS.has(t));
      const granted = (capability: 'mail.read' | 'calendar.read') =>
        (agent.connectionStates ?? []).some(
          (c) => c.status === 'active' && c.capabilities.includes(capability),
        );
      const browser =
        env.browserAvailable === true &&
        registered('browser.read', 'shop.search', 'booking.find_slots');
      const shopping = available('shopping-assistant') && registered('shop.search');
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
          mail:
            available('email-management') &&
            registered('email.search', 'email.read_thread') &&
            granted('mail.read'),
          calendar:
            available('calendar-management') &&
            registered('calendar.list') &&
            granted('calendar.read'),
          browser,
          booking: available('appointment-booking') && registered('booking.find_slots'),
          shopping,
          purchases:
            shopping && registered('shop.checkout') && (agent.purchases?.limitMicro ?? 0) > 0,
          // Phase D: built here, the skill on, and a telephony gateway configured.
          phoneCalls: available('phone-calling') && registered('phone.call'),
        },
        version: deps.config.APP_VERSION,
      };
    },
  };
}
