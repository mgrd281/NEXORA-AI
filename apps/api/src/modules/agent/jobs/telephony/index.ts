/**
 * Phase D — job handlers and timers of the telephony domain, run by the agent worker
 * (src/worker.ts). Owner: telephony engineer (docs/architecture/phase-d.md §4.3).
 *
 * Planned:
 *   handlers  'call.timeout'          { callId }  the call watchdog, enqueued when a call is
 *                                     created (run_at = created + ring timeout + max duration +
 *                                     margin; dedupe call-timeout:<callId>): a call still not
 *                                     ended is completed at the provider (POST …/Calls/{Sid}.json
 *                                     Status=completed) and its final state read back (GET),
 *                                     so a call never outlives its approval and no status stays
 *                                     stale when webhooks were missed; an attempt still 'unknown'
 *                                     is reconciled with the provider's call list.
 *             'call.recording_fetch'  { callId, recordingSid }  only for consented recordings:
 *                                     download the media into evidence storage (kind 'recording',
 *                                     audio/mpeg), then delete it at the provider.
 *   timers    none required (the watchdog is per call).
 * Handlers run with the agent worker's RuntimeDeps (database, SecretBox, storage, log).
 */
import type { DomainJobs } from '../../../jobs/domain';
import type { RuntimeDeps } from '../../runtime';

export type TelephonyJobDeps = RuntimeDeps;

export const telephonyJobs: DomainJobs<TelephonyJobDeps> = {
  handlers: {},
  timers: [],
};
