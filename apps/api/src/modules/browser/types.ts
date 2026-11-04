/**
 * Phase C — the browser agent's recipe contract (docs/adr/0017, docs/architecture/phase-c.md §3.5).
 *
 * A recipe is the only way JARVIS uses a site: a reviewed, deterministic
 * program for one supported site, declared like a tool. It names the exact
 * origins the browser may load, and each operation declares its input and
 * output schemas, side effect, risk, idempotency, budgets and verification.
 * No model drives the page and page text never chooses what is clicked, so a
 * hostile page can at most make a recipe stop (PAGE_CHANGED) — never act.
 *
 * This file and sites/* are imported by BOTH processes: the agent worker's
 * tools read the static metadata (names, operations, risk) and the browser
 * worker runs the operations. Nothing here imports Playwright at runtime
 * (types only), the agent, SecretBox or a model.
 */
import type { BrowserStopReason, RiskLevel } from '@jarvis/contracts';
import type { Page } from 'playwright-core';
import type { z } from 'zod';

/** What recipes read from configuration (Config and BrowserWorkerConfig both provide it). */
export interface SiteConfig {
  isProduction: boolean;
  BROWSER_FIXTURE_ORIGIN?: string | undefined;
  /** BROWSER_SITES parsed; null = every recipe whose site is available. */
  browserSites: ReadonlySet<string> | null;
}

/**
 * none        reads only (re-run freely after a crash)
 * reversible  changes something the user can undo (a cart) — re-run after a crash is safe
 * binding     submits something that must never be repeated blindly (an order, a booking,
 *             a message): an interrupted run is OUTCOME_UNKNOWN and is reconciled, never re-run
 */
export type RecipeSideEffect = 'none' | 'reversible' | 'binding';

/** Limits of one session (BROWSER_LIMITS by default; an operation may only lower them). */
export interface BrowserBudgets {
  sessionTimeoutMs: number;
  pageLoadTimeoutMs: number;
  maxNavigations: number;
  maxRequests: number;
  maxArtifacts: number;
}

export interface ArtifactRef {
  artifactId: string;
  sha256: string;
  url: string | null;
}

/** What a recipe operation may do with the page — every navigation and file goes through here. */
export interface RecipeContext {
  readonly page: Page;
  readonly sessionId: string;
  /** The recipe's own origin (the first of its origins); null for multi-origin readers. */
  readonly origin: string | null;
  readonly signal: AbortSignal;
  /**
   * Navigates to an allowed URL (else stops with SITE_UNSUPPORTED), then runs detection.
   * `acceptStatus`: HTTP errors the recipe expects and reads itself (e.g. 409 "slot taken").
   */
  goto(url: string, opts?: NavigationOptions): Promise<{ status: number; url: string }>;
  /**
   * Runs `action` (a click that submits / navigates), waits for the resulting page load
   * and runs detection; returns the final status and URL.
   */
  navigateBy(
    action: () => Promise<unknown>,
    opts?: NavigationOptions,
  ): Promise<{ status: number; url: string }>;
  /** Detection on the current page: CAPTCHA / bot wall / login wall stop the session here. */
  check(status?: number, opts?: NavigationOptions): Promise<void>;
  /** A required element; missing → detection first, then PAGE_CHANGED. Never guessed. */
  require(selector: string): Promise<void>;
  screenshot(): Promise<ArtifactRef>;
  saveExtract(data: unknown, items: number): Promise<ArtifactRef>;
  saveIcs(text: string, pageUrl: string | null): Promise<ArtifactRef>;
  /** A same-origin GET through the browser itself (routing and allow-list apply), size-capped. */
  fetchText(
    url: string,
    maxBytes: number,
  ): Promise<{ status: number; contentType: string; text: string }>;
  /** JSON-LD blocks of the current page (raw strings). */
  jsonLd(): Promise<string[]>;
  /** Headers sent with the following requests of this page (e.g. the merchant's Idempotency-Key). */
  setExtraHeaders(headers: Record<string, string>): Promise<void>;
  /**
   * The point of no return of a binding operation: from here on an interruption
   * means the outcome is unknown (the session becomes 'interrupted').
   */
  markSubmitting(): void;
  /** Stops the operation: nothing more is done on the page. */
  stop(reason: BrowserStopReason, params?: StopParams): never;
  /** Whether a URL is on the recipe's origins. */
  allowed(url: string): boolean;
}

export interface NavigationOptions {
  /** HTTP statuses that are an answer of the site, not an error page (the recipe reads them). */
  acceptStatus?: readonly number[];
}

export interface StopParams {
  host?: string;
  status?: number;
  limit?: number;
  seconds?: number;
}

export interface RecipeOperation<I = unknown, O = unknown> {
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  sideEffect: RecipeSideEffect;
  risk: RiskLevel;
  idempotency: 'safe_to_retry' | 'once_per_step';
  /** The commerce record the browser worker finalises from this operation's result. */
  commit?: 'order' | 'booking';
  /** Lower limits than BROWSER_LIMITS for this operation. */
  budgets?: Partial<BrowserBudgets>;
  run(ctx: RecipeContext, input: I): Promise<O>;
  /** Deterministic check of the output against the input (a failed check fails the session). */
  verify(input: I, output: O): boolean;
}

/** A field a site's form asks for (static recipe metadata, reviewed with the recipe). */
export interface FormField {
  /** As the site labels it (the key of booking.book details / browser.fill fields). */
  label: string;
  /** What it is, so the planner can fill it from the account (name, email) or must ask. */
  kind: 'name' | 'email' | 'phone' | 'text';
  required: boolean;
  /** Personal data (shown as such in approvals). */
  personal: boolean;
}

export interface RecipeShop {
  /** The recipe can place orders (shop.checkout); otherwise the user finishes on the site. */
  checkout: boolean;
}

export interface RecipeBooking {
  timeZone: string;
  services: readonly { id: string; name: string; aliases: readonly string[] }[];
  fields: readonly FormField[];
}

export interface RecipeForm {
  fields: readonly FormField[];
  /** Submitting it is a binding commitment (BINDING_COMMITMENT, HIGH). */
  commitment: boolean;
}

export interface Recipe {
  id: string;
  version: string;
  /** Shown to the user ("Fixture Shop"). */
  name: string;
  /** Names users write for it (lower case, matched as whole words). */
  aliases: readonly string[];
  /** Exists only with BROWSER_FIXTURE_ORIGIN (development/test). */
  fixture: boolean;
  /**
   * The host approvals show before the site was read in this task (static for real
   * sites; fixtures run on a configurable local origin, so they say so).
   */
  hostLabel: string;
  /** Exact origins (scheme://host:port) the session may load; [] = not available here. */
  origins(config: SiteConfig): string[];
  operations: Readonly<Record<string, RecipeOperation<never, unknown>>>;
  shop?: RecipeShop;
  booking?: RecipeBooking;
  forms?: Readonly<Record<string, RecipeForm>>;
}

/** Thrown by RecipeContext.stop (and by the runner): ends the operation with a stop reason. */
export class RecipeStop extends Error {
  constructor(
    readonly reason: BrowserStopReason,
    readonly params: StopParams = {},
    /** Where the user can continue themselves (handover reasons). */
    readonly handoverUrl: string | null = null,
  ) {
    super(`browser session stopped: ${reason}`);
    this.name = 'RecipeStop';
  }
}

/** Stop reasons that hand the session over to the user (never bypassed). */
export const HANDOVER_REASONS: ReadonlySet<BrowserStopReason> = new Set([
  'CAPTCHA_DETECTED',
  'LOGIN_REQUIRED',
  'BOT_PROTECTION',
]);

/** Ends the operation (recipes call this; a function declaration so TypeScript narrows after it). */
export function stopSession(reason: BrowserStopReason, params: StopParams = {}): never {
  throw new RecipeStop(reason, params);
}
