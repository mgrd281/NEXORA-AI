/**
 * Browser tools under the model planner (scripted model — no API key needed):
 * a form submission asks with every field and is sent once; a plan that
 * writes a slot out instead of referencing the live read (invented
 * availability) is refused before anything runs; a page on a site no recipe
 * supports is SITE_UNSUPPORTED without a browser session.
 */
import type { ApprovalDetails } from '@jarvis/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type DbContext } from '../../../src/db/pool';
import { ScriptedModel } from '../../fixtures/scripted-model';
import { connectWeb, detail, drain, newUser } from '../agent/harness';
import { createBrowserHarness, sessionsOf, type BrowserHarness } from './harness';

const model = new ScriptedModel();
let h: BrowserHarness;

beforeAll(async () => {
  h = await createBrowserHarness({
    adapter: model,
    env: { ANTHROPIC_API_KEY: 'sk-test-scripted' },
  });
}, 60_000);
afterAll(() => h.close());

async function user() {
  const u = await newUser(h.db);
  await connectWeb(h.db, u);
  return u;
}

async function run(u: DbContext, request: string, plan: unknown) {
  model.script = { object: () => plan, text: () => 'Done.' };
  const s = await h.services.tasks.create(u, { request, source: 'text' }, {});
  await drain(h.worker);
  return detail(h.db, u, s.id);
}

describe('browser tools planned by a model', () => {
  it('browser.fill asks with every field (form_submission, MEDIUM) and sends the form once', async () => {
    const u = await user();
    const waiting = await run(
      u,
      'Ask Fixture Dental via their contact form whether they open on Saturdays. I am Alex, alex@example.test',
      {
        title: 'Ask Fixture Dental',
        objective: 'Send the question through the contact form.',
        steps: [
          {
            key: 's1',
            toolId: 'browser.fill',
            title: 'Send the contact form',
            input: {
              siteId: 'fixture-booking',
              form: 'contact',
              fields: {
                Message: 'Do you open on Saturdays?',
                Email: 'alex@example.test',
                Name: 'Alex',
              },
            },
          },
        ],
      },
    );
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const a = await withContext(h.db, u, (trx) =>
      trx
        .selectFrom('approvals')
        .selectAll()
        .where('task_id', '=', waiting.id)
        .executeTakeFirstOrThrow(),
    );
    expect(a.risk_level).toBe('MEDIUM');
    expect(a.details).toEqual({
      kind: 'form_submission',
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      // The host the recipe really loads on this server (ApprovalContext.siteHost), not a label.
      siteHost: new URL(h.fixture.origin).host,
      form: 'contact',
      fields: [
        { label: 'Name', value: 'Alex', personal: true },
        { label: 'Email', value: 'alex@example.test', personal: true },
        { label: 'Message', value: 'Do you open on Saturdays?', personal: false },
      ],
      binding: false,
      evidenceArtifactId: null,
    } satisfies ApprovalDetails);
    await h.services.approvals.decide(
      u,
      a.id,
      { decision: 'approve', actionHash: a.action_hash },
      'web',
    );
    await drain(h.worker);
    const done = await detail(h.db, u, waiting.id);
    expect(done.status).toBe('COMPLETED');
    const site = (await h.fixture.admin('/booking/admin/reservations', 'GET')) as {
      contacts: { message: string; key: string }[];
    };
    expect(site.contacts.filter((c) => c.key === `form:${done.steps[0]!.id}`)).toEqual([
      expect.objectContaining({ message: 'Do you open on Saturdays?' }),
    ]);
  });

  it('a slot written out by the planner (not read from the site) is refused before anything runs', async () => {
    const u = await user();
    const invented = {
      title: 'Book a check-up',
      objective: 'Book it.',
      steps: [
        {
          key: 's1',
          toolId: 'booking.book',
          title: 'Book',
          input: {
            siteId: 'fixture-booking',
            slot: {
              sessionId: '00000000-0000-4000-8000-000000000000',
              siteId: 'fixture-booking',
              siteName: 'Fixture Dental',
              siteHost: 'fixture',
              serviceId: 'checkup',
              service: 'Check-up',
              slot: {
                id: 'checkup-20990101-0900',
                start: '2099-01-01T08:00:00.000Z',
                end: null,
                timeZone: 'Europe/Berlin',
                service: 'Check-up',
                price: null,
              },
              binding: false,
              cancellationTerms: null,
              requiredFields: [],
              evidenceArtifactId: null,
            },
            details: { 'Full name': 'Alex Example', Email: 'alex@example.test' },
          },
        },
      ],
    };
    const d = await run(u, 'Book me a check-up at Fixture Dental', invented);
    expect(d.status).toBe('FAILED');
    expect(d.error?.reason).toBe('INVALID_PLAN');
    expect(await sessionsOf(h, u, d.id)).toEqual([]);
  });

  it('browser.read on a site no recipe supports fails with SITE_UNSUPPORTED, no session started', async () => {
    const u = await user();
    const d = await run(u, 'Read https://unsupported.example/ with the browser', {
      title: 'Read the page',
      objective: 'Read it.',
      steps: [
        {
          key: 's1',
          toolId: 'browser.read',
          title: 'Read',
          input: { siteId: 'schema-org', url: 'https://unsupported.example/' },
        },
      ],
    });
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'SITE_UNSUPPORTED',
      params: { host: 'unsupported.example' },
    });
    expect(await sessionsOf(h, u, d.id)).toEqual([]);
  });
});
