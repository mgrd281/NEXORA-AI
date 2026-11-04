/**
 * Phase D — job handlers of the telephony domain, run by the agent worker (src/worker.ts).
 * Owner: telephony engineer (docs/architecture/phase-d.md §4.3).
 *
 *   'call.timeout'          { callId }  the call watchdog, enqueued with each attempt
 *                           (run_at = created + ring timeout + max duration + margin; dedupe
 *                           call-timeout:<callId>): a call not ended by then is ended at the
 *                           provider (POST …/Calls/{Sid}.json Status=completed) and its final
 *                           state read back (GET), so a call never outlives its approval and no
 *                           status stays stale when webhooks were missed; an attempt still
 *                           'unknown' is reconciled with the provider's call list; the provider's
 *                           price is recorded once.
 *   'call.recording_fetch'  { callId, recordingSid }  only for consented recordings: the media into
 *                           evidence storage (kind 'recording', audio/mpeg), then deleted at the
 *                           provider. When its attempts are used up the provider's copy is deleted
 *                           anyway (it never lingers at the processor).
 *   timers                  none (the watchdog is per call).
 * Handlers run in the call owner's RLS context (the job's tenant and user).
 */
import { z } from 'zod';
import { withContext } from '../../../../db/pool';
import type { DomainJobs, JobHandler } from '../../../jobs/domain';
import { reconcile, readAttempt, settlePrice } from '../../../telephony/attempts';
import { finalizeCall, lockCall, onBehalfOf } from '../../../telephony/calls';
import { createTelephonyGateway } from '../../../telephony/gateway';
import { fetchCallRecording } from '../../../telephony/recordings';
import type { RuntimeDeps } from '../../runtime';

export type TelephonyJobDeps = RuntimeDeps;

const TimeoutPayload = z.object({ callId: z.uuid() });
const RecordingPayload = z.object({
  callId: z.uuid(),
  recordingSid: z.string().regex(/^RE[0-9a-f]{32}$/),
});

/** call.timeout: end an overdue call, reconcile an unknown one, record the price. */
export const callTimeoutHandler: JobHandler<TelephonyJobDeps> = {
  async run(deps, job) {
    const p = TimeoutPayload.safeParse(job.payload);
    if (!p.success) return 'done';
    const ctx = { tenantId: job.tenant_id, userId: job.user_id };
    const gw = createTelephonyGateway(deps.config);
    let row = await withContext(deps.db, ctx, (trx) =>
      trx
        .selectFrom('call_sessions')
        .selectAll()
        .where('id', '=', p.data.callId)
        .executeTakeFirst(),
    );
    if (!row) return 'done';
    if (!gw) {
      // Telephony was switched off meanwhile: nothing can be asked; close what cannot run.
      if (row.status !== 'ended')
        await withContext(deps.db, ctx, async (trx) => {
          const r = (await lockCall(trx, row!.id))!;
          await finalizeCall(trx, ctx, r, await onBehalfOf(trx, r), {
            providerStatus: r.ai_disclosed_at ? 'completed' : 'canceled',
            durationSeconds: null,
            cancelledByJarvis: true,
          });
        });
      return 'done';
    }
    if (row.status !== 'ended') {
      if (row.provider_call_sid && row.status !== 'unknown') {
        // Overdue: end it at the provider (the call's TimeLimit is the second bound).
        await gw.updateCall(row.provider_call_sid, { status: 'completed' }).catch(() => undefined);
      }
      row = await reconcile(deps.db, ctx, gw, row);
      if (row.status !== 'ended' && row.provider_call_sid) {
        // The provider did not report it ended yet: JARVIS ended it (completed by the update).
        await withContext(deps.db, ctx, async (trx) => {
          const r = (await lockCall(trx, row!.id))!;
          await finalizeCall(trx, ctx, r, await onBehalfOf(trx, r), {
            providerStatus: r.ai_disclosed_at ? 'completed' : 'canceled',
            durationSeconds: null,
            cancelledByJarvis: !r.ai_disclosed_at,
          });
        });
        row = await readAttempt(deps.db, ctx, row.id);
      }
      if (row.status === 'unknown')
        throw new Error('the provider state of the call is still unknown');
    }
    await settlePrice(deps.db, ctx, gw, row);
    return 'done';
  },
};

/** call.recording_fetch: copy a consented recording into evidence storage, delete it at the provider. */
export const recordingFetchHandler: JobHandler<TelephonyJobDeps> = {
  async run(deps, job) {
    const p = RecordingPayload.safeParse(job.payload);
    if (!p.success) return 'done';
    const gw = createTelephonyGateway(deps.config);
    if (!gw) return 'done';
    const result = await fetchCallRecording(
      deps,
      { tenantId: job.tenant_id, userId: job.user_id },
      gw,
      p.data.callId,
      p.data.recordingSid,
    );
    deps.log.info('call recording', { callId: p.data.callId, result });
    return 'done';
  },
  async onDead(deps, job) {
    // Never leave a recording at the processor: delete the provider's copy.
    const p = RecordingPayload.safeParse(job.payload);
    const gw = createTelephonyGateway(deps.config);
    if (!p.success || !gw) return;
    await gw.deleteRecording(p.data.recordingSid).catch((err) =>
      deps.log.warn('call recording: could not delete the provider copy', {
        callId: p.data.callId,
        error: String(err),
      }),
    );
  },
};

export const telephonyJobs: DomainJobs<TelephonyJobDeps> = {
  handlers: {
    'call.timeout': callTimeoutHandler,
    'call.recording_fetch': recordingFetchHandler,
  },
  timers: [],
};
