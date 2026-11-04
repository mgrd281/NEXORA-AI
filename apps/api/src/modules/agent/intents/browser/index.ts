/**
 * Phase C — offline intents of the browser + commerce domain (owner: browser
 * + commerce engineer): finding and booking appointments and comparing /
 * buying products on supported sites (en/de/ar). See ../types.ts for the
 * rules every intent follows; a site is only ever one of the registered
 * recipes, named by the user.
 *
 *   booking.ts    "find free appointments at …", "book <service> at <site> [on <day>] [at <time>]"
 *                 and its follow-ups / answers (booking.find_slots → booking.book)
 *   shopping.ts   "compare prices for …" (shop.search → shop.compare), "buy … on <shop>"
 *                 (→ shop.prepare_cart → shop.checkout) and the answers to its questions
 */
import type { OfflineIntent } from '../types';
import { bookingIntent } from './booking';
import { buyProductIntent, compareProductsIntent, shoppingAnswerIntent } from './shopping';

/** Answers first (they look at the conversation), then the most specific phrasing first. */
export const browserIntents: readonly OfflineIntent[] = [
  shoppingAnswerIntent,
  bookingIntent,
  compareProductsIntent,
  buyProductIntent,
];
