/**
 * Phase C — job handlers of the browser domain, run ONLY by the browser
 * worker (src/browser-worker.ts, docs/adr/0017). Owner: browser + commerce
 * engineer. The agent worker never imports this module: browser code and
 * Chromium run only in the browser worker, which holds no secrets
 * (BrowserJobDeps).
 *
 *   browser.session { sessionId }   runs one browser session — a recipe operation on one
 *                                   supported site in a fresh, ephemeral context — and records
 *                                   its lifecycle, result and evidence (browser_sessions,
 *                                   evidence_artifacts), and for binding operations the order /
 *                                   booking outcome (commerce), all in the owner's RLS context.
 *
 * Recovery: the job is idempotent. A session that already ended is left alone
 * (a replayed job does nothing). A session found 'running' was started by an
 * attempt that died: a `none` / `reversible` operation runs again, a `binding`
 * one is marked 'interrupted' and its order / booking 'unknown' — never
 * submitted twice (reconciled later by its idempotency key).
 */
import type { BrowserStopReason, TaskErrorReason } from '@jarvis/contracts';
import type { BrowserWorkerConfig } from '../../../config';
import { withContext, type Db, type DbContext } from '../../../db/pool';
import type { BrowserSessionRow, JobRow } from '../../../db/types';
import { finalizeBooking } from '../../commerce/bookings';
import { finalizeOrder } from '../../commerce/orders';
import type { DomainJobs } from '../../jobs/domain';
import type { ObjectStorage } from '../../storage/types';
import { storeEvidence } from '../evidence';
import { runRecipe, type RunOutcome } from '../runner';
import { finishSession, sessionChanged, TERMINAL, type SessionEnd } from '../session';
import { enabledOrigins, getRecipe, operationOf } from '../sites';
import type { BrowserBudgets, RecipeOperation } from '../types';

export interface BrowserJobLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** What the browser worker gives its handlers: no SecretBox, no model adapter, no OAuth clients. */
export interface BrowserJobDeps {
  config: BrowserWorkerConfig;
  db: Db;
  /** Evidence files (screenshots, extracts, ICS); browser sessions need it (null: refuse to run). */
  storage: ObjectStorage | null;
  log: BrowserJobLogger;
  workerId: string;
  /** Aborted when this job's lease is lost or the worker shuts down. */
  signal?: AbortSignal;
  /** Tests: lower budgets than BROWSER_LIMITS. */
  budgets?: Partial<BrowserBudgets>;
  /** How often a running session checks for cancellation (default 1 s). */
  cancelPollMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Op = RecipeOperation<never, unknown>;

/* ------------------------------------------------------------------ */
/* Commerce outcomes of binding operations                             */
/* ------------------------------------------------------------------ */

const keyOf = (session: BrowserSessionRow): string | null => {
  const k = (session.request as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof k === 'string' && k.length >= 16 ? k : null;
};

/** A stop reason as the TaskErrorReason stored on a failed order / booking. */
const stopAsReason = (r: BrowserStopReason | null): TaskErrorReason =>
  r === null || r === 'CANCELLED' ? 'STEP_INTERRUPTED' : r;

/** Records what a finished binding session means for its order / booking (same transaction). */
async function commit(
  trx: Parameters<Parameters<typeof withContext>[2]>[0],
  ctx: DbContext,
  op: Op,
  session: BrowserSessionRow,
  end: {
    status: SessionEnd['status'];
    stopReason: BrowserStopReason | null;
    submitted: boolean;
    result: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!op.commit) return;
  const key = keyOf(session);
  if (!key) return;
  const r = end.result as Record<string, unknown> | null;
  const outcome = typeof r?.outcome === 'string' ? r.outcome : null;
  if (op.commit === 'order') {
    if (end.status === 'succeeded' && outcome === 'placed')
      await finalizeOrder(trx, ctx, key, {
        kind: 'placed',
        merchantOrderId: String(r!.merchantOrderId),
        confirmationArtifactId:
          typeof r!.confirmationArtifactId === 'string' ? r!.confirmationArtifactId : null,
      });
    else if (end.status === 'succeeded' && outcome === 'unconfirmed')
      await finalizeOrder(trx, ctx, key, { kind: 'unknown' });
    else if (end.status === 'succeeded')
      await finalizeOrder(trx, ctx, key, {
        kind: 'failed',
        reason:
          outcome === 'price_changed'
            ? 'PRICE_CHANGED'
            : outcome === 'out_of_stock'
              ? 'OUT_OF_STOCK'
              : 'SITE_ERROR',
      });
    else if (end.status === 'interrupted' && end.submitted)
      await finalizeOrder(trx, ctx, key, { kind: 'unknown' });
    else
      await finalizeOrder(trx, ctx, key, { kind: 'failed', reason: stopAsReason(end.stopReason) });
    return;
  }
  if (end.status === 'succeeded' && outcome === 'confirmed')
    await finalizeBooking(trx, ctx, key, {
      kind: 'confirmed',
      reference: String(r!.reference),
      slotStart: typeof r!.start === 'string' ? r!.start : undefined,
      slotEnd: typeof r!.end === 'string' ? r!.end : null,
      confirmationArtifactId:
        typeof r!.screenshotArtifactId === 'string' ? r!.screenshotArtifactId : null,
      icsArtifactId: typeof r!.icsArtifactId === 'string' ? r!.icsArtifactId : null,
    });
  else if (end.status === 'succeeded' && outcome === 'unconfirmed')
    await finalizeBooking(trx, ctx, key, { kind: 'unknown' });
  else if (end.status === 'succeeded')
    await finalizeBooking(trx, ctx, key, {
      kind: 'failed',
      reason: outcome === 'slot_taken' ? 'SLOT_TAKEN' : 'BOOKING_DETAILS_MISSING',
    });
  else if (end.status === 'interrupted' && end.submitted)
    await finalizeBooking(trx, ctx, key, { kind: 'unknown' });
  else
    await finalizeBooking(trx, ctx, key, { kind: 'failed', reason: stopAsReason(end.stopReason) });
}

/** Ends a session that never got to run (or whose run died) and records its commerce outcome. */
async function endWithout(
  deps: BrowserJobDeps,
  ctx: DbContext,
  sessionId: string,
  end: SessionEnd & { submitted: boolean },
): Promise<void> {
  await withContext(deps.db, ctx, async (trx) => {
    const before = await trx
      .selectFrom('browser_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before || TERMINAL.has(before.status)) return;
    const row = await finishSession(trx, ctx, sessionId, end);
    const recipe = getRecipe(before.site_id);
    const op = recipe ? operationOf(recipe, before.operation) : undefined;
    if (row && op) await commit(trx, ctx, op, before, { ...end, result: end.result ?? null });
  });
}

/* ------------------------------------------------------------------ */
/* browser.session                                                     */
/* ------------------------------------------------------------------ */

type Claim =
  { kind: 'skip' } | { kind: 'run'; session: BrowserSessionRow; op: Op; origins: string[] };

async function claim(deps: BrowserJobDeps, ctx: DbContext, sessionId: string): Promise<Claim> {
  return withContext(deps.db, ctx, async (trx): Promise<Claim> => {
    const s = await trx
      .selectFrom('browser_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (!s || TERMINAL.has(s.status)) return { kind: 'skip' }; // gone, or a replayed job
    const recipe = getRecipe(s.site_id);
    const op = recipe ? operationOf(recipe, s.operation) : undefined;
    const origins = enabledOrigins(deps.config, s.site_id);
    const end = async (e: SessionEnd & { submitted: boolean }) => {
      await finishSession(trx, ctx, s.id, e);
      if (op) await commit(trx, ctx, op, s, { ...e, result: e.result ?? null });
      return { kind: 'skip' } as const;
    };
    if (!recipe || !op || !origins)
      return end({
        status: 'failed',
        stopReason: 'SITE_UNSUPPORTED',
        stopParams: {},
        submitted: false,
      });
    if (s.cancel_requested_at)
      return end({ status: 'interrupted', stopReason: 'CANCELLED', submitted: false });
    if (s.status === 'running' && op.sideEffect === 'binding') {
      // An earlier attempt died mid-run: it may have submitted. Never run it again.
      return end({ status: 'interrupted', stopReason: null, submitted: true });
    }
    if (!deps.storage || !deps.config.browserExecutablePath)
      return end({ status: 'failed', stopReason: 'BROWSER_CRASHED', submitted: false });
    const running = await trx
      .updateTable('browser_sessions')
      .set({
        status: 'running',
        started_at: s.started_at ?? new Date(),
        worker_id: deps.workerId,
        navigations: 0,
        requests: 0,
        blocked_requests: 0,
      })
      .where('id', '=', s.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (s.status === 'queued') await sessionChanged(trx, ctx, running);
    return { kind: 'run', session: running, op, origins };
  });
}

async function runSessionJob(deps: BrowserJobDeps, job: JobRow): Promise<'done'> {
  const ctx: DbContext = { tenantId: job.tenant_id, userId: job.user_id };
  const sessionId = (job.payload as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return 'done';
  const c = await claim(deps, ctx, sessionId);
  if (c.kind === 'skip') return 'done';
  const { session, op, origins } = c;
  const recipe = getRecipe(session.site_id)!;

  // Cancellation (the tool gave up or the user cancelled): checked while it runs.
  const cancel = new AbortController();
  let cancelled = false;
  const poll = setInterval(() => {
    withContext(deps.db, ctx, (trx) =>
      trx
        .selectFrom('browser_sessions')
        .select('cancel_requested_at')
        .where('id', '=', session.id)
        .executeTakeFirst(),
    )
      .then((r) => {
        if (r?.cancel_requested_at && !cancelled) {
          cancelled = true;
          cancel.abort();
        }
      })
      .catch(() => {});
  }, deps.cancelPollMs ?? 1_000);
  const signal = deps.signal ? AbortSignal.any([deps.signal, cancel.signal]) : cancel.signal;
  const storage = deps.storage!;
  let out: RunOutcome;
  try {
    out = await runRecipe({
      recipe,
      operation: op,
      input: session.request,
      sessionId: session.id,
      origins,
      executablePath: deps.config.browserExecutablePath,
      allowPrivate: deps.config.browserAllowPrivateHosts,
      // Chromium's sandbox needs a non-root user; production containers run as one.
      sandbox: deps.config.isProduction || (process.getuid?.() ?? 0) !== 0,
      budgets: deps.budgets,
      signal,
      cancelled: () => cancelled,
      storeArtifact: async (kind, body, pageUrl) => {
        const row = await storeEvidence({ db: deps.db, storage }, ctx, {
          taskId: session.task_id,
          sessionId: session.id,
          kind,
          body,
          pageUrl,
        });
        return { artifactId: row.id, sha256: row.sha256, url: row.page_url };
      },
    });
  } finally {
    clearInterval(poll);
  }
  // The lease was lost (or the worker is shutting down hard): whoever owns the job now decides.
  if (out.abandoned) return 'done';
  const end: SessionEnd = {
    status: out.status,
    stopReason: out.stopReason,
    stopParams: out.stopParams,
    handoverUrl: out.handoverUrl ?? (out.status === 'handover' ? (origins[0] ?? null) : null),
    result: out.result,
    navigations: out.navigations,
    requests: out.requests,
    blockedRequests: out.blockedRequests,
  };
  await withContext(deps.db, ctx, async (trx) => {
    const row = await finishSession(trx, ctx, session.id, end);
    if (row && row.ended_at)
      await commit(trx, ctx, op, session, {
        status: row.status as SessionEnd['status'],
        stopReason: row.stop_reason,
        submitted: out.submitted,
        result: out.result,
      });
  });
  deps.log.info('browser session finished', {
    sessionId: session.id,
    siteId: session.site_id,
    operation: session.operation,
    status: out.status,
    stopReason: out.stopReason,
    navigations: out.navigations,
    requests: out.requests,
    blockedRequests: out.blockedRequests,
  });
  return 'done';
}

export const browserJobs: DomainJobs<BrowserJobDeps> = {
  handlers: {
    'browser.session': {
      run: runSessionJob,
      // Out of attempts (crashes): the session ends; a binding one is unknown, never re-run.
      async onDead(deps, job) {
        const ctx: DbContext = { tenantId: job.tenant_id, userId: job.user_id };
        const sessionId = (job.payload as { sessionId?: unknown }).sessionId;
        if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return;
        const binding = await withContext(deps.db, ctx, async (trx) => {
          const s = await trx
            .selectFrom('browser_sessions')
            .select(['site_id', 'operation', 'status'])
            .where('id', '=', sessionId)
            .executeTakeFirst();
          const recipe = s ? getRecipe(s.site_id) : undefined;
          const op = recipe && s ? operationOf(recipe, s.operation) : undefined;
          return { started: s?.status === 'running', binding: op?.sideEffect === 'binding' };
        });
        await endWithout(
          deps,
          ctx,
          sessionId,
          binding.binding && binding.started
            ? { status: 'interrupted', stopReason: null, submitted: true }
            : { status: 'failed', stopReason: 'BROWSER_CRASHED', submitted: false },
        );
      },
    },
  },
  timers: [],
};
