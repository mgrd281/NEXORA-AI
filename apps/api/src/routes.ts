import type { RouteName, TelephonyWebhookName } from '@jarvis/contracts';
import type { FastifyInstance } from 'fastify';
import { assertAllRoutesRegistered } from './http/route';
import { assertAllWebhooksRegistered } from './http/webhook-route';
import { registerAccountRoutes } from './modules/account/routes';
import { registerAdminRoutes } from './modules/admin/routes';
import { registerApprovalRoutes } from './modules/approvals/routes';
import { registerAttachmentRoutes } from './modules/attachments/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerBookingRoutes } from './modules/bookings/routes';
import { registerCalendarRoutes } from './modules/calendar/routes';
import { registerConnectionRoutes } from './modules/connections/routes';
import { registerConversationRoutes } from './modules/conversations/routes';
import { registerEmailRoutes } from './modules/email/routes';
import { registerEvidenceRoutes } from './modules/evidence/routes';
import { registerHomeRoutes } from './modules/home/routes';
import { registerMemoryRoutes } from './modules/memory/routes';
import { registerMetaRoutes } from './modules/meta/routes';
import { registerNotificationRoutes } from './modules/notifications/routes';
import { registerOrderRoutes } from './modules/orders/routes';
import { registerScheduleRoutes } from './modules/schedules/routes';
import { registerSkillRoutes } from './modules/skills/routes';
import { registerStreamRoutes } from './modules/stream/routes';
import { registerTaskRoutes } from './modules/tasks/routes';
import { registerTelephonyRoutes } from './modules/telephony/routes';
import { registerUsageRoutes } from './modules/usage/routes';
import { registerVoiceRoutes } from './modules/voice/routes';
import { registerWebhookRoutes } from './modules/webhooks/routes';
import type { AppDeps } from './services';

/**
 * Contract routes whose handlers have not landed yet (Phase C's list ended empty).
 * Phase D stage 1 → 2 (docs/architecture/phase-d.md §0, §9): the six telephony user
 * routes are the telephony engineer's. They answer 404 outside production;
 * assertAllRoutesRegistered refuses any pending route in production regardless.
 * Remove each name in the change that registers its handler.
 */
export const PENDING_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'listCalls',
  'getCall',
  'listDoNotCall',
  'deleteDoNotCall',
  'startPhoneVerification',
  'confirmPhoneVerification',
]);

/**
 * Phase D stage 1 → 2: telephony webhooks (contracts telephonyWebhookRoutes) whose
 * handlers have not landed yet — same rules as PENDING_ROUTES.
 */
export const PENDING_WEBHOOK_ROUTES: ReadonlySet<TelephonyWebhookName> =
  new Set<TelephonyWebhookName>([
    'twilioCallVoice',
    'twilioCallGather',
    'twilioCallStatus',
    'twilioCallAmd',
    'twilioCallDial',
    'twilioCallRecording',
    'twilioVerificationVoice',
    'twilioVerificationStatus',
  ]);

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
  // Phase C (OAuth connections are registered with the other connection routes)
  registerCalendarRoutes(app, deps);
  registerEmailRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerBookingRoutes(app, deps);
  registerEvidenceRoutes(app, deps);
  // Phase D: calls, do-not-call, phone verification, and the provider's webhooks (their own
  // route group: no session, signature-validated — http/webhook-route.ts).
  await registerTelephonyRoutes(app, deps);
  // Server-Sent Events (GET /v1/events) — outside the JSON route table.
  registerStreamRoutes(app, deps);
  assertAllRoutesRegistered(app, {
    pending: PENDING_ROUTES,
    production: deps.config.isProduction,
  });
  assertAllWebhooksRegistered(app, {
    pending: PENDING_WEBHOOK_ROUTES,
    production: deps.config.isProduction,
  });
}
