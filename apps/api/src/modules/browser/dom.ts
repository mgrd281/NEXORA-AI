/**
 * Minimal structural types of the DOM objects the recipes read inside the page
 * (page.evaluate / $$eval callbacks). The API compiles without the DOM lib (it
 * is a Node program); these types are erased and only describe what the
 * in-page callbacks touch. Callbacks must stay self-contained: they run in the
 * browser, not here.
 */
export interface DomElement {
  readonly id: string;
  readonly classList: ArrayLike<string>;
  readonly attributes: ArrayLike<{ name: string; value: string }>;
  readonly textContent: string | null;
  readonly innerText?: string;
  readonly src?: string;
  readonly href?: string;
  readonly required?: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): DomElement | null;
  getBoundingClientRect(): { width: number; height: number };
}

export interface DomDocument {
  readonly title: string;
  readonly body: DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

export interface DomWindow {
  readonly document: DomDocument;
  getComputedStyle(el: DomElement): { visibility: string; display: string };
  fetch(
    url: string,
    init: { credentials: 'same-origin'; redirect: 'error' },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}
