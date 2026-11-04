import type { FastifyInstance } from 'fastify';
import { assertAllRoutesRegistered } from './http/route';
import { registerAccountRoutes } from './modules/account/routes';
import { registerAdminRoutes } from './modules/admin/routes';
import { registerApprovalRoutes } from './modules/approvals/routes';
import { registerAttachmentRoutes } from './modules/attachments/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerConnectionRoutes } from './modules/connections/routes';
import { registerConversationRoutes } from './modules/conversations/routes';
import { registerHomeRoutes } from './modules/home/routes';
import { registerMemoryRoutes } from './modules/memory/routes';
import { registerMetaRoutes } from './modules/meta/routes';
import { registerNotificationRoutes } from './modules/notifications/routes';
import { registerScheduleRoutes } from './modules/schedules/routes';
import { registerSkillRoutes } from './modules/skills/routes';
import { registerStreamRoutes } from './modules/stream/routes';
import { registerTaskRoutes } from './modules/tasks/routes';
import { registerUsageRoutes } from './modules/usage/routes';
import { registerVoiceRoutes } from './modules/voice/routes';
import { registerWebhookRoutes } from './modules/webhooks/routes';
import type { AppDeps } from './services';

/**
 * Registers every HTTP module. Boot fails if any route in the contract table
 * lacks a handler, so the API can never silently ship a dead endpoint.
 */
export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  registerAuthRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerHomeRoutes(app, deps);
  registerUsageRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerConnectionRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerNotificationRoutes(app, deps);
  registerVoiceRoutes(app, deps);
  registerAdminRoutes(app, deps);
  // Phase B
  registerConversationRoutes(app, deps);
  await registerAttachmentRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerMetaRoutes(app, deps);
  // Server-Sent Events (GET /v1/events) — outside the JSON route table.
  registerStreamRoutes(app, deps);
  assertAllRoutesRegistered(app);
}
