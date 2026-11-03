import type { Locale } from '@jarvis/contracts';

/** The contract's limits for preferences.spending.monthlyAiBudgetUsd. */
export const BUDGET_MAX_USD = 10_000;

/** German writes 12,50; English and Arabic (Western digits) write 12.50. */
function separators(locale: Locale): { decimal: string; group: string } {
  return locale === 'de' ? { decimal: ',', group: '.' } : { decimal: '.', group: ',' };
}

/** A budget as the person would type it: "20", "12.5" (en) / "12,5" (de). */
export function formatBudgetInput(usd: number, locale: Locale): string {
  const rounded = Math.round(usd * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, '');
  return text.replace('.', separators(locale).decimal);
}

const escape = (c: string) => c.replace(/[.]/g, '\\.');

/**
 * Parses a typed budget in USD: an optional "$" or "USD", the locale's group separators (only
 * in valid groups of three), and at most two decimals. A lone "." or "," that is not a valid
 * group separator is read as the decimal mark, so "12.50" works in German too. Returns null
 * when the result is not a number from 0 to 10,000.
 */
export function parseBudget(input: string, locale: Locale): number | null {
  const { decimal, group } = separators(locale);
  const text = input
    .trim()
    .replace(/^\$\s*|\s*\$$|\s*USD$/gi, '')
    .trim();
  if (!text) return null;
  const grouped = new RegExp(`^\\d{1,3}(${escape(group)}\\d{3})+(${escape(decimal)}\\d+)?$`);
  let normalized: string;
  if (grouped.test(text)) {
    normalized = text.split(group).join('').replace(decimal, '.');
  } else {
    if ((text.match(/[.,]/g) ?? []).length > 1) return null;
    normalized = text.replace(/[.,]/, '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > BUDGET_MAX_USD) return null;
  return value;
}

export type UsageLevel = 'none' | 'ok' | 'warn' | 'full';

/** How close this month's AI spend is to the budget (warn from 80 %). */
export function usageLevel(spentMicro: number, budgetMicro: number): UsageLevel {
  if (budgetMicro <= 0) return 'none';
  if (spentMicro >= budgetMicro) return 'full';
  if (spentMicro >= budgetMicro * 0.8) return 'warn';
  return 'ok';
}
