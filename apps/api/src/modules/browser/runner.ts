/**
 * Runs one recipe operation in a fresh, ephemeral Chromium (docs/adr/0017).
 * Browser worker only — this is the one module that loads playwright-core.
 *
 * Per session: its own browser process (launched with an explicit, minimal
 * environment — no database URL, no secrets — and its own temporary HOME),
 * one BrowserContext without a persistent profile, downloads refused,
 * service workers blocked, WebSockets closed, WebRTC confined to the (dead)
 * proxy. The network allow-list has three layers (net-guard.ts): pinned
 * resolution of the recipe's hosts, a sinkhole proxy for everything but the
 * exact allowed host:port pairs (redirect hops included), and interception
 * of every request. Budgets (time, page loads, navigations, requests,
 * evidence files) stop the session when exceeded. Detection (detect.ts)
 * stops it at CAPTCHAs, bot walls and login walls and hands over to the user.
 *
 * The outcome is data (RunOutcome); the caller records it. An operation that
 * reached its point of no return (markSubmitting) and then failed in any way
 * is 'interrupted': its effect is unknown and must be reconciled, never
 * repeated.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BROWSER_LIMITS,
  type BrowserStopReason,
  type EvidenceArtifactKind,
} from '@jarvis/contracts';
import { chromium, type Browser, type Page } from 'playwright-core';
import { classifyPage, snapshotPage } from './detect';
import type { DomElement, DomWindow } from './dom';
import {
  chromiumNetwork,
  isAllowedUrl,
  resolveOrigins,
  sinkholeProxy,
  type AllowedOrigin,
} from './net-guard';
import {
  HANDOVER_REASONS,
  RecipeStop,
  type ArtifactRef,
  type BrowserBudgets,
  type NavigationOptions,
  type Recipe,
  type RecipeContext,
  type RecipeOperation,
  type StopParams,
} from './types';

export const DEFAULT_BUDGETS: BrowserBudgets = {
  sessionTimeoutMs: BROWSER_LIMITS.sessionTimeoutSeconds * 1000,
  pageLoadTimeoutMs: BROWSER_LIMITS.pageLoadTimeoutSeconds * 1000,
  maxNavigations: BROWSER_LIMITS.maxNavigations,
  maxRequests: BROWSER_LIMITS.maxRequests,
  maxArtifacts: BROWSER_LIMITS.maxArtifactsPerSession,
};

const ARTIFACT_MAX_BYTES: Record<EvidenceArtifactKind, number> = {
  screenshot: BROWSER_LIMITS.maxScreenshotBytes,
  extract: BROWSER_LIMITS.maxExtractBytes,
  ics: BROWSER_LIMITS.maxIcsBytes,
  // Phase D: call recordings come only from consented calls (telephony), never from a browser.
  recording: 0,
};

export interface RunInput {
  recipe: Recipe;
  operation: RecipeOperation<never, unknown>;
  /** Validated against operation.input again here. */
  input: unknown;
  sessionId: string;
  /** recipe.origins(config) for this deployment. */
  origins: readonly string[];
  executablePath: string | null;
  allowPrivate: ReadonlySet<string>;
  /** Chromium's sandbox (on in production; needs a non-root user). */
  sandbox: boolean;
  /** Overrides of the budgets (tests); the operation's own budgets still apply when lower. */
  budgets?: Partial<BrowserBudgets>;
  /** Aborted when the job lease is lost, the worker shuts down or the user cancels. */
  signal: AbortSignal;
  /** Why `signal` aborted, when it did: a cancellation is recorded, a lost lease is not. */
  cancelled?: () => boolean;
  storeArtifact(
    kind: EvidenceArtifactKind,
    body: Buffer,
    pageUrl: string | null,
  ): Promise<ArtifactRef>;
  /** Called for each request/navigation counter change (diagnostics only). */
  onCounters?(c: Counters): void;
}

export interface Counters {
  navigations: number;
  requests: number;
  blockedRequests: number;
}

export interface RunOutcome extends Counters {
  status: 'succeeded' | 'failed' | 'handover' | 'interrupted';
  stopReason: BrowserStopReason | null;
  stopParams: StopParams;
  handoverUrl: string | null;
  result: Record<string, unknown> | null;
  /** The operation passed its point of no return. */
  submitted: boolean;
  /** The lease was lost or the worker shut down mid-run: record nothing (another worker decides). */
  abandoned: boolean;
  artifacts: ArtifactRef[];
}

const hostOf = (raw: string): string => {
  try {
    return new URL(raw).host;
  } catch {
    return raw.slice(0, 255);
  }
};

/** A Chromium/Playwright navigation error → the stop reason it stands for. */
function navigationFailure(err: unknown, url: string, budgets: BrowserBudgets): RecipeStop {
  const m = err instanceof Error ? err.message : String(err);
  if (/Timeout|timed out/i.test(m))
    return new RecipeStop('BROWSER_TIMEOUT', {
      seconds: Math.round(budgets.pageLoadTimeoutMs / 1000),
    });
  if (
    /ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_BLOCKED_BY_CLIENT|ERR_EMPTY_RESPONSE/i.test(
      m,
    )
  )
    return new RecipeStop('NAVIGATION_BLOCKED', { host: hostOf(url) });
  return new RecipeStop('SITE_ERROR', { host: hostOf(url), status: 0 });
}

export async function runRecipe(run: RunInput): Promise<RunOutcome> {
  const budgets: BrowserBudgets = { ...DEFAULT_BUDGETS, ...run.budgets };
  for (const [k, v] of Object.entries(run.operation.budgets ?? {}))
    budgets[k as keyof BrowserBudgets] = Math.min(budgets[k as keyof BrowserBudgets], v);

  const counters: Counters = { navigations: 0, requests: 0, blockedRequests: 0 };
  const artifacts: ArtifactRef[] = [];
  let submitted = false;
  /** Set by the network layers; checked after every page action. */
  let pending: RecipeStop | null = null;
  let timedOut = false;

  const outcome = (o: Partial<RunOutcome> & Pick<RunOutcome, 'status'>): RunOutcome => ({
    stopReason: null,
    stopParams: {},
    handoverUrl: null,
    result: null,
    submitted,
    abandoned: false,
    artifacts,
    ...counters,
    ...o,
  });

  const parsed = run.operation.input.safeParse(run.input);
  if (!parsed.success || !run.executablePath)
    return outcome({ status: 'failed', stopReason: 'BROWSER_CRASHED' });

  const resolved = await resolveOrigins(run.origins, run.allowPrivate);
  if (!resolved.ok)
    return outcome({
      status: 'failed',
      stopReason: resolved.why === 'private' ? 'NAVIGATION_BLOCKED' : 'SITE_ERROR',
      stopParams:
        resolved.why === 'private' ? { host: resolved.host } : { host: resolved.host, status: 0 },
    });
  const allowed: AllowedOrigin[] = resolved.allowed;
  const net = chromiumNetwork(allowed);
  const proxy = await sinkholeProxy();

  let browser: Browser | null = null;
  let home: string | null = null;
  const sessionAbort = new AbortController();
  const signal = AbortSignal.any([run.signal, sessionAbort.signal]);
  const killTimer = setTimeout(() => {
    timedOut = true;
    sessionAbort.abort();
  }, budgets.sessionTimeoutMs);
  const onAbort = () => {
    void browser?.close().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    home = await mkdtemp(path.join(tmpdir(), 'jarvis-browser-'));
    browser = await chromium.launch({
      executablePath: run.executablePath,
      headless: true,
      chromiumSandbox: run.sandbox,
      timeout: 30_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // Chromium sees nothing of the worker's environment (no DATABASE_URL, no secrets).
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TZ: 'UTC' },
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: net.proxyBypass },
      args: [
        `--host-resolver-rules=${net.hostResolverRules}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--deny-permission-prompts',
        '--disable-sync',
        '--no-pings',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
      ],
    });
    if (signal.aborted) throw new Error('aborted');
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { ...BROWSER_LIMITS.viewport },
      locale: 'en-US',
      timezoneId: 'UTC',
      permissions: [],
      ignoreHTTPSErrors: false,
      bypassCSP: false,
    });
    // No WebSockets, no peer connections: a page can only talk HTTP to the allowed origins.
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'])
        try {
          Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
        } catch {
          // Already gone.
        }
    });
    const page: Page = await context.newPage();
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => {}); // no pop-ups or new tabs
    });
    page.on('dialog', (d) => void d.dismiss().catch(() => {}));
    page.setDefaultTimeout(budgets.pageLoadTimeoutMs);
    page.setDefaultNavigationTimeout(budgets.pageLoadTimeoutMs);

    const mainNavigation = (req: import('playwright-core').Request) =>
      req.isNavigationRequest() && req.frame() === page.mainFrame();

    // Layer 3: every request the page makes.
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      counters.requests += 1;
      if (mainNavigation(req)) counters.navigations += 1;
      run.onCounters?.(counters);
      if (counters.requests > budgets.maxRequests) {
        pending ??= new RecipeStop('BROWSER_BUDGET_EXCEEDED', { limit: budgets.maxRequests });
        counters.blockedRequests += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (counters.navigations > budgets.maxNavigations) {
        pending ??= new RecipeStop('BROWSER_BUDGET_EXCEEDED', { limit: budgets.maxNavigations });
        counters.blockedRequests += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }
      const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
      const inline = scheme === 'data:' || scheme === 'blob:';
      if (!inline && !isAllowedUrl(url, allowed)) {
        counters.blockedRequests += 1;
        if (mainNavigation(req))
          pending ??= new RecipeStop('NAVIGATION_BLOCKED', { host: hostOf(url) });
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });
    // Redirect hops are not intercepted: they are stopped by layers 1 and 2; count and note them.
    page.on('request', (req) => {
      if (!req.redirectedFrom()) return;
      if (mainNavigation(req)) counters.navigations += 1;
      if (!isAllowedUrl(req.url(), allowed)) {
        counters.blockedRequests += 1;
        if (mainNavigation(req))
          pending ??= new RecipeStop('NAVIGATION_BLOCKED', { host: hostOf(req.url()) });
      }
      if (counters.navigations > budgets.maxNavigations)
        pending ??= new RecipeStop('BROWSER_BUDGET_EXCEEDED', { limit: budgets.maxNavigations });
    });

    const allowedUrl = (u: string) => isAllowedUrl(u, allowed);
    const throwPending = () => {
      if (pending) throw pending;
      if (timedOut)
        throw new RecipeStop('BROWSER_TIMEOUT', {
          seconds: Math.round(budgets.sessionTimeoutMs / 1000),
        });
    };

    const store = async (kind: EvidenceArtifactKind, body: Buffer, pageUrl: string | null) => {
      if (artifacts.length >= budgets.maxArtifacts)
        throw new RecipeStop('BROWSER_BUDGET_EXCEEDED', { limit: budgets.maxArtifacts });
      if (body.length === 0 || body.length > ARTIFACT_MAX_BYTES[kind])
        throw new RecipeStop('BROWSER_BUDGET_EXCEEDED', { limit: ARTIFACT_MAX_BYTES[kind] });
      const ref = await run.storeArtifact(kind, body, pageUrl);
      artifacts.push(ref);
      return ref;
    };

    const screenshot = async (): Promise<ArtifactRef> => {
      let png = await page.screenshot({
        type: 'png',
        fullPage: true,
        timeout: budgets.pageLoadTimeoutMs,
      });
      if (png.length > ARTIFACT_MAX_BYTES.screenshot)
        png = await page.screenshot({
          type: 'png',
          fullPage: false,
          timeout: budgets.pageLoadTimeoutMs,
        });
      return store('screenshot', png, page.url());
    };

    const check = async (
      status: number | null = null,
      opts: NavigationOptions = {},
    ): Promise<void> => {
      throwPending();
      const snap = await snapshotPage(page, status);
      const verdict = classifyPage(snap);
      if (verdict.kind === 'handover') {
        // Evidence of what JARVIS saw, then stop: never solved, never bypassed.
        await screenshot().catch(() => null);
        throw new RecipeStop(verdict.reason, { host: hostOf(snap.url) }, snap.url);
      }
      if (verdict.kind === 'error' && !opts.acceptStatus?.includes(verdict.status))
        throw new RecipeStop('SITE_ERROR', { host: hostOf(snap.url), status: verdict.status });
    };

    const afterNavigation = async (status: number, url: string, opts?: NavigationOptions) => {
      throwPending();
      if (!allowedUrl(url)) throw new RecipeStop('NAVIGATION_BLOCKED', { host: hostOf(url) });
      await check(status, opts);
      return { status, url };
    };

    const ctx: RecipeContext = {
      page,
      sessionId: run.sessionId,
      origin: allowed.length === 1 ? allowed[0]!.origin : null,
      signal,
      allowed: allowedUrl,
      async goto(url, opts) {
        if (!allowedUrl(url)) throw new RecipeStop('SITE_UNSUPPORTED', { host: hostOf(url) });
        throwPending();
        let status: number;
        try {
          const resp = await page.goto(url, {
            waitUntil: 'load',
            timeout: budgets.pageLoadTimeoutMs,
          });
          status = resp?.status() ?? 200;
        } catch (err) {
          throwPending();
          throw navigationFailure(err, url, budgets);
        }
        return afterNavigation(status, page.url(), opts);
      },
      async navigateBy(action, opts) {
        throwPending();
        let status: number;
        try {
          const [resp] = await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: budgets.pageLoadTimeoutMs }),
            action(),
          ]);
          status = resp?.status() ?? 200;
        } catch (err) {
          throwPending();
          throw navigationFailure(err, page.url(), budgets);
        }
        return afterNavigation(status, page.url(), opts);
      },
      check: (status, opts) => check(status ?? null, opts),
      async require(selector) {
        try {
          await page.locator(selector).first().waitFor({ state: 'attached', timeout: 3_000 });
        } catch {
          await check(null);
          throw new RecipeStop('PAGE_CHANGED', { host: hostOf(page.url()) });
        }
      },
      screenshot,
      saveExtract: (data, _items) =>
        store('extract', Buffer.from(JSON.stringify(data), 'utf8'), page.url()),
      saveIcs: (text, pageUrl) => store('ics', Buffer.from(text, 'utf8'), pageUrl),
      async fetchText(url, maxBytes) {
        if (!allowedUrl(url)) throw new RecipeStop('SITE_UNSUPPORTED', { host: hostOf(url) });
        const res = await page.evaluate(
          async ({ u, max }) => {
            const w = globalThis as unknown as DomWindow;
            const r = await w.fetch(u, { credentials: 'same-origin', redirect: 'error' });
            const text = await r.text();
            return {
              status: r.status,
              contentType: r.headers.get('content-type') ?? '',
              text: text.slice(0, max + 1),
            };
          },
          { u: url, max: maxBytes },
        );
        throwPending();
        if (res.text.length > maxBytes)
          throw new RecipeStop('BROWSER_BUDGET_EXCEEDED', { limit: maxBytes });
        return res;
      },
      jsonLd: () =>
        page.$$eval('script[type="application/ld+json"]', (els) =>
          (els as unknown as DomElement[])
            .slice(0, 20)
            .map((e) => (e.textContent ?? '').slice(0, 100_000)),
        ),
      setExtraHeaders: (headers) => page.setExtraHTTPHeaders(headers),
      markSubmitting() {
        submitted = true;
      },
      stop(reason, params = {}) {
        throw new RecipeStop(reason, params, HANDOVER_REASONS.has(reason) ? page.url() : null);
      },
    };

    const result = await run.operation.run(ctx, parsed.data as never);
    throwPending();
    const out = run.operation.output.safeParse(result);
    if (!out.success || !run.operation.verify(parsed.data as never, out.data))
      return outcome({
        status: submitted ? 'interrupted' : 'failed',
        stopReason: submitted ? null : 'PAGE_CHANGED',
        stopParams: { host: hostOf(page.url()) },
      });
    return outcome({ status: 'succeeded', result: out.data as Record<string, unknown> });
  } catch (err) {
    if (run.signal.aborted && !run.cancelled?.())
      return outcome({ status: 'interrupted', abandoned: true });
    let stop: RecipeStop | null = pending ?? (err instanceof RecipeStop ? err : null);
    if (timedOut && !(err instanceof RecipeStop && HANDOVER_REASONS.has(err.reason)))
      stop = new RecipeStop('BROWSER_TIMEOUT', {
        seconds: Math.round(budgets.sessionTimeoutMs / 1000),
      });
    if (run.cancelled?.()) return outcome({ status: 'interrupted', stopReason: 'CANCELLED' });
    if (submitted) {
      // Past the point of no return: whatever happened, the effect is unknown.
      return outcome({
        status: 'interrupted',
        stopReason: stop?.reason ?? null,
        stopParams: stop?.params ?? {},
      });
    }
    if (!stop) return outcome({ status: 'failed', stopReason: 'BROWSER_CRASHED' });
    if (HANDOVER_REASONS.has(stop.reason))
      return outcome({
        status: 'handover',
        stopReason: stop.reason,
        stopParams: stop.params,
        handoverUrl: stop.handoverUrl ?? null,
      });
    return outcome({ status: 'failed', stopReason: stop.reason, stopParams: stop.params });
  } finally {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
    if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
