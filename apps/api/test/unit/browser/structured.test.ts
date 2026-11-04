import { describe, expect, it } from 'vitest';
import {
  cleanText,
  jsonLdNodes,
  ofType,
  order,
  parseAmountMicro,
  parseIcs,
  productOffer,
  reservation,
  zonedInstant,
} from '../../../src/modules/browser/structured';

describe('money from pages', () => {
  it('parses plain amounts exactly (no float drift), refuses anything else', () => {
    expect(parseAmountMicro('79.00')).toBe(79_000_000);
    expect(parseAmountMicro('83.99')).toBe(83_990_000);
    expect(parseAmountMicro('0.1')).toBe(100_000);
    expect(parseAmountMicro('1,299.50')).toBe(1_299_500_000);
    expect(parseAmountMicro('$12')).toBe(12_000_000);
    expect(parseAmountMicro(4.99)).toBe(4_990_000);
    for (const bad of ['', 'free', '-1', '12,5', '1.2.3', null, undefined, NaN, -3])
      expect(parseAmountMicro(bad)).toBeNull();
  });
});

describe('schema.org JSON-LD', () => {
  const product = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'FX-100  Wireless\nHeadphones',
    sku: 'FX-100',
    offers: {
      '@type': 'Offer',
      price: '79.00',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: '4.99', currency: 'USD' },
        deliveryTime: {
          '@type': 'ShippingDeliveryTime',
          handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1 },
          transitTime: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 4 },
        },
      },
    },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '812' },
  });

  it('reads a Product with its Offer: price, shipping, delivery (handling + transit), stock, rating', () => {
    const [node] = ofType(jsonLdNodes([product]), 'Product');
    expect(productOffer(node!)).toEqual({
      name: 'FX-100 Wireless Headphones',
      sku: 'FX-100',
      url: null,
      priceMicro: 79_000_000,
      currency: 'USD',
      inStock: true,
      shippingMicro: 4_990_000,
      shippingCurrency: 'USD',
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      rating: { value: 4.5, count: 812 },
    });
  });

  it('keeps unstated facts unknown (never 0, never "free")', () => {
    const bare = JSON.stringify({
      '@type': 'Product',
      name: 'X',
      offers: { price: '10', priceCurrency: 'eur' },
    });
    const o = productOffer(ofType(jsonLdNodes([bare]), 'Product')[0]!);
    expect(o).toMatchObject({
      priceMicro: 10_000_000,
      currency: null,
      shippingMicro: null,
      deliveryMinDays: null,
      inStock: null,
      rating: null,
    });
  });

  it('flattens @graph and arrays, skips broken blocks, caps text', () => {
    const graph = JSON.stringify({
      '@graph': [{ '@type': 'Organization' }, { '@type': ['Thing', 'Product'], name: 'Y' }],
    });
    const nodes = jsonLdNodes([
      '{not json',
      graph,
      JSON.stringify([{ '@type': 'Order', orderNumber: 'FS-1' }]),
    ]);
    expect(nodes.map((n) => n['@type'])).toEqual(['Organization', ['Thing', 'Product'], 'Order']);
    expect(ofType(nodes, 'Product')).toHaveLength(1);
    expect(cleanText('a'.repeat(400))!.length).toBe(300);
    expect(cleanText('  \u0000x\ty  ')).toBe('x y');
  });

  it('reads a confirmed Reservation; a local time without zone is not a placeable fact', () => {
    const r = reservation({
      '@type': 'Reservation',
      reservationNumber: 'FD-4001',
      reservationStatus: 'https://schema.org/ReservationConfirmed',
      reservationFor: {
        '@type': 'Event',
        name: 'Check-up at Fixture Dental',
        startDate: '2026-11-10T09:00:00+01:00',
        endDate: '2026-11-10T09:30:00+01:00',
        location: {
          '@type': 'Place',
          name: 'Fixture Dental',
          address: 'Fixture Dental, 3 Molar Lane',
        },
      },
    });
    expect(r).toMatchObject({
      reference: 'FD-4001',
      confirmed: true,
      start: '2026-11-10T08:00:00.000Z',
      end: '2026-11-10T08:30:00.000Z',
      location: 'Fixture Dental, 3 Molar Lane',
    });
    expect(
      reservation({ '@type': 'Reservation', reservationFor: { startDate: '2026-11-10T09:00' } })
        .start,
    ).toBeNull();
    expect(
      reservation({ '@type': 'Reservation', reservationStatus: 'ReservationPending' }).confirmed,
    ).toBe(false);
  });

  it('reads an Order confirmation', () => {
    expect(
      order({
        '@type': 'Order',
        orderNumber: 'FS-1001',
        price: '83.99',
        priceCurrency: 'USD',
        merchant: { name: 'Fixture Shop' },
      }),
    ).toEqual({
      orderNumber: 'FS-1001',
      priceMicro: 83_990_000,
      currency: 'USD',
      merchant: 'Fixture Shop',
    });
  });
});

describe('ICS', () => {
  it('reads the first VEVENT (folded lines, escapes, UTC and TZID times)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:FD-4001@fixture-dental.test',
      'DTSTART;TZID=Europe/Berlin:20260329T020000',
      'DTEND:20260329T013000Z',
      'SUMMARY:Check-up at Fixture',
      '  Dental',
      'LOCATION:3 Molar Lane\\, Fixture City',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:second',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const ev = parseIcs(ics)!;
    expect(ev.uid).toBe('FD-4001@fixture-dental.test');
    expect(ev.summary).toBe('Check-up at Fixture Dental');
    expect(ev.location).toBe('3 Molar Lane, Fixture City');
    expect(ev.timeZone).toBe('Europe/Berlin');
    // 02:00 does not exist on that DST day: computed in the zone, not by adding hours.
    expect(ev.start).toBe(zonedInstant(2026, 3, 29, 2, 0, 0, 'Europe/Berlin').toISOString());
    expect(ev.end).toBe('2026-03-29T01:30:00.000Z');
    expect(parseIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBeNull();
    expect(
      parseIcs('BEGIN:VEVENT\nDTSTART;TZID=Mars/Olympus:20260101T100000\nEND:VEVENT')!.start,
    ).toBeNull();
  });

  it('converts local wall times DST-correctly', () => {
    expect(zonedInstant(2026, 11, 10, 10, 0, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-11-10T09:00:00.000Z',
    );
    expect(zonedInstant(2026, 7, 10, 10, 0, 0, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-10T08:00:00.000Z',
    );
  });
});
