/**
 * Readable-text extraction for fetched pages. Drops non-content elements
 * (scripts, styles, navigation, footers, SVG, hidden elements) and prefers
 * <main>/<article> when present.
 */
import { parse, type HTMLElement } from 'node-html-parser';

const DROP = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'footer',
  'iframe',
  'object',
  'embed',
  'canvas',
  'form',
  'button',
  'select',
  'head',
];

const HIDDEN = '[hidden], [aria-hidden="true"]';

function isStyleHidden(el: HTMLElement): boolean {
  const style = el.getAttribute('style');
  return !!style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ExtractedPage {
  title: string;
  /** Visible, readable text. */
  text: string;
  /** All text including hidden elements — used only for injection scanning. */
  fullText: string;
}

function textOf(root: HTMLElement): string {
  return normalizeText(root.structuredText);
}

export function extractHtml(html: string): ExtractedPage {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: true, style: true, noscript: true, pre: true },
  });

  const titleEl = root.querySelector('title');
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const h1 = root.querySelector('h1');
  const title = normalizeText(
    (titleEl?.text || ogTitle || h1?.text || '').replace(/\s+/g, ' '),
  ).slice(0, 200);

  for (const tag of ['script', 'style', 'noscript', 'template']) {
    for (const el of root.querySelectorAll(tag)) el.remove();
  }
  const body = root.querySelector('body') ?? root;
  const fullText = textOf(body);

  for (const tag of DROP) for (const el of root.querySelectorAll(tag)) el.remove();
  for (const el of root.querySelectorAll(HIDDEN)) el.remove();
  for (const el of root.querySelectorAll('[style]')) if (isStyleHidden(el)) el.remove();

  const main = root.querySelector('main') ?? root.querySelector('article');
  const content = main ?? root.querySelector('body') ?? root;
  return { title, text: textOf(content), fullText };
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  // Cut at a word boundary close to the limit.
  const cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return {
    text: `${cut.slice(0, lastBreak > max * 0.8 ? lastBreak : max).trimEnd()}…`,
    truncated: true,
  };
}
