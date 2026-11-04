# Skill: shopping-assistant

| Field   | Value                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id      | `shopping-assistant`                                                                                                                                                                                                           |
| version | 0.1.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                                                                              |
| status  | Implemented (Phase C) — compare offers on **supported shops**, prepare carts, and place orders on shops whose recipe can order (only the local fixture shop in this build), within the monthly purchase limit (off by default) |
| tools   | `shop.search`, `shop.compare`, `shop.prepare_cart`, `shop.checkout` (1.0.0); uses `browser.read`                                                                                                                               |

Design: [Phase C §3.6](../architecture/phase-c.md#36-shopping-scenarios-3-7-10-adr-0018), [ADR-0018](../adr/0018-commerce-safety.md),
[ADR-0017](../adr/0017-browser-agent-isolation.md). Code: `apps/api/src/modules/agent/tools/browser/shop-*.ts`,
recipes `apps/api/src/modules/browser/sites/fixture-shop.ts`, orders `apps/api/src/modules/commerce/orders.ts`.

## Description

Scenario 3: searches the supported shops for a product the user names and compares the offers —
price, shipping, total, delivery time, stock, rating and merchant facts (return policy, legal
notice, contact details, as each merchant's own pages state them) — with every offer's source page
and a screenshot. Scenario 7: a purchase is refused unless the monthly purchase limit allows it.
Scenario 10: an order is placed exactly once, even across crashes and retries. Supported shops in
this build: **Fixture Shop** (`fixture-shop`, checkout supported) and **Fixture Outlet**
(`fixture-outlet`, no checkout: the prepared cart is handed over) — both development/test only.
Real shops need their own reviewed recipe; real-merchant checkout additionally needs step-up
authentication (ADR-0018).

## Input / output

```ts
shop.search { query /* the user's words */, siteIds? } → { searchId /* session ids */, offerCount, offers, sites, text }
shop.compare { searchIds: ['{{s1.searchId}}'], preference?: 'total' | 'delivery' }
  → { comparison: ShoppingComparison, bestOfferId, bestOffer, text /* table with sources */ }
shop.prepare_cart { siteId, offer: '{{s2.bestOffer}}', quantity /* literal */ }
  → { cart: PreparedCart, cartId, totalMicro, currency, handoverUrl, checkoutSupported, checkoutDetails }
shop.checkout { siteId, order: '{{s3.checkoutDetails}}' } → { orderId, merchantOrderId, total, totalText }
```

Offline intents (en/de/ar, `apps/api/src/modules/agent/intents/browser/shopping.ts`):

| Request                                                                                                                      | Plan                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "compare prices for FX-100 headphones [on Fixture Shop and Fixture Outlet]" / "Vergleiche die Preise für …" / "قارن أسعار …" | `shop.search` → `shop.compare`                                                                    |
| "buy [2] FX-100 headphones on Fixture Shop" / "Kaufe … bei …" / "اشترِ … من …"                                               | search → compare → `shop.prepare_cart` → `shop.checkout` (shops without checkout: up to the cart) |
| "buy a new laptop" (no supported shop named)                                                                                 | `assistant.clarify ['site']`                                                                      |
| "… and buy the cheaper one" naming no shop                                                                                   | compare only: which merchant is cheaper is not known before the pages are read                    |

## Permissions and risk

- Connection: **Web access** (`web`); a running browser worker.
- `shop.search`, `shop.compare`: `LOW`. `shop.prepare_cart`: `MEDIUM` (reversible, approval with the
  item, quantity and price as seen). `shop.checkout`: `HIGH`, approval kind `purchase` (every item,
  quantity, unit and line price, subtotal, shipping, tax, total, merchant, delivery method /
  estimate / address, payment method as the merchant shows it, the monthly limit with spent and
  remaining, cart screenshot) — never auto-approved.
- Policy (domain rules, `apps/api/src/modules/agent/policy-domain.ts`): limit 0 (default) →
  `PURCHASES_DISABLED` (already at planning); not USD → `PURCHASE_CURRENCY`; committed this month +
  amount > limit → `PURCHASE_LIMIT { limit, spent, amount }`; otherwise `PURCHASE`. Money transfers
  stay `CRITICAL` and denied (no tool).

## Cost limits

No model cost. One browser session per shop and operation (`BROWSER_LIMITS`); a search reads at
most 4 product pages per shop.

## Execution policy

- Offers, carts and orders travel only as references to this task's own browser sessions and are
  checked against the recorded live reads before use; quantities and the query are literal.
- Ranking is deterministic: lowest known total (same currency), then delivery; unknown shipping
  stays unknown (never 0) and ranks after known totals; mixed currencies are not converted; only an
  offer whose title carries every model number of the query can be the best offer.
- Checkout: the orders row (`order:<step id>`, also the merchant's `Idempotency-Key`) is inserted
  before submitting and counts against the limit at once; the live checkout is re-read first
  (`PRICE_CHANGED` / `OUT_OF_STOCK`: nothing ordered); the browser worker records the merchant's
  confirmation; an interruption after submitting → `OUTCOME_UNKNOWN` `ORDER_UNKNOWN`, row `unknown`;
  an acknowledged retry looks the key up at the merchant (`order_lookup`) and records the order found
  there instead of submitting again.

## Verification criteria

Comparison: every offer with its source URL and screenshot. Checkout: the merchant's order id from
its `Order` JSON-LD confirmation and a total equal to the approved one (`orderPlaced`,
`totalMatches`), confirmation screenshot.

## Error handling

| Condition                                 | Result                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| A shop shows a CAPTCHA / login / bot wall | that shop is reported `handover`; all shops → `CAPTCHA_DETECTED` etc.      |
| Price or line changed since the cart      | `PRICE_CHANGED { expected, actual }`, order row `failed`, ask again        |
| Out of stock / declined by the merchant   | `OUT_OF_STOCK` / `SITE_ERROR { host, status }`, nothing ordered            |
| Interrupted after submitting              | `OUTCOME_UNKNOWN` `ORDER_UNKNOWN`; reconciled by key on acknowledged retry |
| Shop without checkout support             | planning refuses `shop.checkout`; the cart link is handed over             |

## Test cases (implemented)

`apps/api/test/integration/commerce/shopping.int.test.ts`: scenario 3 across two merchants;
a handed-over cart; scenario 7 (`PURCHASES_DISABLED` at planning, `PURCHASE_LIMIT` with amounts);
a purchase within the limit (exact `purchase` approval, one order, audit `order.placed`); replayed
jobs; `PRICE_CHANGED`; `OUT_OF_STOCK`; scenario 10 (slow merchant → `ORDER_UNKNOWN` → acknowledged
retry reconciles: one order, one submission) and a browser worker that died mid-checkout (never
re-run). Offline evals: `apps/api/evals/scenarios/shopping/` (11 scenarios) and `spec-02`,
`spec-06-unauthorized-purchase`.

## Known limitations

- A paid **booking** is checked against the limit when it is booked, but `committed_purchases`
  counts orders only, so it does not add to the month's spent amount (contract request).
- On an acknowledged retry of an unknown order, the order itself already counts as spent, so a tight
  limit can refuse the reconciliation (`PURCHASE_LIMIT`) (contract request: exclude the step's own
  order from the spent sum).
