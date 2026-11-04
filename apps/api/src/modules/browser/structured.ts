/**
 * Structured facts from pages of supported sites (docs/adr/0017, 0018): schema.org
 * JSON-LD (Product / Offer / Reservation / Order) and ICS calendar files, plus the
 * money parsing every recipe uses. Pure functions — no browser, no I/O — so what
 * JARVIS claims about a price, a slot or a confirmation is computed the same way
 * every time from what the site itself published. Values the page does not state
 * stay null (never 0, never "free"); malformed values are ignored, not guessed.
 *
 * Page content is untrusted: strings are length-capped and returned as data; no
 * value read here ever chooses a URL, a recipient or an action.
 */

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/** "79", "79.0", "79.00", "1,299.50" (thousands separators) → micro-units; null when not a plain amount. */
export function parseAmountMicro(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(raw * 1_000_000);
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^[$€£]\s*/, '');
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const units = Number(m[1]!.replaceAll(',', ''));
  const fraction = (m[2] ?? '').padEnd(6, '0');
  const micro = units * 1_000_000 + Number(fraction || '0');
  return Number.isSafeInteger(micro) ? micro : null;
}

export function currencyCode(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Z]{3}$/.test(raw.trim()) ? raw.trim() : null;
}

/* ------------------------------------------------------------------ */
/* JSON-LD                                                             */
/* ------------------------------------------------------------------ */

type Node = Record<string, unknown>;

const MAX_NODES = 200;
const MAX_TEXT = 300;

const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v);

/** A short, single-line string from page data (untrusted text), or null. */
export function cleanText(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    // Control characters (C0 and DEL) become spaces: page data is shown on one line.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function types(n: Node): string[] {
  const t = n['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^https?:\/\/schema\.org\//, ''));
}

/**
 * Every node of the JSON-LD blocks (top-level, arrays and @graph flattened),
 * at most MAX_NODES; blocks that are not JSON are skipped.
 */
export function jsonLdNodes(blocks: readonly string[]): Node[] {
  const out: Node[] = [];
  const visit = (v: unknown, depth: number) => {
    if (out.length >= MAX_NODES || depth > 4) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (!isNode(v)) return;
    if (Array.isArray(v['@graph'])) visit(v['@graph'], depth + 1);
    if (v['@type'] !== undefined) out.push(v);
  };
  for (const b of blocks.slice(0, 20)) {
    try {
      visit(JSON.parse(b), 0);
    } catch {
      // Not JSON: ignored (a broken block is not a fact).
    }
  }
  return out;
}

export const ofType = (nodes: readonly Node[], type: string): Node[] =>
  nodes.filter((n) => types(n).includes(type));

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

function intOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
}

export interface LdOffer {
  name: string | null;
  sku: string | null;
  url: string | null;
  priceMicro: number | null;
  currency: string | null;
  inStock: boolean | null;
  shippingMicro: number | null;
  shippingCurrency: string | null;
  deliveryMinDays: number | null;
  deliveryMaxDays: number | null;
  rating: { value: number; count: number } | null;
}

/** A schema.org Product with its (first) Offer, as the page states it. */
export function productOffer(product: Node): LdOffer {
  const offer = isNode(first(product.offers)) ? (first(product.offers) as Node) : {};
  const shipping = isNode(first(offer.shippingDetails))
    ? (first(offer.shippingDetails) as Node)
    : {};
  const rate = isNode(shipping.shippingRate) ? shipping.shippingRate : {};
  const delivery = isNode(shipping.deliveryTime) ? shipping.deliveryTime : {};
  const transit = isNode(delivery.transitTime) ? delivery.transitTime : {};
  const handling = isNode(delivery.handlingTime) ? delivery.handlingTime : {};
  const availability = typeof offer.availability === 'string' ? offer.availability : null;
  const rating = isNode(product.aggregateRating) ? product.aggregateRating : null;
  const ratingValue = rating ? Number(rating.ratingValue) : NaN;
  const ratingCount = rating ? Number(rating.reviewCount ?? rating.ratingCount) : NaN;
  const minT = intOrNull(transit.minValue);
  const maxT = intOrNull(transit.maxValue);
  const minH = intOrNull(handling.minValue) ?? 0;
  const maxH = intOrNull(handling.maxValue) ?? 0;
  return {
    name: cleanText(product.name),
    sku: cleanText(product.sku, 64),
    url: cleanText(offer.url ?? product.url, 2048),
    priceMicro: parseAmountMicro(
      offer.price ??
        (isNode(offer.priceSpecification) ? offer.priceSpecification.price : undefined),
    ),
    currency: currencyCode(
      offer.priceCurrency ??
        (isNode(offer.priceSpecification) ? offer.priceSpecification.priceCurrency : undefined),
    ),
    inStock:
      availability === null
        ? null
        : /InStock|InStoreOnly|LimitedAvailability|OnlineOnly/.test(availability)
          ? true
          : /OutOfStock|SoldOut|Discontinued/.test(availability)
            ? false
            : null,
    shippingMicro: parseAmountMicro(rate.value),
    shippingCurrency: currencyCode(rate.currency),
    deliveryMinDays: minT === null ? null : minT + minH,
    deliveryMaxDays: maxT === null ? null : maxT + maxH,
    rating:
      Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 5
        ? {
            value: ratingValue,
            count: Number.isInteger(ratingCount) && ratingCount >= 0 ? ratingCount : 0,
          }
        : null,
  };
}

export interface LdReservation {
  reference: string | null;
  confirmed: boolean;
  name: string | null;
  start: string | null;
  end: string | null;
  location: string | null;
  priceMicro: number | null;
  currency: string | null;
}

function isoInstant(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // An instant needs a zone (Z or an offset); a local time without one is not a fact we can place.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v.trim()))
    return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** "Name, address" — once, when the address already starts with the name. */
function placeText(name: string | null, address: string | null): string | null {
  if (name && address && address.toLowerCase().startsWith(name.toLowerCase())) return address;
  return [name, address].filter(Boolean).join(', ') || null;
}

/** A schema.org Reservation (any subtype), as the confirmation page states it. */
export function reservation(node: Node): LdReservation {
  const target = isNode(first(node.reservationFor)) ? (first(node.reservationFor) as Node) : {};
  const location = isNode(target.location) ? target.location : null;
  const status = typeof node.reservationStatus === 'string' ? node.reservationStatus : '';
  return {
    reference: cleanText(node.reservationNumber ?? node.reservationId, 200),
    confirmed: /ReservationConfirmed/.test(status),
    name: cleanText(target.name),
    start: isoInstant(node.startTime ?? target.startDate),
    end: isoInstant(node.endTime ?? target.endDate),
    location: location
      ? placeText(cleanText(location.name), cleanText(location.address))
      : cleanText(target.location),
    priceMicro: parseAmountMicro(node.totalPrice),
    currency: currencyCode(node.priceCurrency),
  };
}

export interface LdOrder {
  orderNumber: string | null;
  priceMicro: number | null;
  currency: string | null;
  merchant: string | null;
}

/** A schema.org Order (a merchant's order confirmation). */
export function order(node: Node): LdOrder {
  const merchant = isNode(node.merchant) ? node.merchant : isNode(node.seller) ? node.seller : {};
  return {
    orderNumber: cleanText(node.orderNumber, 200),
    priceMicro: parseAmountMicro(
      node.price ?? (isNode(node.totalPaymentDue) ? node.totalPaymentDue.price : undefined),
    ),
    currency: currencyCode(
      node.priceCurrency ??
        (isNode(node.totalPaymentDue) ? node.totalPaymentDue.priceCurrency : undefined),
    ),
    merchant: cleanText(merchant.name),
  };
}

/* ------------------------------------------------------------------ */
/* ICS (RFC 5545) — just what a booking confirmation needs             */
/* ------------------------------------------------------------------ */

export interface IcsEvent {
  uid: string | null;
  summary: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  /** The TZID the start was written in, when it was a local time. */
  timeZone: string | null;
}

/** Minutes east of UTC of `zone` at instant `ms`. */
function zoneOffsetMinutes(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return Math.round((asUtc - ms) / 60_000);
}

/** The instant of a local wall time in `zone` (DST-correct, computed in the zone). */
export function zonedInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  zone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  t = guess - zoneOffsetMinutes(t, zone) * 60_000;
  return new Date(t);
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function icsTime(params: string, value: string): { at: string | null; zone: string | null } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return { at: null, zone: null };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) {
    // A date (all-day): midnight UTC as the start of that date.
    return { at: new Date(Date.UTC(y, mo - 1, d)).toISOString(), zone: null };
  }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (m[7] === 'Z')
    return { at: new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString(), zone: null };
  const tzid = /(?:^|;)TZID=([^;:]+)/.exec(params)?.[1]?.replace(/^"|"$/g, '') ?? null;
  if (!tzid || !validZone(tzid)) return { at: null, zone: null }; // floating time: not placeable
  return { at: zonedInstant(y, mo, d, h, mi, s, tzid).toISOString(), zone: tzid };
}

const unescapeIcs = (s: string) =>
  s
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();

/** The first VEVENT of an ICS file (line folding undone); null when there is none. */
export function parseIcs(text: string): IcsEvent | null {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let inEvent = false;
  const ev: IcsEvent = {
    uid: null,
    summary: null,
    location: null,
    start: null,
    end: null,
    timeZone: null,
  };
  let found = false;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      if (found) break;
      inEvent = true;
      found = true;
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
    if (!m) continue;
    const name = m[1]!.toUpperCase();
    const params = m[2]!.replace(/^;/, '');
    const value = m[3]!;
    if (name === 'UID') ev.uid = cleanText(value, 200);
    else if (name === 'SUMMARY') ev.summary = cleanText(unescapeIcs(value));
    else if (name === 'LOCATION') ev.location = cleanText(unescapeIcs(value));
    else if (name === 'DTSTART') {
      const t = icsTime(params, value);
      ev.start = t.at;
      ev.timeZone = t.zone;
    } else if (name === 'DTEND') ev.end = icsTime(params, value).at;
  }
  return found ? ev : null;
}
