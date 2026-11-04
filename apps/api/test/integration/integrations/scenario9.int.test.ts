/**
 * Scenario 9 — expired OAuth credentials, end to end (real Postgres + mock
 * Google): the grant dies mid-task → the step fails with CONNECTION_EXPIRED
 * (retryable, nothing was done), the connection flips to 'expired' with one
 * notification; reconnecting returns the task as resumable; Retry completes.
 * And the planning-time path: a step that needs an already expired
 * connection is denied before anything runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { asOwner, detail, drain } from '../agent/harness';
import {
  connect,
  createIntegrationsHarness,
  newUserWithMailbox,
  type IntegrationsHarness,
} from './harness';

let h: IntegrationsHarness;
beforeAll(async () => {
  h = await createIntegrationsHarness();
});
afterAll(() => h.close());

const notificationsOf = (user: { tenantId: string; userId: string }) =>
  withContext(h.db, user, (trx) =>
    trx.selectFrom('notifications').selectAll().where('kind', '=', 'connection_expired').execute(),
  );

describe('scenario 9: expired OAuth credentials', () => {
  it('fails the step with CONNECTION_EXPIRED, notifies once, and resumes after reconnecting', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read']);
    h.google.addMessage(user.mailbox, {
      from: 'Anna <anna@example.org>',
      subject: 'Board meeting',
      body: 'The board meeting moved to Thursday afternoon. Please confirm that you can attend.',
    });
    // The user revoked JARVIS at Google; the stored access token is about to expire.
    h.google.revokeGrants(user.mailbox);
    await asOwner(
      `UPDATE connections SET token_expires_at = now() + interval '30 seconds' WHERE id = $1`,
      [connection.id],
    );

    const t = await h.services.tasks.create(
      user,
      { request: 'Summarize my unread emails', source: 'text' },
      {},
    );
    await drain(h.worker);
    const failed = await detail(h.db, user, t.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({
      code: 'CONNECTION_REQUIRED',
      reason: 'CONNECTION_EXPIRED',
      params: { provider: 'google' },
      retryable: true,
    });
    expect(failed.steps[0]).toMatchObject({ toolId: 'email.search', status: 'FAILED' });
    expect(failed.canRetry).toBe(true);
    const conn = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('connections')
        .selectAll()
        .where('id', '=', connection.id)
        .executeTakeFirstOrThrow(),
    );
    expect(conn).toMatchObject({ status: 'expired', status_reason: 'GRANT_INVALID' });
    expect(await notificationsOf(user)).toHaveLength(1);

    // A second task while expired is denied at planning (nothing runs), and does not notify again.
    const t2 = await h.services.tasks.create(
      user,
      { request: 'What needs my reply?', source: 'text' },
      {},
    );
    await drain(h.worker);
    const denied = await detail(h.db, user, t2.id);
    expect(denied.status).toBe('FAILED');
    expect(denied.error).toMatchObject({
      code: 'CONNECTION_REQUIRED',
      reason: 'CONNECTION_EXPIRED',
      params: { provider: 'google' },
    });
    expect(denied.steps[0]).toMatchObject({ status: 'BLOCKED' });
    expect(denied.steps[0]!.policy.reasons).toContain('CONNECTION_EXPIRED');
    expect(await notificationsOf(user)).toHaveLength(1);

    // Reconnect (the same account) from the task: both failed tasks are offered for a retry.
    const reconnected = await connect(h, user, 'google', ['mail.read'], {
      connectionId: connection.id,
      returnTo: `/tasks/${t.id}`,
    });
    expect(reconnected.connection).toMatchObject({
      id: connection.id,
      status: 'active',
      statusReason: null,
    });
    expect(reconnected.returnTo).toBe(`/tasks/${t.id}`);
    expect(reconnected.resumableTaskIds).toEqual([t2.id, t.id]);
    const events = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_events')
        .select('data')
        .where('type', '=', 'connection.changed')
        .execute(),
    );
    expect(events.map((e) => (e.data as { change?: string }).change)).toEqual(
      expect.arrayContaining(['created', 'expired', 'reconnected']),
    );

    await h.services.tasks.retry(user, t.id, { acknowledgeUnknownOutcome: false });
    await h.services.tasks.retry(user, t2.id, { acknowledgeUnknownOutcome: false });
    await drain(h.worker);
    const done = await detail(h.db, user, t.id);
    expect(done.status).toBe('COMPLETED');
    expect(String(done.steps[2]!.output?.summary ?? '')).toContain('board meeting');
    expect((await detail(h.db, user, t2.id)).status).toBe('COMPLETED');
  });
});
