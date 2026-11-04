/**
 * Orders placed by shop.checkout — exactly once (docs/adr/0018).
 *
 * The row is inserted BEFORE anything is submitted (status 'submitting'; it
 * counts against the monthly purchase limit at once, through the
 * committed_purchases view), keyed by `order:<step id>` — stable across
 * retries, including acknowledged ones — and that same key is the merchant's
 * Idempotency-Key, so neither the database nor the merchant can take a second
 * order for the step. A unique violation means "this already happened": the
 * caller reads the existing row (and reconciles it with the merchant when its
 * outcome is unknown) instead of submitting again.
 *
 * Transitions (finalizeOrder, conditional UPDATEs — safe to call twice):
 *   submitting → placed   the merchant's confirmation (order id, total = approved total)
 *   submitting → failed   definitely not placed (price changed, out of stock, declined, stopped
 *                         before submitting)
 *   submitting → unknown  interrupted after submission started (ORDER_UNKNOWN)
 *   unknown    → placed   reconciliation found the order at the merchant
 *   failed / unknown → submitting  a retry (restartOrder): a definitely-failed order
 *                         re-approved, or an unknown one the merchant has no order for
 * Writers: the browser worker (from the checkout session's result, so the row is
 * right even when the agent worker died meanwhile) and shop.checkout
 * (reservation, reconciliation). Events order.changed; audit order.placed.
 */
import type { TaskErrorReason } from '@jarvis/contracts';
import { sql } from 'kysely';
import type { DbContext, Trx } from '../../db/pool';
import type { CartLineJson, OrderRow } from '../../db/types';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';

export const orderKey = (stepId: string): string => `order:${stepId}`;

export interface OrderFacts {
  taskId: string | null;
  stepId: string | null;
  siteId: string;
  merchantName: string;
  merchantHost: string;
  items: CartLineJson[];
  currency: string;
  subtotalMicro: number;
  shippingMicro: number;
  taxMicro: number | null;
  totalMicro: number;
  approvalId: string | null;
  actionHash: string;
  cartArtifactId: string | null;
}

export type OrderOutcome =
  | { kind: 'placed'; merchantOrderId: string; confirmationArtifactId: string | null }
  | { kind: 'failed'; reason: TaskErrorReason }
  | { kind: 'unknown' };

async function changed(trx: Trx, ctx: DbContext, row: OrderRow): Promise<void> {
  await appendEvent(trx, ctx, {
    taskId: row.task_id,
    type: 'order.changed',
    data: { orderId: row.id, taskId: row.task_id, status: row.status },
  });
}

/**
 * Inserts the order for `key` (status submitting) — or, when one exists, returns
 * it locked FOR UPDATE with `existing: true`. Call inside the user's RLS context.
 */
export async function reserveOrder(
  trx: Trx,
  ctx: DbContext,
  key: string,
  f: OrderFacts,
): Promise<{ row: OrderRow; existing: boolean }> {
  const inserted = await trx
    .insertInto('orders')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      task_id: f.taskId,
      step_id: f.stepId,
      site_id: f.siteId,
      merchant_name: f.merchantName.slice(0, 200),
      merchant_host: f.merchantHost.slice(0, 255),
      idempotency_key: key,
      items: JSON.stringify(f.items),
      currency: f.currency,
      subtotal_micro: f.subtotalMicro,
      shipping_micro: f.shippingMicro,
      tax_micro: f.taxMicro,
      total_micro: f.totalMicro,
      approval_id: f.approvalId,
      action_hash: f.actionHash,
      cart_artifact_id: f.cartArtifactId,
    })
    .onConflict((oc) => oc.columns(['user_id', 'idempotency_key']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) {
    await changed(trx, ctx, inserted);
    return { row: inserted, existing: false };
  }
  const row = await trx
    .selectFrom('orders')
    .selectAll()
    .where('idempotency_key', '=', key)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { row, existing: true };
}

/**
 * A retry: a definitely-failed order (re-approved), or an unknown one the merchant
 * reported no order for — back to submitting with the facts now approved.
 */
export async function restartOrder(
  trx: Trx,
  ctx: DbContext,
  row: OrderRow,
  f: OrderFacts,
): Promise<OrderRow> {
  const updated = await trx
    .updateTable('orders')
    .set({
      status: 'submitting',
      failure_reason: null,
      items: JSON.stringify(f.items),
      currency: f.currency,
      subtotal_micro: f.subtotalMicro,
      shipping_micro: f.shippingMicro,
      tax_micro: f.taxMicro,
      total_micro: f.totalMicro,
      approval_id: f.approvalId,
      action_hash: f.actionHash,
      cart_artifact_id: f.cartArtifactId,
    })
    .where('id', '=', row.id)
    .where('status', 'in', ['failed', 'unknown'])
    .returningAll()
    .executeTakeFirst();
  if (!updated) return row;
  await changed(trx, ctx, updated);
  return updated;
}

/**
 * Records what happened to the order for `key`. Idempotent: a transition that
 * no longer applies (already placed, already failed) changes nothing and the
 * current row is returned.
 */
export async function finalizeOrder(
  trx: Trx,
  ctx: DbContext,
  key: string,
  outcome: OrderOutcome,
): Promise<OrderRow | null> {
  const from: OrderRow['status'][] =
    outcome.kind === 'placed' ? ['submitting', 'unknown'] : ['submitting'];
  const set =
    outcome.kind === 'placed'
      ? {
          status: 'placed' as const,
          merchant_order_id: outcome.merchantOrderId.slice(0, 200),
          placed_at: sql<Date>`now()`,
          failure_reason: null,
          confirmation_artifact_id: outcome.confirmationArtifactId,
        }
      : outcome.kind === 'failed'
        ? { status: 'failed' as const, failure_reason: outcome.reason }
        : { status: 'unknown' as const, failure_reason: 'ORDER_UNKNOWN' };
  const updated = await trx
    .updateTable('orders')
    .set(set)
    .where('idempotency_key', '=', key)
    .where('status', 'in', from)
    .returningAll()
    .executeTakeFirst();
  if (!updated)
    return (
      (await trx
        .selectFrom('orders')
        .selectAll()
        .where('idempotency_key', '=', key)
        .executeTakeFirst()) ?? null
    );
  await changed(trx, ctx, updated);
  if (updated.status === 'placed') {
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'agent',
      actorId: ctx.userId,
      action: 'order.placed',
      targetType: 'order',
      targetId: updated.id,
      metadata: {
        siteId: updated.site_id,
        totalMicro: updated.total_micro,
        currency: updated.currency,
        taskId: updated.task_id,
      },
    });
  }
  return updated;
}

export async function orderByKey(trx: Trx, key: string): Promise<OrderRow | null> {
  return (
    (await trx
      .selectFrom('orders')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst()) ?? null
  );
}
