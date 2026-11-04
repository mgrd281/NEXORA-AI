/**
 * Approval decisions. The approval must be visible (RLS → else NOT_FOUND),
 * PENDING (else INVALID_STATE), unexpired (else it is marked EXPIRED and
 * APPROVAL_EXPIRED is returned) and the submitted actionHash must equal the
 * stored hash of exactly what was shown (else APPROVAL_MISMATCH).
 *
 * Lock order: the task row, then the approval row — the order cancel, the
 * executor and the approval.expire job use too. The opposite order deadlocks
 * with a concurrent cancel (Postgres aborts one transaction with 40P01).
 *
 * Phase B: a decision emits the approval.decided webhook (ids and status only)
 * in the same transaction.
 */
import type { Approval, ApprovalDecisionRequest, Platform } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import { safeEqual } from '../../lib/crypto';
import { AppError, invalidState, notFound } from '../../lib/errors';
import type { ApprovalService } from '../../services';
import { expireApproval } from '../agent/approval-flow';
import { asLocale, asMessage, msg, render } from '../agent/i18n';
import type { AgentDeps } from '../agent/index';
import { cancelOpenSteps, lockTask, transitionTask } from '../agent/task-state';
import { emitApprovalWebhook } from '../agent/webhook-events';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { enqueue } from '../jobs/queue';
import { approvalQuery, toApproval } from '../tasks/mappers';

export function createApprovalService(deps: AgentDeps): ApprovalService {
  const { db } = deps;

  async function decide(
    ctx: DbContext,
    approvalId: string,
    input: ApprovalDecisionRequest,
    channel: Platform,
  ): Promise<Approval> {
    const outcome = await withContext(db, ctx, async (trx) => {
      const ref = await trx
        .selectFrom('approvals')
        .select('task_id')
        .where('id', '=', approvalId)
        .executeTakeFirst();
      if (!ref) throw notFound('Approval');
      const task = await lockTask(trx, ref.task_id);
      // Locked after the task, then re-read: a concurrent cancel or expiry may have closed it.
      const approval = await trx
        .selectFrom('approvals')
        .selectAll()
        .where('id', '=', approvalId)
        .forUpdate()
        .executeTakeFirst();
      if (!approval) throw notFound('Approval');
      if (approval.status !== 'PENDING')
        throw invalidState(`This request was already ${approval.status.toLowerCase()}.`);
      if (new Date(approval.expires_at).getTime() <= Date.now()) {
        await expireApproval(trx, ctx, approval, 'user');
        return 'expired' as const;
      }
      if (!safeEqual(approval.action_hash, input.actionHash)) {
        throw new AppError(
          'APPROVAL_MISMATCH',
          'This action is not the one you reviewed. Open it again to see exactly what will happen.',
        );
      }
      if (task.status !== 'AWAITING_APPROVAL')
        throw invalidState('This task is not waiting for an approval.');
      const decidedAt = new Date();
      const note = input.note?.trim() ? input.note.trim() : null;

      if (input.decision === 'approve') {
        const approved = await trx
          .updateTable('approvals')
          .set({
            status: 'APPROVED',
            decided_at: decidedAt,
            decision_note: note,
            decision_channel: channel,
          })
          .where('id', '=', approval.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await emitApprovalWebhook(trx, ctx, 'approval.decided', approved);
        await trx
          .updateTable('task_steps')
          .set({ status: 'PENDING' })
          .where('id', '=', approval.step_id)
          .where('status', '=', 'AWAITING_APPROVAL')
          .execute();
        await appendEvent(trx, ctx, {
          taskId: task.id,
          type: 'approval.decided',
          data: { approvalId: approval.id, decision: 'approved' },
        });
        await transitionTask(trx, ctx, task, 'RUNNING');
        await enqueue(trx, {
          kind: 'task.execute',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          taskId: task.id,
          dedupeKey: `exec:${task.id}`,
        });
      } else {
        const rejected = await trx
          .updateTable('approvals')
          .set({
            status: 'REJECTED',
            decided_at: decidedAt,
            decision_note: note,
            decision_channel: channel,
          })
          .where('id', '=', approval.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await emitApprovalWebhook(trx, ctx, 'approval.decided', rejected);
        await trx
          .updateTable('task_steps')
          .set({ status: 'CANCELLED', completed_at: decidedAt })
          .where('id', '=', approval.step_id)
          .execute();
        await cancelOpenSteps(trx, task.id);
        await appendEvent(trx, ctx, {
          taskId: task.id,
          type: 'approval.decided',
          data: { approvalId: approval.id, decision: 'rejected' },
        });
        const action = asMessage(approval.summary_message);
        const result = action ? msg('result.declined', { action }) : null;
        await transitionTask(trx, ctx, task, 'CANCELLED', {
          result_summary: result
            ? render(asLocale(task.language), result)
            : // An approval from before summaries were messages: its stored sentence.
              render(asLocale(task.language), msg('result.declined', { action: approval.summary })),
          result_summary_message: result ? JSON.stringify(result) : null,
        });
      }
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: input.decision === 'approve' ? 'approval.approved' : 'approval.rejected',
        targetType: 'approval',
        targetId: approval.id,
        metadata: {
          taskId: task.id,
          toolId: approval.tool_id,
          riskLevel: approval.risk_level,
          channel,
          withNote: note !== null,
        },
      });
      return 'decided' as const;
    });

    if (outcome === 'expired') {
      throw new AppError(
        'APPROVAL_EXPIRED',
        'This approval request has expired. Retry the task to ask again.',
      );
    }
    return withContext(db, ctx, async (trx) => {
      const row = await approvalQuery(trx).where('a.id', '=', approvalId).executeTakeFirst();
      if (!row) throw notFound('Approval');
      return toApproval(row);
    });
  }

  return { decide };
}
