import type { MessageParams } from './types';

/**
 * ICU-lite message formatting:
 *   {name}                                         interpolation (numbers are localized)
 *   {count, plural, =0 {…} one {# item} other {# items}}   plural with exact matches and the
 *                                                   CLDR categories zero/one/two/few/many/other
 *   {kind, select, email {…} other {…}}            select
 * `#` inside a plural branch is the localized number. Branches may nest. There is no apostrophe
 * escaping (product copy never needs literal braces), so "You're" stays as written.
 */
export interface IcuContext {
  plural: Intl.PluralRules;
  number: (n: number) => string;
  /**
   * Wrap each interpolated, non-empty string in FSI…PDI (U+2068/U+2069) so it keeps its own
   * direction inside the sentence. Numbers and plural/select selectors are never wrapped.
   */
  isolate?: boolean;
}

/** First-strong isolate / pop directional isolate (Unicode bidi, UAX #9). */
export const FSI = '\u2068';
export const PDI = '\u2069';

export function formatIcu(message: string, params: MessageParams, ctx: IcuContext): string {
  return render(message, params, ctx, undefined);
}

function render(
  msg: string,
  params: MessageParams,
  ctx: IcuContext,
  hash: string | undefined,
): string {
  let out = '';
  let i = 0;
  while (i < msg.length) {
    const ch = msg[i];
    if (ch === '{') {
      const end = matchingBrace(msg, i);
      if (end < 0) {
        out += msg.slice(i);
        break;
      }
      out += renderArgument(msg.slice(i + 1, end), params, ctx);
      i = end + 1;
    } else if (ch === '#' && hash !== undefined) {
      out += hash;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function renderArgument(inner: string, params: MessageParams, ctx: IcuContext): string {
  const firstComma = inner.indexOf(',');
  if (firstComma < 0) return valueToString(params[inner.trim()], ctx);
  const name = inner.slice(0, firstComma).trim();
  const rest = inner.slice(firstComma + 1);
  const secondComma = rest.indexOf(',');
  const type = (secondComma < 0 ? rest : rest.slice(0, secondComma)).trim();
  const body = secondComma < 0 ? '' : rest.slice(secondComma + 1);
  const value = params[name];

  if (type === 'plural') {
    const n = typeof value === 'number' ? value : Number(value);
    const branches = parseBranches(body);
    const exact = branches.get(`=${n}`);
    const chosen =
      exact ??
      branches.get(Number.isFinite(n) ? ctx.plural.select(n) : 'other') ??
      branches.get('other');
    return chosen === undefined ? '' : render(chosen, params, ctx, ctx.number(n));
  }
  if (type === 'select') {
    const branches = parseBranches(body);
    const chosen = branches.get(String(value)) ?? branches.get('other');
    return chosen === undefined ? '' : render(chosen, params, ctx, undefined);
  }
  return valueToString(value, ctx);
}

function parseBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    const start = i;
    while (i < body.length && body[i] !== '{' && !/\s/.test(body[i] ?? '')) i++;
    const selector = body.slice(start, i);
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    if (body[i] !== '{') break;
    const end = matchingBrace(body, i);
    if (end < 0) break;
    if (selector) branches.set(selector, body.slice(i + 1, end));
    i = end + 1;
  }
  return branches;
}

function valueToString(value: MessageParams[string], ctx: IcuContext): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return ctx.number(value);
  return ctx.isolate && value !== '' ? `${FSI}${value}${PDI}` : value;
}

/** Names of every argument a message uses, including inside plural/select branches. */
export function argumentNames(message: string): string[] {
  const names = new Set<string>();
  const walk = (msg: string) => {
    let i = 0;
    while (i < msg.length) {
      if (msg[i] !== '{') {
        i += 1;
        continue;
      }
      const end = matchingBrace(msg, i);
      if (end < 0) return;
      const inner = msg.slice(i + 1, end);
      const comma = inner.indexOf(',');
      if (comma < 0) {
        names.add(inner.trim());
      } else {
        names.add(inner.slice(0, comma).trim());
        const rest = inner.slice(comma + 1);
        const second = rest.indexOf(',');
        if (second >= 0)
          for (const body of parseBranches(rest.slice(second + 1)).values()) walk(body);
      }
      i = end + 1;
    }
  };
  walk(message);
  return [...names].sort();
}
