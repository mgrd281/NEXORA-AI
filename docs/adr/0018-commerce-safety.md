# ADR-0018: Commerce safety — purchases, bookings and duplicate prevention

- Status: Accepted
- Date: 2026-11-04
- Design: [Phase C architecture](../architecture/phase-c.md) §3.4, §3.6, §5
- Amends: [permission model](../security/permission-model.md) "CRITICAL handling"

## Context

Phase C lets JARVIS prepare carts, place orders and book appointments (scenarios 3, 7 and 10 of the
master prompt). Until now the permission model classified every payment as `CRITICAL` and denied it.
The risks: an unauthorized purchase (an injected page, a model mistake), an amount different from
what the user saw, a purchase above what the user can afford, a duplicate order after a crash or a
retry, and invented prices, availability or confirmations.

## Decision

- **Risk classes.** Comparing products and reading slots: `LOW`. Preparing a cart: `MEDIUM`
  (reversible, approval). Booking: `MEDIUM`, `HIGH` when the site says it is binding or paid.
  Checkout / payment: `HIGH` — always asks, never auto-approved. **Money transfers stay `CRITICAL`
  and denied** (no tool exists). Checkout is `HIGH` rather than `CRITICAL` in this build only
  because of the controls below and because the only executable checkout is the local fixture
  shop's; before any real merchant recipe may declare checkout support, step-up re-authentication
  at decision time (Phase F: passkeys) must exist — a release-checklist gate.
- **The Policy Engine is the only authority.** Tools declare facts on the exact input —
  `purchase(input) → { amountMicro, currency }`, `binding(input)`, `attendees(input)` — and the
  deterministic domain rules (`agent/policy-domain.ts`) decide. They can only deny or add an
  approval (no way to express "allow"); unit-tested.
- **A monthly purchase limit, off by default.** `preferences.spending.monthlyPurchaseLimitUsd`
  (default **0** = purchases disabled, max `COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax`):
  - limit 0 → **deny `PURCHASES_DISABLED`** (scenario 7) — at planning time already;
  - committed this month + amount > limit → **deny `PURCHASE_LIMIT`** with the limit, the spent
    amount and the amount as parameters;
  - not in USD → **deny `PURCHASE_CURRENCY`** (no verifiable exchange rate in this build);
  - otherwise → **approval `PURCHASE`**, plus the usual `RISK_HIGH`.
    "Committed" is the `committed_purchases` view (security_invoker, so RLS applies): orders that are
    `submitting`, `placed` or `unknown` since the start of the calendar month in the account's time
    zone — an order of unknown outcome counts until resolved.
- **The approval shows everything and binds it.** Approval kind `purchase`: merchant (name, host),
  every item with quantity, unit price and line total, subtotal, shipping, tax, total, delivery
  method / estimate / address, payment method as the merchant shows it, the monthly limit with
  what is spent and what remains after, and the cart screenshot. The action hash covers the resolved
  input, which contains the expected total and the cart's line items. Right before submitting, the
  tool re-reads the live cart: a different total or line → **`PRICE_CHANGED`, nothing ordered**
  (the user is asked again on retry, with a new hash). Bookings (kind `booking`) show the slot as the
  site offered it, every personal field sent, the price and the cancellation terms.
- **Exactly once — database and merchant.** The order idempotency key is derived from the step id
  (stable across retries, including acknowledged ones) and stored with `UNIQUE (user_id,
idempotency_key)` before anything is submitted (`status 'submitting'`); a recipe may declare
  checkout support only if the merchant honours an idempotency key (the fixture shop: an
  `Idempotency-Key` header returning the same order). A crash after submission started → the step
  is `OUTCOME_UNKNOWN` (`ORDER_UNKNOWN`), the order row `unknown`; a retry requires the user's
  acknowledgement (as for email) and then **reconciles with the merchant by the same key** before
  submitting — never a second order (scenario 10). Bookings follow the same pattern
  (`BOOKING_UNCONFIRMED`).
- **No invented facts.** Prices, shipping, delivery times, stock, availability and confirmations
  come only from the merchant's or site's live pages (screenshots + extracted data as evidence);
  unknown values stay `null` (never 0, never "free"). Merchant reliability is shown as page facts
  (`ReliabilitySignalCode`: return policy, legal notice, contact details, rating as stated…),
  never as a JARVIS score. A confirmation is read from the site's confirmation (schema.org
  `Order` / `Reservation`, ICS) — a submitted form without one is unknown, not booked.
- **Real shops hand over.** For shops whose recipe does not declare checkout support,
  `shop.prepare_cart` returns the merchant's cart link (`handoverUrl`) and the user pays there
  themselves (`CHECKOUT_UNSUPPORTED` if checkout is planned anyway).
- **Untrusted content cannot buy.** Quantities come from the user's words (no references); page
  content can only fill references to its own site's product data; a flagged source adds
  `UNTRUSTED_CONTENT` to the approval; the offline planner never plans a checkout from page text.

## Alternatives considered

- **Keep purchases CRITICAL (deny).** Safest, but scenario 3/7/10 would be untestable end to end;
  the fixture-only checkout plus the default-off limit keeps real money out of reach in this build.
- **A per-purchase limit as well.** Simple to add later as another domain rule; the monthly limit
  plus exact approval of each total covers the scenarios.
- **Currency conversion for the limit.** Needs a verifiable exchange-rate source with evidence;
  refused rather than guessed.

## Consequences

- Orders and bookings are records that outlive task history (their task link becomes null); their
  evidence files follow the task's retention.
- `PURCHASE_LIMIT` / `PURCHASES_DISABLED` explain themselves with parameters; clients link to the
  setting.
- The permission model's "CRITICAL handling" section now reads: payments through supported-shop
  checkout are HIGH with the controls of this ADR; transfers and real-merchant checkout without
  step-up authentication remain denied.
