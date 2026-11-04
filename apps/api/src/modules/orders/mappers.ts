/**
 * Order rows → contract (docs/architecture/phase-c.md §3.6, §4.5). Shared by
 * the orders routes and the account export. Idempotency keys, action hashes
 * and approval ids are internal (the approval itself is on the task).
 */
import { TaskErrorReason, type EvidenceArtifact, type Order } from '@jarvis/contracts';
import type { OrderRow } from '../../db/types';

export const ORDER_COLUMNS = [
  'id',
  'task_id',
  'site_id',
  'merchant_name',
  'merchant_host',
  'status',
  'items',
  'currency',
  'subtotal_micro',
  'shipping_micro',
  'tax_micro',
  'total_micro',
  'merchant_order_id',
  'placed_at',
  'failure_reason',
  'cart_artifact_id',
  'confirmation_artifact_id',
  'created_at',
  'updated_at',
] as const;

export type OrderView = Pick<OrderRow, (typeof ORDER_COLUMNS)[number]>;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** A stored failure reason as the contract's TaskErrorReason (null if a newer server wrote another). */
export function failureReasonOf(raw: string | null): TaskErrorReason | null {
  if (raw === null) return null;
  const parsed = TaskErrorReason.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The evidence files of an order, in display order: the cart, then the confirmation. */
export const orderEvidenceIds = (r: OrderView): (string | null)[] => [
  r.cart_artifact_id,
  r.confirmation_artifact_id,
];

export function toOrder(r: OrderView, evidence: readonly EvidenceArtifact[]): Order {
  // bigint columns arrive as strings from pg; every amount fits a JS number (< 2^53 micro-units).
  const money = (amount: number | string) => ({
    amountMicro: Number(amount),
    currency: r.currency,
  });
  return {
    id: r.id,
    taskId: r.task_id,
    siteId: r.site_id,
    merchantName: r.merchant_name,
    merchantHost: r.merchant_host,
    status: r.status,
    items: r.items.map((l) => ({
      title: l.title,
      quantity: l.quantity,
      unitPrice: { amountMicro: Number(l.unitPrice.amountMicro), currency: l.unitPrice.currency },
      lineTotal: { amountMicro: Number(l.lineTotal.amountMicro), currency: l.lineTotal.currency },
      productUrl: l.productUrl,
    })),
    subtotal: money(r.subtotal_micro),
    shipping: money(r.shipping_micro),
    tax: r.tax_micro === null ? null : money(r.tax_micro),
    total: money(r.total_micro),
    merchantOrderId: r.merchant_order_id,
    placedAt: iso(r.placed_at),
    failureReason: failureReasonOf(r.failure_reason),
    evidence: [...evidence],
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
