/**
 * Phase D — tools of the telephony domain (docs/architecture/phase-d.md §2, §3.2):
 * phone.call (purpose message | availability | questions | appointment).
 *
 * Owner: telephony engineer. The registry (tools/registry.ts) includes every tool
 * exported here; nothing else needs to change to register one. phone.call must have a
 * full ToolDefinition with:
 *   - inputSchema = contracts PhoneCallInput (the number E.164, literal from the request);
 *   - phoneNumbers(input) → [input.to] (plan validation: NUMBER_NOT_LITERAL otherwise);
 *   - call(input) → CallFacts (policy-telephony.ts: destination, do-not-call, hours, limit);
 *   - binding(input) → purpose === 'appointment' (BINDING_COMMITMENT; risk HIGH, else MEDIUM);
 *   - bind(input, ctx) → calleeTimeZone (the account's zone when absent), dialog
 *     ('model' only with ctx.modelAvailable) and the script in the call language (the AI
 *     disclosure first), so the approval and its action hash cover the exact words;
 *   - needsTelephony: true, sideEffect 'external', idempotency 'once_per_step', a timeout
 *     covering ring time + maxDurationSeconds + the transfer, approvalDetails kind
 *     'phone_call' (every field of the contract, from ApprovalContext.telephony), outputs
 *     (frozen, §6): callId, result, goalReached, text (resultTextField), date, times,
 *     appointmentDate, appointmentTime, reference, reply, suspectedInjection, injectionSignals;
 *   - resultLine: result.callCompleted / callAnswered / callTransferred; verify: callConnected,
 *     aiDisclosed, callEnded, goalReached / detailsCollected, consentRespected, transcriptStored.
 * Its id is a contracts ToolId owned by the phone-calling skill (skills/registry.ts).
 */
import type { AnyTool } from '../types';
import { phoneCallTool } from './phone-call';

export const telephonyTools: readonly AnyTool[] = [phoneCallTool];
