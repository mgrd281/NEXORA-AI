/**
 * Money as the API sends it (contracts Money: integer micro-units of an ISO 4217 currency) and
 * as server sentences carry it (moneyParam: "USD 129.99"). Every amount shown comes from a
 * verifiable source (the merchant's page, the order the merchant confirmed): these helpers only
 * format and add amounts that already exist, never estimate one. Pure — unit-tested.
 */
import type { Money } from '@jarvis/contracts';

/** Left-to-right isolate: "129,99 $" / "129.99 US$" stays one run inside an Arabic sentence. */
const LRI = '⁦';
const PDI = '⁩';

const cache = new Map<string, Intl.NumberFormat>();

function currencyFormat(intlLocale: string, currency: string, fractionDigits: number) {
  const key = `${intlLocale}|${currency}|${fractionDigits}`;
  let fmt = cache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(intlLocale, {
        style: 'currency',
        currency,
        minimumFractionDigits: Math.min(2, fractionDigits),
        maximumFractionDigits: Math.max(2, fractionDigits),
      });
    } catch {
      // An unknown currency code: the amount with the code, never a guessed symbol.
      fmt = new Intl.NumberFormat(intlLocale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.max(2, fractionDigits),
      });
    }
    cache.set(key, fmt);
  }
  return fmt;
}

/** How many decimals the micro amount really has (so 0.005 is never rounded to 0.01). */
function decimalsOf(amountMicro: number): number {
  const fraction = Math.abs(amountMicro) % 1_000_000;
  if (fraction === 0) return 2;
  const digits = String(fraction).padStart(6, '0').replace(/0+$/, '').length;
  return Math.max(2, digits);
}

/**
 * A Money amount in the viewer's locale ("$129.99", "129,99 $", "129.99 US$"). Plain text, no
 * isolates: wrap it with `ltrMoney` when it goes inside a translated sentence.
 */
export function formatMoney(money: Money, intlLocale: string): string {
  const fmt = currencyFormat(intlLocale, money.currency, decimalsOf(money.amountMicro));
  const value = money.amountMicro / 1_000_000;
  const text = fmt.format(value);
  return fmt.resolvedOptions().style === 'currency' ? text : `${money.currency} ${text}`;
}

/** formatMoney in a left-to-right isolate, for a parameter of a translated sentence. */
export function ltrMoney(money: Money, intlLocale: string): string {
  return `${LRI}${formatMoney(money, intlLocale)}${PDI}`;
}

const MONEY_PARAM = /^([A-Z]{3}) (-?)(\d+)\.(\d{2,6})$/;

/** "USD 129.99" (contracts moneyParam) → Money; null for anything else. */
export function parseMoneyParam(value: unknown): Money | null {
  if (typeof value !== 'string') return null;
  const m = MONEY_PARAM.exec(value.trim());
  if (!m) return null;
  const [, currency, sign, units, fraction] = m;
  const micro = Number(units) * 1_000_000 + Number(fraction!.padEnd(6, '0'));
  if (!Number.isSafeInteger(micro) || sign === '-') return null;
  return { amountMicro: micro, currency: currency! };
}

/** a + b when both are in the same currency; null otherwise (no conversion, ever). */
export function addMoney(a: Money, b: Money): Money | null {
  if (a.currency !== b.currency) return null;
  return { amountMicro: a.amountMicro + b.amountMicro, currency: a.currency };
}

/** a − b in the same currency (null for different currencies or a negative result). */
export function subtractMoney(a: Money, b: Money): Money | null {
  if (a.currency !== b.currency || b.amountMicro > a.amountMicro) return null;
  return { amountMicro: a.amountMicro - b.amountMicro, currency: a.currency };
}

/** Whole USD (preferences.spending.monthlyPurchaseLimitUsd) → Money. */
export function usd(amount: number): Money {
  return { amountMicro: Math.round(amount * 1_000_000), currency: 'USD' };
}
