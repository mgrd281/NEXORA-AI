/**
 * Phase C — job handlers and timers of the integrations domain, run by the
 * agent worker (src/worker.ts). Owner: integrations engineer.
 *
 * Planned (docs/architecture/phase-c.md §3):
 *   handlers  'email.watch_poll'  { watchId }  check one watched thread for replies
 *   timers    email watch tick    email_watches_due() → email.watch_poll jobs (dedupe email-watch:<id>)
 *             revocation drain    oauth_revocations_claim/_complete/_failed → provider revoke endpoint
 *             OAuth state purge   oauth_states_purge()
 * Handlers run with the agent worker's RuntimeDeps (database, SecretBox, storage, log).
 */
import { z } from 'zod';
import type { DomainJobs, JobHandler, WorkerTimer } from '../../../jobs/domain';
import { drainRevocations, purgeOAuthStates } from '../../../integrations/revocation';
import { enqueueDueWatches, pollWatch } from '../../../integrations/watches';
import { nowOf, type RuntimeDeps } from '../../runtime';

/** Timers get the worker's dependencies without a job's lease signal. */
export type IntegrationJobDeps = RuntimeDeps;

const WatchPayload = z.object({ watchId: z.uuid() });

/** email.watch_poll { watchId }: one check of one watched thread, in its owner's RLS context. */
export const watchPollHandler: JobHandler<IntegrationJobDeps> = {
  async run(deps, job) {
    const parsed = WatchPayload.safeParse(job.payload);
    if (!parsed.success) return 'done'; // a malformed job can never succeed: drop it
    const result = await pollWatch(
      deps,
      { tenantId: job.tenant_id, userId: job.user_id },
      parsed.data.watchId,
      nowOf(deps),
    );
    if (result !== 'watching' && result !== 'skipped')
      deps.log.info('email watch finished', { watchId: parsed.data.watchId, status: result });
    return 'done';
  },
};

/** Every EMAIL_WATCH_TICK_MS: due watches → email.watch_poll jobs (dedupe email-watch:<id>). */
export const watchTick: WorkerTimer<IntegrationJobDeps> = {
  name: 'email.watch_tick',
  everyMs: (deps) => deps.config.EMAIL_WATCH_TICK_MS,
  run: (deps) => enqueueDueWatches(deps),
};

/** Every 30 s: revoke the tokens of deleted Google connections (oauth_revocations outbox). */
export const revocationDrain: WorkerTimer<IntegrationJobDeps> = {
  name: 'oauth.revocation_drain',
  everyMs: () => 30_000,
  run: (deps) => drainRevocations(deps),
};

/** Every 10 minutes: drop expired or used authorization requests. */
export const oauthStatePurge: WorkerTimer<IntegrationJobDeps> = {
  name: 'oauth.state_purge',
  everyMs: () => 600_000,
  run: (deps) => purgeOAuthStates(deps),
};

export const integrationJobs: DomainJobs<IntegrationJobDeps> = {
  handlers: { 'email.watch_poll': watchPollHandler },
  timers: [watchTick, revocationDrain, oauthStatePurge],
};
