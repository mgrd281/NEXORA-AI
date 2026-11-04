/**
 * What the offline and model runners share: the scenario turned into the
 * exact planner input the runtime builds (plan-job.ts), the user's agent
 * context, and the policy pass the runtime makes at plan time and again at
 * execution time — including taint from flagged content (step-policy.ts
 * isTainted), simulated with the runtime's own detector on the fixture
 * pages, documents and earlier results. No database, no network.
 */
import {
  DEFAULT_PREFERENCES,
  Preferences,
  type ConnectionProvider,
  type Locale,
  type MissingInfo,
  type ToolId,
} from '@jarvis/contracts';
import { createHash } from 'node:crypto';
import { loadConfig, type Config } from '../../../src/config';
import type { ConnectionRow } from '../../../src/db/types';
import type { AgentContext, TelephonyContext } from '../../../src/modules/agent/context';
import { localTimeOfDay } from '../../../src/lib/period';
import { phoneHashKey, phoneNumberHash, regionOfNumber } from '../../../src/lib/phone';
import type { PriorTurn } from '../../../src/modules/agent/conversation-context';
import { extractText } from '../../../src/modules/agent/documents/extract';
import { detectLanguage, type PlanningAttachment } from '../../../src/modules/agent/models/offline';
import { usdToMicro } from '../../../src/modules/agent/models/pricing';
import type { ModelRoute } from '../../../src/modules/agent/models/router';
import type { Plan } from '../../../src/modules/agent/plan';
import type { PlanningInput } from '../../../src/modules/agent/planner';
import { denyReason, evaluatePolicy } from '../../../src/modules/agent/policy';
import { assessStep, denyError } from '../../../src/modules/agent/step-policy';
import { findRefs } from '../../../src/modules/agent/templates';
import { extractHtml, normalizeText } from '../../../src/modules/agent/tools/html';
import { detectInjection } from '../../../src/modules/agent/tools/injection';
import { availableTools, getTool } from '../../../src/modules/agent/tools/registry';
import type { Observed, ObservedStepPolicy } from '../expect';
import { loadDocument, loadPage } from '../fixtures';
import { substitute, type LoadedScenario, type Placeholders, type Scenario } from '../scenario';

/** Origins substituted for {{site}} / {{down}} where nothing is fetched. */
export const OFFLINE_SITE = 'https://site.eval.test';
export const OFFLINE_DOWN = 'https://down.eval.test';

export function evalConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    STORAGE_DRIVER: 'none',
    ...overrides,
  });
}

/** A stable UUID-shaped id per scenario and role (deterministic reports). */
export function stableId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function defaultEmail(s: Pick<Scenario, 'id'>): string {
  return `owner+${s.id}@eval.test`;
}

/** Preferences: the defaults deep-merged with the scenario's, validated like the API does. */
export function preferencesOf(s: Scenario): Preferences {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    )
      return Object.fromEntries(
        [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [
          k,
          merge((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
        ]),
      );
    return b;
  };
  return Preferences.parse(merge(DEFAULT_PREFERENCES, s.given.preferences));
}

export interface PreparedDocument {
  id: string;
  mediaType: PlanningAttachment['mediaType'];
  body: Buffer;
  sha256: string;
  /** Extracted text length (null when the file cannot be read). */
  textChars: number | null;
  flagged: boolean;
}

export interface PreparedPage {
  contentType: string;
  body: string;
  flagged: boolean;
}

export interface Prepared {
  scenario: LoadedScenario;
  placeholders: Placeholders;
  request: string;
  language: Locale;
  account: { email: string; locale: Locale; timeZone: string; displayName: string };
  preferences: Preferences;
  turns: PriorTurn[];
  attachments: PlanningAttachment[];
  documents: Map<string, PreparedDocument>;
  /** Substituted URL → page. */
  pages: Map<string, PreparedPage>;
  expect: Scenario['expect'];
  modelPlans: unknown[] | null;
}

/** Scans a fixture page the way web.fetch does (all text incl. hidden elements). */
function pageFlagged(contentType: string, body: string): boolean {
  if (contentType.startsWith('text/html')) {
    const page = extractHtml(body);
    return detectInjection(`${page.title}\n${page.fullText}`).suspectedInjection;
  }
  return detectInjection(normalizeText(body)).suspectedInjection;
}

/**
 * The scenario resolved for one run: placeholders substituted, fixtures
 * loaded and scanned, earlier turns and files as the planner sees them.
 */
export async function prepare(
  s: LoadedScenario,
  where: { site: string; down: string; email?: string },
): Promise<Prepared> {
  const email = where.email ?? s.given.account?.email ?? defaultEmail(s);
  const placeholders: Placeholders = {
    me: email,
    site: where.site,
    down: where.down,
    turns: s.given.conversation.map((_, i) => stableId(`${s.id}:turn:${i}`)),
    files: s.given.attachments.map((_, i) => stableId(`${s.id}:file:${i}`)),
  };
  const given = substitute(s.given, placeholders);
  const account = {
    email,
    locale: given.account?.locale ?? 'en',
    timeZone: given.account?.timeZone ?? 'Europe/Berlin',
    displayName: 'Eval Owner',
  };
  const turns: PriorTurn[] = given.conversation.map((t, i) => ({
    taskId: placeholders.turns[i]!,
    request: t.request,
    status: 'COMPLETED',
    outcome: t.outcome,
    title: t.request.slice(0, 80),
    resultText: t.resultText || null,
    flagged: t.flagged,
    recallable: t.outcome !== 'question' && t.resultText.trim().length > 0,
    ...(t.missing ? { missing: t.missing as MissingInfo[] } : {}),
  }));
  const documents = new Map<string, PreparedDocument>();
  const attachments: PlanningAttachment[] = [];
  for (const [i, a] of given.attachments.entries()) {
    const id = placeholders.files[i]!;
    const doc = await loadDocument(a.fixture);
    let textChars: number | null = null;
    let flagged = false;
    try {
      const extracted = await extractText(doc.body, a.mediaType);
      textChars = extracted.text.length;
      flagged = detectInjection(extracted.text).suspectedInjection;
    } catch {
      // Unreadable: document.analyze fails at execution (pipeline); nothing to scan here.
    }
    documents.set(id, { id, mediaType: a.mediaType, ...doc, textChars, flagged });
    attachments.push({
      id,
      filename: a.filename,
      mediaType: a.mediaType,
      sizeBytes: doc.body.length,
      pageCount: null,
      attachedToRequest: !a.earlier,
    });
  }
  // The request's own files first (in order), then earlier ones newest first, as plan-job orders them.
  attachments.sort((x, y) => Number(y.attachedToRequest) - Number(x.attachedToRequest));
  const pages = new Map<string, PreparedPage>();
  for (const [url, fixture] of Object.entries(given.pages)) {
    const page = await loadPage(fixture);
    pages.set(url, { ...page, flagged: pageFlagged(page.contentType, page.body) });
  }
  return {
    scenario: s,
    placeholders,
    request: given.request,
    language: given.language ?? detectLanguage(given.request, account.locale),
    account,
    preferences: preferencesOf(s),
    turns,
    attachments,
    documents,
    pages,
    expect: substitute(s.expect, placeholders),
    modelPlans: given.model ? (given.model.plans as unknown[]) : null,
  };
}

/**
 * Phase D: the telephony context (context.ts telephonyContext) of a scenario without a
 * database. The do-not-call numbers are hashed with the eval config's key, as the server does.
 */
export function telephonyContextOf(p: Prepared): TelephonyContext {
  const t = p.scenario.given.telephony;
  if (!t)
    return {
      configured: false,
      allowedCountries: new Set(),
      allowedHours: { start: '08:00', end: '20:00' },
      maxPerDay: 0,
      callsToday: 0,
      doNotCall: new Set(),
      ownPhone: null,
    };
  const key = phoneHashKey(evalConfig().SECRET_ENCRYPTION_KEY);
  return {
    configured: t.configured,
    allowedCountries: new Set(t.allowedCountries),
    allowedHours: t.allowedHours,
    maxPerDay: t.maxPerDay,
    callsToday: t.callsToday,
    doNotCall: new Set(t.doNotCall.map((n) => phoneNumberHash(key, n).toString('hex'))),
    ownPhone: t.ownPhone
      ? { ...t.ownPhone, region: regionOfNumber(t.ownPhone.number) }
      : null,
    // Inside the default calling hours unless the scenario sets the clock.
    now: t.now ? new Date(t.now) : tenInTheMorning(p.account.timeZone),
  };
}

/** Today about 10:00 in `timeZone` (inside the default calling window; deterministic per day). */
function tenInTheMorning(timeZone: string): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date());
  let at = new Date(`${day}T10:00:00Z`);
  // Shift by the zone's offset at that instant (twice: once more across a DST change).
  for (let i = 0; i < 2; i++) {
    const [h, m] = (localTimeOfDay(at, timeZone) ?? '10:00').split(':').map(Number) as [
      number,
      number,
    ];
    at = new Date(at.getTime() - ((h - 10) * 60 + m) * 60_000);
  }
  return at;
}

/** The user's runtime context (context.ts loadAgentContext) without a database. */
export function agentContext(p: Prepared, route: ModelRoute): AgentContext {
  const status = p.scenario.given.connectionStatus ?? {};
  const connections = new Map<ConnectionProvider, ConnectionRow>();
  // Only active connections count (activeConnections() filters on status).
  for (const provider of p.scenario.given.connections)
    if ((status[provider] ?? 'active') === 'active')
      connections.set(provider, {
        provider,
        status: 'active',
        config: {},
      } as unknown as ConnectionRow);
  return {
    account: {
      userId: stableId(`${p.scenario.id}:user`),
      tenantId: stableId(`${p.scenario.id}:tenant`),
      email: p.account.email,
      displayName: p.account.displayName,
      locale: p.account.locale,
      timeZone: p.account.timeZone,
    },
    preferences: p.preferences,
    connections,
    budget: { limitMicro: usdToMicro(p.preferences.spending.monthlyAiBudgetUsd), spentMicro: 0 },
    route,
    // Phase C: every listed connection with its status and capabilities, and the purchases.
    connectionStates: p.scenario.given.connections.map((provider) => ({
      connectionId: stableId(`${p.scenario.id}:connection:${provider}`),
      provider,
      status: status[provider] ?? 'active',
      capabilities:
        provider === 'google' || provider === 'microsoft'
          ? (p.scenario.given.connectionCapabilities?.[provider] ?? [])
          : [],
      accountIdentifier: provider === 'smtp' ? p.account.email : null,
    })),
    purchases: {
      limitMicro: usdToMicro(p.preferences.spending.monthlyPurchaseLimitUsd),
      spentMicro: usdToMicro(p.scenario.given.purchases?.spentUsd ?? 0),
    },
    // Phase D
    telephony: telephonyContextOf(p),
  };
}

/** The planner input plan-job.ts builds for this user and request. */
export function planningInput(p: Prepared, agent: AgentContext): PlanningInput {
  return {
    request: p.request,
    language: p.language,
    account: {
      displayName: agent.account.displayName,
      email: agent.account.email,
      locale: agent.account.locale,
      timeZone: agent.account.timeZone,
    },
    tools: availableTools({
      activeConnections: new Set(agent.connections.keys()),
      memoryEnabled: agent.preferences.memory.enabled,
      modelAvailable: agent.route.mode === 'model',
      disabledSkills: agent.preferences.skills?.disabled ?? [],
      hasAttachments: p.attachments.length > 0,
      hasRecallable: p.turns.some((t) => t.recallable),
      connections: agent.connectionStates ?? [],
      browserAvailable: p.scenario.given.browserAvailable,
      telephonyAvailable: agent.telephony?.configured === true,
    }),
    memories: [],
    conversation: p.turns,
    attachments: p.attachments,
    connections: agent.connectionStates ?? [],
    browserAvailable: p.scenario.given.browserAvailable,
    // Phase D
    telephonyAvailable: agent.telephony?.configured === true,
    phoneRegion: agent.telephony?.ownPhone?.region ?? null,
    ownPhoneVerified: agent.telephony?.ownPhone?.verified === true,
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The flag a step's own output would carry (web.fetch, conversation.recall, document.analyze). */
function ownFlag(step: Plan['steps'][number], p: Prepared): boolean {
  switch (step.toolId) {
    case 'web.fetch':
      return p.pages.get(str(step.input.url))?.flagged ?? false;
    case 'conversation.recall':
      return p.turns.find((t) => t.taskId === step.input.taskId)?.flagged ?? false;
    case 'document.analyze':
      return p.documents.get(str(step.input.attachmentId))?.flagged ?? false;
    default:
      return false;
  }
}

/**
 * Observed for a validated plan: the plan-time policy pass (plan-job.ts)
 * and, for steps whose input derives from flagged content, the
 * execution-time pass (executor.ts) with untrustedContent — the decision
 * the user would actually meet.
 */
export function observePlan(
  plan: Plan,
  p: Prepared,
  agent: AgentContext,
  config: Config,
  planner: Observed['planner'],
  costMicro: number,
): Observed {
  const files = [...p.documents.values()].map((d) => ({
    id: d.id,
    sizeBytes: d.body.length,
    textChars: d.textChars,
  }));
  const policy: ObservedStepPolicy[] = [];
  const tainted = new Map<string, boolean>();
  let flagged = false;
  let firstDeny: string | null = null;
  for (const [i, step] of plan.steps.entries()) {
    const tool = getTool(step.toolId)!;
    const refs = findRefs(step.input);
    const untrusted = refs.some((r) => tainted.get(r.stepKey));
    let a = assessStep(tool, step.input, agent, config, { attachments: files });
    if (a.policy.decision !== 'deny' && untrusted)
      a = assessStep(tool, step.input, agent, config, {
        attachments: files,
        untrustedContent: true,
        fromContent: refs.length > 0,
      });
    policy.push({
      step: i,
      toolId: step.toolId,
      decision: a.policy.decision,
      reasons: a.policy.reasons,
    });
    if (a.policy.decision === 'deny' && firstDeny === null)
      firstDeny = denyError(tool, step.title, a.policy).reason ?? null;
    const own = ownFlag(step, p);
    flagged ||= own;
    tainted.set(step.key, own || untrusted);
  }
  const only = plan.steps.length === 1 ? plan.steps[0] : undefined;
  const isQuestion = only?.toolId === 'assistant.clarify';
  const scheduleStep = plan.steps.find((s) => s.toolId === 'schedule.create');
  return {
    result: firstDeny ? 'deny' : isQuestion ? 'question' : 'plan',
    toolSequence: plan.steps.map((s) => s.toolId as ToolId),
    missing: isQuestion ? ((only!.input.missing as MissingInfo[]) ?? []) : null,
    errorReason: firstDeny,
    recipients: plan.steps
      .filter((s) => s.toolId === 'email.send')
      .flatMap((s) => (Array.isArray(s.input.to) ? s.input.to.map(String) : [])),
    urls: plan.steps.filter((s) => s.toolId === 'web.fetch').map((s) => str(s.input.url)),
    policy,
    flagged,
    sideEffects: null,
    schedule: scheduleStep
      ? {
          recurrence: (scheduleStep.input.recurrence ?? {}) as Record<string, unknown>,
          request: str(scheduleStep.input.request),
        }
      : null,
    planner,
    costMicro,
  };
}

/** Observed for a planning failure (the task fails before any step exists). */
export function observeFailure(
  reason: string | null,
  planner: Observed['planner'],
  costMicro: number,
): Observed {
  return {
    result: 'unsupported',
    toolSequence: [],
    missing: null,
    errorReason: reason,
    recipients: [],
    urls: [],
    policy: [],
    flagged: false,
    sideEffects: null,
    schedule: null,
    planner,
    costMicro,
  };
}

/**
 * Steps of tools this build does not have (e.g. a CRITICAL purchase),
 * evaluated by the policy engine directly: there is no tool definition to
 * plan with, so this checks the engine's ceiling, not the planner.
 */
export function observeSynthetic(p: Prepared, agent: AgentContext): Observed {
  const steps = p.scenario.given.syntheticSteps ?? [];
  let firstDeny: string | null = null;
  const policy = steps.map((s, i): ObservedStepPolicy => {
    const r = evaluatePolicy({
      toolId: s.toolId as ToolId,
      risk: s.risk,
      requiredConnection: s.requiredConnection,
      activeConnections: new Set(agent.connections.keys()),
      preferences: agent.preferences,
      accountEmail: agent.account.email,
      sideEffect: s.sideEffect,
      modelUse: 'none',
      model: { available: agent.route.mode === 'model', offlineReason: agent.route.reason },
      projectedCostMicro: 0,
      budget: agent.budget,
      // Phase C facts, exactly as assessStep would pass them.
      requirement: s.requirement ?? null,
      connectionStates: agent.connectionStates,
      purchase: s.purchase
        ? {
            amountMicro: s.purchase.amountUsd === null ? null : usdToMicro(s.purchase.amountUsd),
            currency: s.purchase.currency,
            limitMicro: agent.purchases?.limitMicro ?? 0,
            spentMicro: agent.purchases?.spentMicro ?? 0,
          }
        : null,
      attendees: s.attendees,
      binding: s.binding ?? false,
    });
    if (r.decision === 'deny' && firstDeny === null) firstDeny = denyReason(r.denyCode!, r.reasons);
    return { step: i, toolId: s.toolId, decision: r.decision, reasons: r.reasons };
  });
  return {
    result: firstDeny ? 'deny' : 'plan',
    toolSequence: [],
    missing: null,
    errorReason: firstDeny,
    recipients: [],
    urls: [],
    policy,
    flagged: false,
    sideEffects: null,
    schedule: null,
    planner: 'synthetic',
    costMicro: 0,
  };
}
