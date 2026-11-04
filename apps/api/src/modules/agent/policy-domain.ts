/**
 * Phase C — the Policy Engine's per-domain rules (docs/architecture/phase-c.md §5).
 *
 * Each rule reads only facts the Policy Engine was given (PolicyInput: from the
 * tool's declarations on the exact input, the user's preferences and
 * database state computed by assessStep — never by a tool, a skill or the
 * model) and can only RESTRICT: deny a step, or add an approval reason. There
 * is no way to express "allow" here, so no domain rule can turn a deny into
 * an allow, lower a risk or remove an approval (unit-tested).
 *
 *   purchases (shop.checkout, paid bookings: tool.purchase)
 *     monthly limit 0 (the default)              → deny PURCHASES_DISABLED
 *     not in USD (the limit's currency)          → deny PURCHASE_CURRENCY
 *     committed this month + amount > limit      → deny PURCHASE_LIMIT
 *     otherwise                                  → approval PURCHASE (always; never auto-approved)
 *   binding commitments on a site (tool.binding) → approval BINDING_COMMITMENT
 *   invitations to people other than the owner (tool.attendees)
 *                                                → approval RECIPIENT_EXTERNAL (+ MANY_RECIPIENTS > 3)
 *
 * Changing this file is a change of the security model: it goes through
 * docs/architecture/phase-c.md §0 (change control), like policy.ts.
 */
import { COMMERCE_LIMITS, moneyParam, type ErrorCode } from '@jarvis/contracts';
import type { PolicyInput } from './policy';

export interface DomainDeny {
  reasons: string[];
  code: ErrorCode;
  /** Facts for the TaskError (clients explain the reason with them). */
  params?: Record<string, string | number>;
}

/** What a domain rule may say: deny, or add approval reasons. Nothing else. */
export interface DomainVerdict {
  deny?: DomainDeny;
  approval?: readonly string[];
  /** Informational reason codes (shown with the decision, change nothing). */
  info?: readonly string[];
}

export type DomainRule = (p: PolicyInput) => DomainVerdict | null;

const sameAddress = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Money: the monthly purchase limit, its currency, and an approval for every purchase. */
export const purchaseRule: DomainRule = (p): DomainVerdict | null => {
  const purchase = p.purchase;
  if (!purchase) return null;
  const currency = COMMERCE_LIMITS.limitCurrency;
  if (purchase.limitMicro <= 0)
    return { deny: { reasons: ['PURCHASES_DISABLED'], code: 'POLICY_DENIED' } };
  if (purchase.currency !== null && purchase.currency !== currency)
    return {
      deny: {
        reasons: ['PURCHASE_CURRENCY'],
        code: 'POLICY_DENIED',
        params: { currency: purchase.currency },
      },
    };
  if (purchase.amountMicro !== null) {
    if (!Number.isFinite(purchase.amountMicro) || purchase.amountMicro < 0)
      return { deny: { reasons: ['PURCHASE_LIMIT'], code: 'POLICY_DENIED' } };
    if (purchase.spentMicro + purchase.amountMicro > purchase.limitMicro)
      return {
        deny: {
          reasons: ['PURCHASE_LIMIT'],
          code: 'POLICY_DENIED',
          params: {
            limit: moneyParam({ amountMicro: purchase.limitMicro, currency }),
            spent: moneyParam({ amountMicro: purchase.spentMicro, currency }),
            amount: moneyParam({ amountMicro: purchase.amountMicro, currency }),
          },
        },
      };
  }
  // Amount not known yet (planning time): asked now, checked against the limit at execution.
  return { approval: ['PURCHASE'] };
};

/** A binding commitment on a site (a booking with cancellation fees, a submitted form). */
export const bindingRule: DomainRule = (p) =>
  p.binding ? { approval: ['BINDING_COMMITMENT'] } : null;

/** Calendar invitations: anyone but the owner makes it an external action. */
export const attendeesRule: DomainRule = (p): DomainVerdict | null => {
  const attendees = p.attendees ?? [];
  if (attendees.length === 0) return null;
  const external = attendees.filter((a) => !sameAddress(a, p.accountEmail));
  if (external.length === 0) return null;
  return {
    approval: ['RECIPIENT_EXTERNAL'],
    ...(attendees.length > 3 ? { info: ['MANY_RECIPIENTS'] } : {}),
  };
};

/** In order; the first deny wins, approval reasons accumulate. */
export const DOMAIN_RULES: readonly DomainRule[] = [purchaseRule, bindingRule, attendeesRule];

export interface DomainOutcome {
  deny: DomainDeny | null;
  approval: string[];
  info: string[];
}

/** Runs every domain rule. Pure. */
export function evaluateDomainRules(p: PolicyInput): DomainOutcome {
  const approval: string[] = [];
  const info: string[] = [];
  for (const rule of DOMAIN_RULES) {
    const v = rule(p);
    if (!v) continue;
    if (v.deny) return { deny: v.deny, approval: [], info: [] };
    for (const r of v.approval ?? []) if (!approval.includes(r)) approval.push(r);
    for (const r of v.info ?? []) if (!info.includes(r)) info.push(r);
  }
  return { deny: null, approval, info };
}
