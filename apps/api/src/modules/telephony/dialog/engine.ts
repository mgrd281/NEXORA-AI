/**
 * The call dialog engine (docs/architecture/phase-d.md §3.2, §4.5): runs in the API process on
 * the provider's webhooks and decides JARVIS's next lines. nextTurn = the scripted decision
 * (offline.ts, deterministic), and — only for calls approved with dialog 'model', while the
 * user's model route is available — the model's structured decision where the script asks for
 * it, passed through the guard (guard.ts). Model usage is returned for metering under the
 * user's budget. Rendering the decision as TwiML lives here as well.
 */
import { CALL_LIMITS } from '@jarvis/contracts';
import { withContext, type Db, type DbContext } from '../../../db/pool';
import type { Config } from '../../../config';
import type { CallSessionRow } from '../../../db/types';
import { checkDestination } from '../../../lib/phone';
import { loadAgentContext } from '../../agent/context';
import type { ModelAdapter, ModelUsage } from '../../agent/models/adapter';
import { loadTurns, onBehalfOf } from '../calls';
import type { TelephonyGateway } from '../gateway';
import * as twiml from '../twilio/twiml';
import { guardDecision } from './guard';
import { modelDecision } from './model';
import { decide, type CalleeUtterance, type DialogDecision, type DialogLine } from './offline';
import { LINES } from './script';
import type { ApprovedCall, TurnView } from './state';

export interface EngineDeps {
  config: Config;
  db: Db;
  modelAdapter?: ModelAdapter | null;
}

export interface TurnContext {
  turns: TurnView[];
  ownName: string;
  /** The account's own number, when it may receive this callee (approved, verified, callable). */
  transferTo: string | null;
}

/** What the engine reads about a call besides its row (in the owner's RLS context). */
export async function turnContext(
  deps: Pick<EngineDeps, 'config' | 'db'>,
  ctx: DbContext,
  session: CallSessionRow,
): Promise<TurnContext> {
  return withContext(deps.db, ctx, async (trx) => {
    const [turns, ownName, user] = await Promise.all([
      loadTurns(trx, session.id),
      onBehalfOf(trx, session),
      trx
        .selectFrom('users')
        .select(['phone_number', 'phone_verified_at'])
        .where('id', '=', session.user_id)
        .executeTakeFirst(),
    ]);
    const input = session.request as unknown as ApprovedCall;
    const t = deps.config.telephony;
    const own = user?.phone_number ?? null;
    const transferTo =
      input.allowTransfer &&
      own &&
      user?.phone_verified_at &&
      t &&
      own !== session.callee_number &&
      checkDestination(own, t.allowedCountries).ok
        ? own
        : null;
    return { turns, ownName, transferTo };
  });
}

/**
 * JARVIS's next lines for what the callee said (null: nothing recognised). Never writes: the
 * webhook stores the turns and effects in one transaction afterwards.
 */
export async function nextTurn(
  deps: EngineDeps,
  ctx: DbContext,
  session: CallSessionRow,
  callee: CalleeUtterance | null,
  tc?: TurnContext,
  now = new Date(),
): Promise<DialogDecision & { usage: ModelUsage[] }> {
  const c = tc ?? (await turnContext(deps, ctx, session));
  const input = session.request as unknown as ApprovedCall;
  const base = {
    input,
    ownName: c.ownName,
    turns: c.turns,
    recordingConsent: session.recording_consent,
    now,
    answeredAt: session.answered_at ? new Date(session.answered_at) : null,
    maxDurationSeconds: session.max_duration_seconds,
    canTransfer: c.transferTo !== null,
  };
  const scripted = decide(base, callee);
  if (!scripted.askModel || !callee || session.dialog_mode !== 'model' || !deps.modelAdapter)
    return { ...scripted, usage: [] };
  // The user's route decides (no key, external models off, budget used up → scripted).
  const route = await withContext(deps.db, ctx, (trx) =>
    loadAgentContext(trx, deps.config, ctx.userId).then((a) => a.route),
  );
  if (route.mode !== 'model') return { ...scripted, usage: [] };
  const { decision, usage } = await modelDecision(
    deps.modelAdapter,
    deps.config,
    input,
    c.turns,
    callee.text,
  );
  if (!decision) return { ...scripted, usage };
  const reask = scripted.lines
    .filter((l) => l.kind === 'question' || l.kind === 'consent_request')
    .slice(-1);
  const guarded = guardDecision(
    decision,
    {
      input,
      ownName: c.ownName,
      turns: c.turns,
      calleeText: callee.text,
      canTransfer: c.transferTo !== null,
      reask,
    },
    scripted,
  );
  return { ...(guarded ?? scripted), askModel: undefined, usage };
}

/* ------------------------------------------------------------------ */
/* TwiML                                                               */
/* ------------------------------------------------------------------ */

export interface RenderContext {
  gateway: TelephonyGateway;
  session: CallSessionRow;
  token: string;
  /** The sequence the callee's next answer will have (the gather URL's n). */
  nextSequence: number;
  transferTo: string | null;
}

/** The decision as TwiML: statements, then the question inside a speech <Gather>, a <Dial> or <Hangup>. */
export function render(
  lines: readonly DialogLine[],
  next: DialogDecision['next'],
  r: RenderContext,
): string {
  const lang = r.session.language;
  const say = (l: DialogLine) => twiml.say(l.text, lang);
  if (next === 'hangup') return twiml.response(...lines.map(say), twiml.hangup());
  if (next === 'transfer' && r.transferTo) {
    const remaining = Math.max(
      30,
      r.session.max_duration_seconds -
        (r.session.answered_at
          ? Math.round((Date.now() - new Date(r.session.answered_at).getTime()) / 1000)
          : 0),
    );
    return twiml.response(
      ...lines.map(say),
      twiml.dial({
        number: r.transferTo,
        callerId: r.gateway.callerId,
        timeoutSeconds: CALL_LIMITS.transferRingSeconds,
        timeLimitSeconds: remaining,
        action: r.gateway.webhookUrl('twilioCallDial', r.session.id, r.token),
        whisperUrl: r.gateway.webhookUrl('twilioCallWhisper', r.session.id, r.token),
      }),
    );
  }
  const before = lines.slice(0, -1);
  const last = lines.at(-1);
  return twiml.response(
    ...before.map(say),
    twiml.gather({
      action: r.gateway.webhookUrl('twilioCallGather', r.session.id, r.token, {
        n: r.nextSequence,
      }),
      language: lang,
      prompt: last ? [last.text] : [],
    }),
  );
}

/**
 * What JARVIS said in answer to turn `n` (a replayed webhook): the stored lines after the
 * callee's turn n (or from n, when nothing was recognised), up to the next callee turn.
 */
export function storedLines(
  turns: readonly TurnView[],
  n: number,
  ownName: string,
  lang: ApprovedCall['language'],
): { lines: DialogLine[]; next: DialogDecision['next']; nextSequence: number } {
  const calleeAtN = turns.some((t) => t.sequence === n && t.speaker === 'callee');
  const start = calleeAtN ? n + 1 : n;
  const lines: TurnView[] = [];
  for (const t of turns) {
    if (t.sequence < start) continue;
    if (t.speaker === 'callee') break;
    lines.push(t);
  }
  const last = lines.at(-1);
  const transfer = last?.kind === 'transfer' && last.text === LINES[lang].transferring(ownName);
  const end = last && (last.kind === 'goodbye' || last.kind === 'voicemail');
  return {
    lines: lines.map((t) => ({ kind: t.kind, text: t.text })),
    next: end ? 'hangup' : transfer ? 'transfer' : 'listen',
    nextSequence: (last?.sequence ?? start - 1) + 1,
  };
}
