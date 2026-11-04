/**
 * Phase D — the Policy Engine's rule for phone calls (docs/architecture/phase-d.md §5,
 * docs/security/telephony.md). A domain rule like those of policy-domain.ts: it reads only
 * facts the Policy Engine was given (PolicyInput.call — computed by assessStep from the
 * tool's `call` declaration on the exact input, the server's telephony configuration and the
 * account's do-not-call list / calls today; never by a tool, a skill, the model or anything a
 * callee said) and can only RESTRICT.
 *
 * In order (the first deny wins; approval reasons accumulate):
 *   telephony not configured on this server       → deny TELEPHONY_NOT_CONFIGURED (POLICY_DENIED)
 *   not a valid number, a premium-rate / shared-cost / personal / pager / UAN / voicemail
 *   number, or a country this server does not call → deny CALL_DESTINATION_BLOCKED { country }
 *   the number is on the do-not-call list          → deny DO_NOT_CALL { number (masked) }
 *   outside the allowed hours in the callee's zone
 *   (or the zone cannot be used)                    → deny CALL_OUTSIDE_HOURS { start, end, timeZone }
 *   CALL_MAX_PER_DAY calls placed today already     → deny CALL_LIMIT { max }
 *   otherwise                                       → approval PHONE_CALL (always; never auto-approved)
 *     + CALL_RECORDING when recording is requested, + CALL_PERSONAL_INFO when details may be shared
 * A call that may create a binding commitment (purpose 'appointment') declares `binding`:
 * bindingRule adds BINDING_COMMITMENT; the tool's risk is HIGH then.
 *
 * Owner: telephony engineer. Changing this file is a change of the security model: it goes
 * through docs/architecture/phase-d.md §0 (change control), like policy.ts.
 */
import type { DestinationCheck } from '../../lib/phone';
import type { PolicyInput } from './policy';
import type { DomainRule, DomainVerdict } from './policy-domain';

/** What the Policy Engine knows about a call step (assessStep computes it; pure data). */
export interface CallPolicyFacts {
  /** A telephony gateway is configured on this server. */
  configured: boolean;
  /** E.164 as it would be dialled. */
  to: string;
  /** For deny parameters: the number masked (lib/phone.ts maskPhoneNumber). */
  masked: string;
  destination: DestinationCheck;
  doNotCall: boolean;
  /** Now is inside the allowed hours in the callee's zone; null = the zone is unusable. */
  withinHours: boolean | null;
  hours: { start: string; end: string; timeZone: string };
  callsToday: number;
  maxPerDay: number;
  recording: boolean;
  sharesPersonalInfo: boolean;
}

const deny = (
  reason: string,
  params?: Record<string, string | number>,
): DomainVerdict => ({
  deny: { reasons: [reason], code: 'POLICY_DENIED', ...(params ? { params } : {}) },
});

export const callRule: DomainRule = (p: PolicyInput): DomainVerdict | null => {
  const c = p.call;
  if (!c) return null;
  if (!c.configured) return deny('TELEPHONY_NOT_CONFIGURED');
  if (!c.destination.ok)
    return deny('CALL_DESTINATION_BLOCKED', { country: c.destination.country ?? '' });
  if (c.doNotCall) return deny('DO_NOT_CALL', { number: c.masked });
  if (c.withinHours !== true)
    return deny('CALL_OUTSIDE_HOURS', {
      start: c.hours.start,
      end: c.hours.end,
      timeZone: c.hours.timeZone,
    });
  if (!(c.callsToday < c.maxPerDay)) return deny('CALL_LIMIT', { max: c.maxPerDay });
  const approval = ['PHONE_CALL'];
  if (c.recording) approval.push('CALL_RECORDING');
  if (c.sharesPersonalInfo) approval.push('CALL_PERSONAL_INFO');
  return { approval };
};
