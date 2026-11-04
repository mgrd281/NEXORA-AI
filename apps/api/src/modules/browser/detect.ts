/**
 * Detection of pages JARVIS must not work through (docs/adr/0017): CAPTCHAs,
 * bot-protection walls, login walls and error pages. When one is found the
 * session stops — CAPTCHA_DETECTED / BOT_PROTECTION / LOGIN_REQUIRED hand the
 * site over to the user (status 'handover' with the page URL), an HTTP error is
 * SITE_ERROR. JARVIS never solves, waits out or works around any of them.
 *
 * `classifyPage` is pure (unit-tested on snapshots); `snapshotPage` collects
 * the facts from a live page.
 */
import type { BrowserStopReason } from '@jarvis/contracts';
import type { Page } from 'playwright-core';
import type { DomWindow } from './dom';

export interface PageSnapshot {
  url: string;
  /** HTTP status of the main document (null: not known, e.g. after client-side navigation). */
  status: number | null;
  title: string;
  /** src of every frame (iframes included). */
  frames: string[];
  /** src of every <script src>. */
  scripts: string[];
  /** class / id / data-sitekey markers of challenge widgets found in the DOM. */
  widgets: string[];
  /** Visible password fields. */
  passwordFields: number;
  /** Visible text (bounded). */
  text: string;
}

export type Classification =
  | { kind: 'ok' }
  | {
      kind: 'handover';
      reason: Extract<BrowserStopReason, 'CAPTCHA_DETECTED' | 'LOGIN_REQUIRED' | 'BOT_PROTECTION'>;
    }
  | { kind: 'error'; reason: 'SITE_ERROR'; status: number };

const CAPTCHA_SRC =
  /(recaptcha|hcaptcha\.com|challenges\.cloudflare\.com\/turnstile|turnstile|arkoselabs|funcaptcha|captcha-delivery\.com|geetest)/i;
const CAPTCHA_WIDGET =
  /^(g-recaptcha|h-captcha|cf-turnstile|frc-captcha|captcha|data-sitekey|challenge-form|cf-challenge|px-captcha)$/i;
const CHALLENGE_TEXT =
  /(verify (that )?you are (a )?human|are you a robot|i'?m not a robot|not a robot|complete the security check|checking your browser|just a moment\.\.\.|bestätigen sie, dass sie ein mensch sind|ich bin kein roboter|تحقق من أنك إنسان|لست روبوت)/i;
const BOT_TEXT =
  /(access denied|request (was )?blocked|automated (traffic|requests|access)|unusual traffic|pardon our interruption|bot (protection|detection)|incapsula incident|_incapsula_resource|datadome|perimeterx|request unsuccessful|zugriff verweigert|automatisierte anfragen|تم حظر)/i;
const LOGIN_TEXT = /(sign in|log in|login|anmelden|einloggen|تسجيل الدخول)/i;

/**
 * What the page is, in order of precedence: a CAPTCHA (widgets, frames,
 * scripts or a challenge page), a bot-protection wall (blocked status + its
 * wording), a login wall (a visible password field, or the recipe's marker),
 * an HTTP error, or an ordinary page.
 */
export function classifyPage(
  s: PageSnapshot,
  opts: { expectLogin?: boolean; loginMarker?: RegExp } = {},
): Classification {
  const captchaWidget = s.widgets.some((w) => CAPTCHA_WIDGET.test(w));
  const captchaResource = [...s.frames, ...s.scripts].some((src) => CAPTCHA_SRC.test(src));
  const challengeWords = CHALLENGE_TEXT.test(`${s.title}\n${s.text}`);
  if (captchaWidget || captchaResource) return { kind: 'handover', reason: 'CAPTCHA_DETECTED' };
  const blockedStatus =
    s.status === 403 || s.status === 429 || s.status === 503 || s.status === 401;
  // A challenge page: its wording on a blocked response, or on a short interstitial page
  // (an article that merely mentions robots is long and keeps its content).
  if (challengeWords && (blockedStatus || s.text.length < 3_000))
    return { kind: 'handover', reason: 'CAPTCHA_DETECTED' };
  if (blockedStatus && BOT_TEXT.test(`${s.title}\n${s.text}`))
    return { kind: 'handover', reason: 'BOT_PROTECTION' };
  if (!opts.expectLogin) {
    if (s.passwordFields > 0) return { kind: 'handover', reason: 'LOGIN_REQUIRED' };
    if (opts.loginMarker?.test(`${s.title}\n${s.text}`))
      return { kind: 'handover', reason: 'LOGIN_REQUIRED' };
    if (s.status === 401 && LOGIN_TEXT.test(`${s.title}\n${s.text}`))
      return { kind: 'handover', reason: 'LOGIN_REQUIRED' };
  }
  if (s.status !== null && s.status >= 400)
    return { kind: 'error', reason: 'SITE_ERROR', status: s.status };
  return { kind: 'ok' };
}

/** Collects the facts classifyPage needs from the live page (bounded; never throws on odd pages). */
export async function snapshotPage(page: Page, status: number | null): Promise<PageSnapshot> {
  const facts = await page
    .evaluate(() => {
      // Self-contained: runs in the page.
      const w = globalThis as unknown as DomWindow;
      const doc = w.document;
      const widgets: string[] = [];
      const marked = Array.from(doc.querySelectorAll('[class],[id],[data-sitekey]')).slice(0, 5000);
      for (const el of marked) {
        for (const c of Array.from(el.classList))
          if (/captcha|turnstile|challenge/i.test(c)) widgets.push(c);
        if (el.id && /captcha|turnstile|challenge/i.test(el.id)) widgets.push(el.id);
        if (el.hasAttribute('data-sitekey')) widgets.push('data-sitekey');
      }
      let passwordFields = 0;
      for (const el of Array.from(doc.querySelectorAll('input[type=password]'))) {
        const r = el.getBoundingClientRect();
        const style = w.getComputedStyle(el);
        if (
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        )
          passwordFields += 1;
      }
      return {
        title: doc.title ?? '',
        frames: Array.from(doc.querySelectorAll('iframe'))
          .map((f) => f.src || '')
          .slice(0, 50),
        scripts: Array.from(doc.querySelectorAll('script[src]'))
          .map((x) => x.src ?? '')
          .slice(0, 100),
        widgets: widgets.slice(0, 50),
        passwordFields,
        text: (doc.body?.innerText ?? '').slice(0, 20_000),
      };
    })
    .catch(() => ({
      title: '',
      frames: [],
      scripts: [],
      widgets: [],
      passwordFields: 0,
      text: '',
    }));
  const frames = [...facts.frames, ...page.frames().map((f) => f.url())];
  return { url: page.url(), status, ...facts, frames };
}
