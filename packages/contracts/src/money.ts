import type { Money } from './schemas';

/**
 * A money parameter of a server sentence or task error (contracts
 * ServerMessageKey doc): "<ISO 4217 code> <amount>" with a "." decimal
 * separator and at least two decimals, e.g. "USD 129.99" — the same in every
 * locale, so a stored sentence never misstates an amount.
 */
export function moneyParam(m: Money): string {
  const negative = m.amountMicro < 0;
  const abs = Math.abs(m.amountMicro);
  const units = Math.floor(abs / 1_000_000);
  const micro = String(abs % 1_000_000).padStart(6, '0');
  let fraction = micro.replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${m.currency} ${negative ? '-' : ''}${units}.${fraction}`;
}

/** Whole or fractional currency units → micro-units (rounded to the nearest micro-unit). */
export function toMicro(amount: number): number {
  return Math.round(amount * 1_000_000);
}
