/**
 * Phase D — the telephony HTTP surfaces (owner: telephony engineer;
 * docs/architecture/phase-d.md §2, §3.3, §6):
 *   user routes (defineRoute, session-authenticated): listCalls, getCall, listDoNotCall,
 *     deleteDoNotCall, startPhoneVerification, confirmPhoneVerification;
 *   provider webhooks (registerTelephonyWebhooks: signature-validated, no session):
 *     twilioCallVoice, twilioCallGather, twilioCallStatus, twilioCallAmd, twilioCallDial,
 *     twilioCallRecording, twilioVerificationVoice, twilioVerificationStatus.
 * Each handler is registered here as it lands and its name removed from PENDING_ROUTES /
 * PENDING_WEBHOOK_ROUTES (src/routes.ts) in the same change — until then the route answers
 * 404 outside production and a production boot fails (never a placeholder handler).
 */
import type { FastifyInstance } from 'fastify';
import { registerTelephonyWebhooks } from '../../http/webhook-route';
import type { AppDeps } from '../../services';

export async function registerTelephonyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // The webhook scope exists from stage 1 on (its form parser, its rate limit); handlers land
  // in stage 2: define('twilioCallVoice', …) and the others.
  await registerTelephonyWebhooks(app, deps, () => {});
}
