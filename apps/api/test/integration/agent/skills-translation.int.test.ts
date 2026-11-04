/**
 * Skills runtime and translation end to end:
 *  - SkillService.list reports real availability; setEnabled writes the
 *    preference (personal-memory: memory.enabled), audits, refuses planned and
 *    core skills; a disabled skill's tools are denied (SKILL_DISABLED) and
 *    hidden from the model planner.
 *  - text.translate through the scripted model (structured output, untrusted
 *    framing, tiering, verification of numbers and links), and the offline
 *    planner's honest PLANNER_UNSUPPORTED / OFFLINE_UNSUPPORTED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { AppError } from '../../../src/lib/errors';
import { resolvePreferences } from '../../../src/modules/account/me';
import { ScriptedModel } from '../../fixtures/scripted-model';
import {
  auditMetadata,
  connectWeb,
  createHarness,
  detail,
  drain,
  newUser,
  type Harness,
} from './harness';

let h: Harness;
const model = new ScriptedModel();
let hm: Harness;
beforeAll(async () => {
  h = await createHarness();
  hm = await createHarness({ adapter: model, env: { ANTHROPIC_API_KEY: 'sk-test-scripted' } });
});
afterAll(async () => {
  await h.close();
  await hm.close();
});

describe('skills', () => {
  it('lists every skill with its real availability', async () => {
    const user = await newUser(h.db);
    await connectWeb(h.db, user);
    const skills = await h.services.skills.list(user);
    expect(skills).toHaveLength(12);
    const by = Object.fromEntries(skills.map((s) => [s.id, s]));
    expect(by['web-research']).toMatchObject({
      status: 'implemented',
      available: true,
      canToggle: true,
    });
    expect(by['email-management']).toMatchObject({
      status: 'needs_connection',
      unavailableReason: 'CONNECTION_REQUIRED',
    });
    expect(by['translation']).toMatchObject({
      available: false,
      unavailableReason: 'MODEL_REQUIRED',
    });
    expect(by['document-analysis']).toMatchObject({ available: true });
    expect(by['device-automation']).toMatchObject({
      status: 'planned',
      unavailableReason: 'PLANNED',
      tools: [],
    });
    // Phase D: phone.call is built; without a telephony gateway on this server it cannot run.
    expect(by['phone-calling']).toMatchObject({
      status: 'implemented',
      available: false,
      unavailableReason: 'TELEPHONY_NOT_CONFIGURED',
      tools: ['phone.call'],
    });
    expect(by['workflow-planning']).toMatchObject({ canToggle: false, available: true });
  });

  it('a disabled skill denies its tools (SKILL_DISABLED); switching it back on works again', async () => {
    const user = await newUser(h.db);
    await connectWeb(h.db, user);
    const off = await h.services.skills.setEnabled(user, 'web-research', false);
    expect(off).toMatchObject({
      enabled: false,
      available: false,
      unavailableReason: 'DISABLED_BY_USER',
    });
    const prefs = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('users')
        .select('preferences')
        .where('id', '=', user.userId)
        .executeTakeFirstOrThrow(),
    );
    expect(resolvePreferences(prefs.preferences).skills.disabled).toEqual(['web-research']);
    expect(await auditMetadata(user.userId, 'skill.toggled')).toEqual([
      { skill: 'web-research', enabled: false },
    ]);

    const s = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/article')}`, source: 'text' },
      {},
    );
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({
      code: 'POLICY_DENIED',
      reason: 'SKILL_DISABLED',
      params: { skill: 'web-research' },
    });
    expect(d.steps[0]).toMatchObject({
      status: 'BLOCKED',
      policy: { decision: 'deny', reasons: ['SKILL_DISABLED'] },
    });
    expect(h.site.hits.filter((p) => p === '/article')).toHaveLength(0); // nothing was fetched

    await h.services.skills.setEnabled(user, 'web-research', true);
    const again = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/article')}`, source: 'text' },
      {},
    );
    await drain(h.worker);
    expect((await detail(h.db, user, again.id)).status).toBe('COMPLETED');
  });

  it('personal-memory mirrors memory.enabled; planned and core skills cannot be switched', async () => {
    const user = await newUser(h.db);
    const mem = await h.services.skills.setEnabled(user, 'personal-memory', false);
    expect(mem).toMatchObject({ enabled: false, unavailableReason: 'MEMORY_DISABLED' });
    const me = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('users')
        .select('preferences')
        .where('id', '=', user.userId)
        .executeTakeFirstOrThrow(),
    );
    expect(resolvePreferences(me.preferences).memory.enabled).toBe(false);
    const s = await h.services.tasks.create(
      user,
      { request: 'remember that I like tea', source: 'text' },
      {},
    );
    await drain(h.worker);
    expect((await detail(h.db, user, s.id)).error).toMatchObject({ reason: 'MEMORY_DISABLED' });

    for (const [id, reason] of [
      ['device-automation', 'SKILL_PLANNED'],
      ['workflow-planning', 'SKILL_NOT_TOGGLEABLE'],
    ] as const) {
      const err = await h.services.skills.setEnabled(user, id, false).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_STATE');
      expect((err as AppError).details).toEqual({ reason });
    }
  });

  it('the model planner is not offered the tools of a disabled skill', async () => {
    const user = await newUser(hm.db);
    await hm.services.skills.setEnabled(user, 'translation', false);
    model.calls.length = 0;
    model.script = {
      object: () => ({
        title: 'Hi',
        objective: 'Answer.',
        steps: [
          {
            key: 's1',
            toolId: 'assistant.answer',
            title: 'Answer',
            input: { question: 'Hi', language: 'en' },
          },
        ],
      }),
      text: () => 'Hello!',
    };
    await hm.services.tasks.create(user, { request: 'Hi', source: 'text' }, {});
    await drain(hm.worker);
    expect(model.calls[0]!.system).not.toContain('### text.translate');
    expect(model.calls[0]!.system).toContain('### assistant.answer');
  });
});

describe('translation', () => {
  it('translates through the model with structured output and verifies numbers and links', async () => {
    const user = await newUser(hm.db);
    const source = 'The meeting moves to 14:30 on 3 June; details at https://example.com/m.';
    model.calls.length = 0;
    model.script = {
      object: (req) => {
        if (req.purpose === 'planning')
          return {
            title: 'Translate the note',
            objective: 'Translate into German.',
            steps: [
              {
                key: 's1',
                toolId: 'text.translate',
                title: 'Translate',
                input: { text: source, target: 'de', formality: 'informal' },
              },
            ],
          };
        expect(req.purpose).toBe('translate');
        return {
          translation:
            'Das Treffen wird auf den 3. Juni um 14:30 verschoben; Details unter https://example.com/m.',
          detectedSource: 'en',
        };
      },
      text: () => 'Translated into German.',
    };
    const s = await hm.services.tasks.create(
      user,
      { request: `Translate into German: ${source}`, source: 'text' },
      {},
    );
    await drain(hm.worker);
    const d = await detail(hm.db, user, s.id);
    expect(d.status).toBe('COMPLETED');
    expect(d.outcome).toBe('answer');
    expect(d.steps[0]!.output).toMatchObject({ detectedSource: 'en', target: 'de' });
    const call = model.calls.find((c) => c.purpose === 'translate')!;
    expect(call.model).toBe('claude-haiku-5-5');
    expect(call.system).toContain('untrusted data');
    expect(call.user).toContain(`<source_text>\n${source}\n</source_text>`);
    expect(call.user).toContain('Register: informal.');
    const events = d.events.filter((e) => e.type === 'verification.passed');
    const checks = (events[0]!.data.checks as { key: string }[]).map((c) => c.key);
    expect(checks).toEqual(['translationLength', 'numbersPreserved', 'translationLanguage']);
    const answer = await withContext(hm.db, user, (trx) =>
      trx
        .selectFrom('messages')
        .select(['kind', 'content'])
        .where('task_id', '=', s.id)
        .where('role', '=', 'assistant')
        .executeTakeFirstOrThrow(),
    );
    expect(answer).toEqual({
      kind: 'answer',
      content:
        'Das Treffen wird auf den 3. Juni um 14:30 verschoben; Details unter https://example.com/m.',
    });
  });

  it('fails verification when the model drops a number, and refuses an unknown language', async () => {
    const user = await newUser(hm.db);
    model.script = {
      object: (req) =>
        req.purpose === 'planning'
          ? {
              title: 'Translate',
              objective: 'Translate.',
              steps: [
                {
                  key: 's1',
                  toolId: 'text.translate',
                  title: 'Translate',
                  input: { text: 'Call me at 555 0199.', target: 'de' },
                },
              ],
            }
          : { translation: 'Ruf mich an.', detectedSource: 'en' },
    };
    const s = await hm.services.tasks.create(
      user,
      { request: 'Translate to German: Call me at 555 0199.', source: 'text' },
      {},
    );
    await drain(hm.worker);
    expect((await detail(hm.db, user, s.id)).error).toMatchObject({ code: 'VERIFICATION_FAILED' });

    model.script = {
      object: () => ({
        title: 'Translate',
        objective: 'Translate.',
        steps: [
          {
            key: 's1',
            toolId: 'text.translate',
            title: 'Translate',
            input: { text: 'Hello', target: 'qq-ZZ-nope' },
          },
        ],
      }),
    };
    const bad = await hm.services.tasks.create(
      user,
      { request: 'Translate hello', source: 'text' },
      {},
    );
    await drain(hm.worker);
    // The planner's target fails validation twice: an honest planning error, nothing translated.
    expect((await detail(hm.db, user, bad.id)).error).toMatchObject({
      code: 'MODEL_ERROR',
      reason: 'INVALID_PLAN',
    });
  });

  it('offline: translation is honestly unsupported (no model, no fake translation)', async () => {
    const user = await newUser(h.db);
    const s = await h.services.tasks.create(
      user,
      { request: 'Übersetze „Guten Morgen“ ins Englische', source: 'text' },
      {},
    );
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({
      code: 'PLANNER_UNSUPPORTED',
      reason: 'OFFLINE_UNSUPPORTED',
      retryable: false,
    });
    expect(d.steps).toEqual([]);
    const skills = await h.services.skills.list(user);
    expect(skills.find((x) => x.id === 'translation')).toMatchObject({
      available: false,
      unavailableReason: 'MODEL_REQUIRED',
    });
    expect((await h.services.status.get(user)).capabilities.translation).toBe(false);
  });
});
