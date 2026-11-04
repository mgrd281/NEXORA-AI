/**
 * The browser agent as the agent worker's tools see it
 * (docs/architecture/phase-c.md §3.5, §4.5): `runBrowserSession` queues one
 * recipe operation for the isolated browser worker and waits for its outcome.
 * Nothing here loads a browser — the agent worker never runs Chromium.
 *
 * One session per (tool execution key, site, operation): an existing session
 * of that key that is still queued / running or that succeeded is reused —
 * never duplicated (a retried tool finds the outcome of the first attempt);
 * one that failed, was handed over or interrupted is followed by a new one
 * (`#2`, `#3`, … suffix), so a retry after a definite failure really retries.
 * Binding operations are protected further by their commerce row and the
 * site's idempotency key (modules/commerce).
 *
 * Per user at most BROWSER_LIMITS.maxConcurrentPerUser sessions are queued or
 * running at once (an advisory lock serialises the check); further ones wait.
 */
import { BROWSER_LIMITS, type BrowserStopReason } from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext } from '../../db/pool';
import type { BrowserSessionRow, EvidenceArtifactRow } from '../../db/types';
import { AgentError } from '../agent/errors';
import type { ToolRuntime } from '../agent/tools/types';
import { enqueue, workerHealth } from '../jobs/queue';
import { sessionChanged, stopFacts, TERMINAL } from './session';
import { enabledOrigins, getRecipe, operationOf } from './sites';
import type { StopParams } from './types';

export interface BrowserRequest {
  /** A registered, enabled recipe. */
  siteId: string;
  /** One of the recipe's operations. */
  operation: string;
  /** Validated by the operation's schema before enqueueing. */
  input: Record<string, unknown>;
}

export interface BrowserOutcome {
  sessionId: string;
  status: 'succeeded' | 'failed' | 'handover' | 'interrupted';
  stopReason: BrowserStopReason | null;
  /** Facts of a stop (host, status, limit, seconds) for the task error. */
  stopParams: StopParams;
  /** The operation's output (its schema), when succeeded. */
  result: Record<string, unknown> | null;
  handoverUrl: string | null;
  artifacts: EvidenceArtifactRow[];
}

/** How often the tool looks at its session row while it waits. */
export const POLL_MS = 250;

const hostOf = (origin: string | undefined): string => {
  try {
    return origin ? new URL(origin).host : '';
  } catch {
    return '';
  }
};

export function siteUnsupported(host: string): AgentError {
  return new AgentError('TOOL_FAILED', `JARVIS does not support ${host || 'this site'}.`, {
    retryable: false,
    reason: 'SITE_UNSUPPORTED',
    params: { host: host || 'unknown' },
  });
}

export function browserUnavailable(): AgentError {
  return new AgentError('SERVICE_UNAVAILABLE', 'The browser agent is not running on this server.', {
    retryable: true,
    reason: 'BROWSER_UNAVAILABLE',
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Whether the browser agent can run for this tool execution right now. */
export async function browserReady(rt: Pick<ToolRuntime, 'db' | 'storage'>): Promise<boolean> {
  return rt.storage !== null && (await workerHealth(rt.db, 'browser')).healthy;
}

/**
 * Runs one recipe operation in the browser worker for this tool execution and
 * waits until it ends or `signal` aborts (then it asks the worker to stop —
 * cancel_requested_at — and rethrows the abort to the executor, which records
 * the step's outcome). Throws BROWSER_UNAVAILABLE at once when no browser
 * worker heartbeats or storage is missing, SITE_UNSUPPORTED when the site or
 * operation is not enabled here.
 */
export async function runBrowserSession(
  rt: ToolRuntime,
  req: BrowserRequest,
  signal: AbortSignal,
): Promise<BrowserOutcome> {
  const recipe = getRecipe(req.siteId);
  const origins = enabledOrigins(rt.config, req.siteId);
  const op = recipe ? operationOf(recipe, req.operation) : undefined;
  if (!recipe || !origins || !op) throw siteUnsupported(hostOf(origins?.[0]) || req.siteId);
  const parsed = op.input.safeParse(req.input);
  if (!parsed.success)
    throw new AgentError('TOOL_FAILED', `The browser request for ${recipe.name} is not valid.`, {
      reason: 'INVALID_STEP_INPUT',
      params: { step: req.operation },
    });
  if (!(await browserReady(rt))) throw browserUnavailable();

  const base = `${rt.idempotencyKey}:${req.siteId}:${req.operation}`;
  let sessionId: string | null = null;
  // Reuse, or queue a new session once the user has a free slot.
  for (;;) {
    sessionId = await withContext(rt.db, rt.ctx, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-sessions:${rt.ctx.userId}`}, 0))`.execute(
        trx,
      );
      const previous = await trx
        .selectFrom('browser_sessions')
        .selectAll()
        .where((eb) =>
          eb.or([eb('idempotency_key', '=', base), eb('idempotency_key', 'like', `${base}#%`)]),
        )
        .orderBy('created_at', 'desc')
        .execute();
      const latest = previous[0];
      if (
        latest &&
        (latest.status === 'queued' || latest.status === 'running' || latest.status === 'succeeded')
      )
        return latest.id;
      const live = await trx
        .selectFrom('browser_sessions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirstOrThrow();
      if (Number(live.n) >= BROWSER_LIMITS.maxConcurrentPerUser) return null;
      const key = previous.length === 0 ? base : `${base}#${previous.length + 1}`;
      const row = await trx
        .insertInto('browser_sessions')
        .values({
          tenant_id: rt.ctx.tenantId,
          user_id: rt.ctx.userId,
          task_id: rt.taskId,
          step_id: rt.stepId,
          status: 'queued',
          site_id: recipe.id,
          operation: req.operation,
          idempotency_key: key,
          request: JSON.stringify(parsed.data),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await enqueue(trx, {
        kind: 'browser.session',
        tenantId: rt.ctx.tenantId,
        userId: rt.ctx.userId,
        taskId: rt.taskId,
        payload: { sessionId: row.id },
        dedupeKey: `browser:${row.id}`,
        maxAttempts: 2,
      });
      await sessionChanged(trx, rt.ctx, row);
      return row.id;
    });
    if (sessionId) break;
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    await sleep(POLL_MS * 4, signal);
  }

  // Wait for the browser worker.
  let row: BrowserSessionRow | undefined;
  for (;;) {
    row = await withContext(rt.db, rt.ctx, (trx) =>
      trx.selectFrom('browser_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst(),
    );
    if (!row)
      throw new AgentError('INTERNAL', 'The browser session disappeared.', { retryable: true });
    if (TERMINAL.has(row.status)) break;
    if (signal.aborted) {
      await withContext(rt.db, rt.ctx, (trx) =>
        trx
          .updateTable('browser_sessions')
          .set({ cancel_requested_at: new Date() })
          .where('id', '=', sessionId)
          .where('cancel_requested_at', 'is', null)
          .execute(),
      ).catch(() => {});
      throw signal.reason ?? new Error('aborted');
    }
    await sleep(POLL_MS, signal);
  }
  const artifacts = await withContext(rt.db, rt.ctx, (trx) =>
    trx
      .selectFrom('evidence_artifacts')
      .selectAll()
      .where('browser_session_id', '=', row!.id)
      .orderBy('created_at')
      .execute(),
  );
  return {
    sessionId: row.id,
    status: row.status as BrowserOutcome['status'],
    stopReason: row.stop_reason,
    stopParams: stopFacts(row),
    result:
      row.status === 'succeeded' ? ((row.result as Record<string, unknown> | null) ?? {}) : null,
    handoverUrl: row.handover_url,
    artifacts,
  };
}

/** The session rows of this task by id (RLS: the owner's only), e.g. a search shop.compare reads. */
export async function sessionsOfTask(
  rt: Pick<ToolRuntime, 'db' | 'ctx' | 'taskId'>,
  ids: readonly string[],
): Promise<BrowserSessionRow[]> {
  if (ids.length === 0) return [];
  return withContext(rt.db, rt.ctx, (trx) =>
    trx
      .selectFrom('browser_sessions')
      .selectAll()
      .where('id', 'in', [...ids])
      .where('task_id', '=', rt.taskId)
      .execute(),
  );
}
