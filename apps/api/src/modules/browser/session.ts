/**
 * The lifecycle of browser_sessions rows (docs/adr/0017): queued → running →
 * succeeded | failed | handover | interrupted, with the CHECKs of 0005
 * respected by construction. Every change emits browser_session.changed
 * (ids, enums and times only). Shared by the agent worker's client (queued,
 * cancellation) and the browser worker (running, finished).
 *
 * `result` holds the operation's validated output once succeeded; for a
 * session that stopped it holds `{ stop: { host?, status?, limit?, seconds? } }`
 * — the facts the tool needs for its TaskError params (never page content).
 */
import type { BrowserStopReason } from '@jarvis/contracts';
import { sql } from 'kysely';
import type { DbContext, Trx } from '../../db/pool';
import type { BrowserSessionRow, BrowserSessionStatusValue } from '../../db/types';
import { appendEvent } from '../events/events';
import type { StopParams } from './types';

export const TERMINAL: ReadonlySet<BrowserSessionStatusValue> = new Set([
  'succeeded',
  'failed',
  'handover',
  'interrupted',
]);

export async function sessionChanged(
  trx: Trx,
  ctx: DbContext,
  row: BrowserSessionRow,
): Promise<void> {
  await appendEvent(trx, ctx, {
    taskId: row.task_id,
    type: 'browser_session.changed',
    data: {
      sessionId: row.id,
      taskId: row.task_id,
      stepId: row.step_id,
      status: row.status,
      stopReason: row.stop_reason,
    },
  });
}

export interface SessionEnd {
  status: 'succeeded' | 'failed' | 'handover' | 'interrupted';
  stopReason: BrowserStopReason | null;
  stopParams?: StopParams;
  handoverUrl?: string | null;
  result?: Record<string, unknown> | null;
  navigations?: number;
  requests?: number;
  blockedRequests?: number;
}

/** Ends a queued or running session (no-op on an ended one). Returns the row as it is now. */
export async function finishSession(
  trx: Trx,
  ctx: DbContext,
  sessionId: string,
  end: SessionEnd,
): Promise<BrowserSessionRow | null> {
  let status = end.status;
  let stopReason = end.stopReason;
  let handoverUrl: string | null = null;
  if (status === 'handover') {
    handoverUrl = end.handoverUrl ? end.handoverUrl.slice(0, 2048) : null;
    // A handover always says where the user continues; without a URL it is a plain failure.
    if (!handoverUrl) status = 'failed';
  }
  if ((status === 'failed' || status === 'handover') && !stopReason) stopReason = 'BROWSER_CRASHED';
  if (status === 'succeeded') stopReason = null;
  const result =
    status === 'succeeded'
      ? (end.result ?? {})
      : end.stopParams && Object.keys(end.stopParams).length > 0
        ? { stop: end.stopParams }
        : null;
  const updated = await trx
    .updateTable('browser_sessions')
    .set({
      status,
      stop_reason: stopReason,
      handover_url: handoverUrl,
      result: result === null ? null : JSON.stringify(result),
      ...(end.navigations !== undefined ? { navigations: end.navigations } : {}),
      ...(end.requests !== undefined ? { requests: end.requests } : {}),
      ...(end.blockedRequests !== undefined ? { blocked_requests: end.blockedRequests } : {}),
      ended_at: sql<Date>`now()`,
    })
    .where('id', '=', sessionId)
    .where('status', 'in', ['queued', 'running'])
    .returningAll()
    .executeTakeFirst();
  if (!updated)
    return (
      (await trx
        .selectFrom('browser_sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .executeTakeFirst()) ?? null
    );
  await sessionChanged(trx, ctx, updated);
  return updated;
}

/** The stop facts recorded with a session that did not succeed. */
export function stopFacts(row: Pick<BrowserSessionRow, 'result'>): StopParams {
  const r = row.result as { stop?: StopParams } | null;
  return r && typeof r === 'object' && r.stop && typeof r.stop === 'object' ? r.stop : {};
}
