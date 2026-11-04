/**
 * Phase C — tools of the browser + commerce domain (docs/architecture/phase-c.md §2):
 * browser.read, browser.fill, booking.find_slots, booking.book, shop.search,
 * shop.compare, shop.prepare_cart, shop.checkout.
 *
 * Owner: browser + commerce engineer. The registry (tools/registry.ts)
 * includes every tool exported here. Browser tools set `runsInBrowser` (hidden
 * from the planner while no browser worker is running) and `outbound`
 * (untrusted content feeding them needs approval); money and binding steps
 * declare `purchase` / `binding` so the Policy Engine applies the monthly
 * purchase limit and asks first. Tools never decide those themselves.
 */
import type { AnyTool } from '../types';
import { bookingBookTool } from './booking-book';
import { bookingFindSlotsTool } from './booking-find-slots';
import { browserFillTool } from './browser-fill';
import { browserReadTool } from './browser-read';
import { shopCheckoutTool } from './shop-checkout';
import { shopCompareTool } from './shop-compare';
import { shopPrepareCartTool } from './shop-prepare-cart';
import { shopSearchTool } from './shop-search';

export const browserTools: readonly AnyTool[] = [
  browserReadTool,
  browserFillTool,
  bookingFindSlotsTool,
  bookingBookTool,
  shopSearchTool,
  shopCompareTool,
  shopPrepareCartTool,
  shopCheckoutTool,
];
