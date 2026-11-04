/**
 * Server-written text in the viewer's language.
 *
 * The API composes some sentences itself (offline plan and step titles, objectives, approval
 * summaries, result lines) and sends them as `{ key, params }` (contracts ServerMessage) next to
 * the plain text it rendered in the request's language. Task errors come as `code` + `reason` +
 * `params` with an English developer `message`. These helpers turn both into localized strings,
 * through t(), so every interpolated value is isolated in FSI…PDI (the shared bidi primitive:
 * an English host name in an Arabic sentence keeps its own order). Nested messages are rendered
 * first and isolated as a whole.
 *
 * Use them everywhere server text is shown; fall back to the stored text only when there is no
 * message (model-written titles and summaries exist only in the request's language).
 */
import type {
  ConnectionCapability,
  ConnectionProvider,
  ServerMessage,
  TaskError,
  ToolId,
} from '@jarvis/contracts';
import type { SkillId } from '@jarvis/contracts';
import {
  ConnectionCapability as ConnectionCapabilityEnum,
  ConnectionProvider as ConnectionProviderEnum,
  ServerMessageKey,
  SkillId as SkillIdEnum,
  TaskErrorReason,
  ToolId as ToolIdEnum,
} from '@jarvis/contracts';
import { ltrMoney, parseMoneyParam } from '@/lib/money';
import type { MessageKey, Messages } from './catalog';
import { lookup, type TranslateFn } from './translate';
import type { MessageParams } from './types';

export interface ServerTextI18n {
  t: TranslateFn;
  messages: Messages;
  /** With the viewer's locale, money parameters ("USD 129.99") read as local amounts. */
  f?: { intlLocale: string };
}

/** Parameters that carry a contracts moneyParam ("USD 129.99") in server sentences and errors. */
const MONEY_PARAMS = new Set(['total', 'limit', 'spent', 'amount', 'expected', 'actual']);

/** Catalog key of a server sentence: 'plan.summarize' → 'tasks.server.plan.summarize'. */
export function serverMessageCatalogKey(key: ServerMessageKey): MessageKey {
  return `tasks.server.${key}` as MessageKey;
}

/** Catalog key of a task error's reason: 'PRIVATE_ADDRESS' → 'errors.reasons.PRIVATE_ADDRESS'. */
export function errorReasonCatalogKey(reason: TaskErrorReason): MessageKey {
  return `errors.reasons.${reason}` as MessageKey;
}

/** The tool names the interface uses (also for a `{tool}` parameter in a server sentence). */
export const TOOL_LABEL: Record<ToolId, MessageKey> = {
  'web.fetch': 'common.tools.webFetch',
  'text.summarize': 'common.tools.textSummarize',
  'email.send': 'common.tools.emailSend',
  'memory.save': 'common.tools.memorySave',
  'assistant.answer': 'common.tools.assistantAnswer',
  'document.analyze': 'common.tools.documentAnalyze',
  'text.translate': 'common.tools.textTranslate',
  'schedule.create': 'common.tools.scheduleCreate',
  'conversation.recall': 'common.tools.conversationRecall',
  'assistant.clarify': 'common.tools.assistantClarify',
  // Phase C
  'email.search': 'common.tools.emailSearch',
  'email.read_thread': 'common.tools.emailReadThread',
  'email.draft_reply': 'common.tools.emailDraftReply',
  'email.track_replies': 'common.tools.emailTrackReplies',
  'calendar.list': 'common.tools.calendarList',
  'calendar.free_busy': 'common.tools.calendarFreeBusy',
  'calendar.create_event': 'common.tools.calendarCreateEvent',
  'calendar.update_event': 'common.tools.calendarUpdateEvent',
  'calendar.cancel_event': 'common.tools.calendarCancelEvent',
  'booking.find_slots': 'common.tools.bookingFindSlots',
  'booking.book': 'common.tools.bookingBook',
  'browser.read': 'common.tools.browserRead',
  'browser.fill': 'common.tools.browserFill',
  'shop.search': 'common.tools.shopSearch',
  'shop.compare': 'common.tools.shopCompare',
  'shop.prepare_cart': 'common.tools.shopPrepareCart',
  'shop.checkout': 'common.tools.shopCheckout',
};

/** Phase C: provider names are brands (not translated) — a `{provider}` parameter reads as one. */
export const PROVIDER_NAME: Record<ConnectionProvider, string> = {
  web: 'Web',
  smtp: 'SMTP',
  google: 'Google',
  microsoft: 'Microsoft',
};

/** Phase C: a `{capability}` parameter (ConnectionCapability) reads as what it allows. */
export const CAPABILITY_LABEL: Record<ConnectionCapability, MessageKey> = {
  'mail.read': 'common.capabilities.mailRead',
  'mail.compose': 'common.capabilities.mailCompose',
  'mail.send': 'common.capabilities.mailSend',
  'calendar.read': 'common.capabilities.calendarRead',
  'calendar.write': 'common.capabilities.calendarWrite',
};

/** A skill's name in the interface language (also for a `{skill}` parameter). */
export function skillNameKey(id: SkillId): MessageKey {
  return `skills.names.${id}` as MessageKey;
}

const MAX_DEPTH = 4;

function isMessage(value: unknown): value is ServerMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { key?: unknown }).key === 'string'
  );
}

/** A `{tool}` / `{skill}` parameter that is a tool or skill id reads as its name. */
function paramValue(i18n: ServerTextI18n, name: string, value: string | number): string | number {
  if (name === 'tool' && typeof value === 'string') {
    const tool = ToolIdEnum.safeParse(value);
    if (tool.success) return i18n.t(TOOL_LABEL[tool.data]);
  }
  if (name === 'skill' && typeof value === 'string') {
    const skill = SkillIdEnum.safeParse(value);
    if (skill.success) return i18n.t(skillNameKey(skill.data));
  }
  if (name === 'provider' && typeof value === 'string') {
    const provider = ConnectionProviderEnum.safeParse(value);
    if (provider.success) return PROVIDER_NAME[provider.data];
  }
  if (name === 'capability' && typeof value === 'string') {
    const capability = ConnectionCapabilityEnum.safeParse(value);
    if (capability.success) return i18n.t(CAPABILITY_LABEL[capability.data]);
  }
  if (MONEY_PARAMS.has(name) && i18n.f) {
    // "USD 129.99" → "$129.99" / "129,99 $" (same amount, the viewer's notation, kept LTR).
    const money = parseMoneyParam(value);
    if (money) return ltrMoney(money, i18n.f.intlLocale);
  }
  return value;
}

/**
 * A server sentence in the viewer's locale, or null when it can't be rendered (absent, an
 * unknown key from a newer server, or a nested message that can't be rendered): then show the
 * stored text instead.
 */
export function renderServerMessage(
  i18n: ServerTextI18n,
  message: ServerMessage | null | undefined,
  depth = 0,
): string | null {
  if (!isMessage(message) || depth > MAX_DEPTH) return null;
  const key = ServerMessageKey.safeParse(message.key);
  if (!key.success) return null;
  const catalogKey = serverMessageCatalogKey(key.data);
  if (lookup(i18n.messages, catalogKey) === undefined) return null;
  const params: MessageParams = {};
  for (const [name, value] of Object.entries(message.params ?? {})) {
    if (isMessage(value)) {
      const nested = renderServerMessage(i18n, value, depth + 1);
      if (nested === null) return null;
      params[name] = nested;
    } else if (typeof value === 'string' || typeof value === 'number') {
      params[name] = paramValue(i18n, name, value);
    }
  }
  return i18n.t(catalogKey, params);
}

/** The message in the viewer's locale, else the stored (request-language) text. */
export function serverText(
  i18n: ServerTextI18n,
  message: ServerMessage | null | undefined,
  fallback: string,
): string {
  return renderServerMessage(i18n, message, 0) ?? fallback;
}

/** The localized title of a task error's code ("This web address isn’t allowed."). */
export function errorTitle(i18n: ServerTextI18n, error: Pick<TaskError, 'code'>): string {
  return i18n.t(`errors.codes.${error.code}`);
}

/**
 * What exactly went wrong, from the error's reason and params ("intranet.example is on a private
 * or local network…"), or null when the error has no (known) reason. `step` replaces a `{step}`
 * parameter (the server sends the step's stored title) with its title in the viewer's locale.
 */
export function errorReason(
  i18n: ServerTextI18n,
  error: Pick<TaskError, 'reason' | 'params'>,
  { step }: { step?: string | null } = {},
): string | null {
  const reason = TaskErrorReason.safeParse(error.reason);
  if (!reason.success) return null;
  const key = errorReasonCatalogKey(reason.data);
  if (lookup(i18n.messages, key) === undefined) return null;
  const params: MessageParams = {};
  for (const [name, value] of Object.entries(error.params ?? {})) {
    params[name] = paramValue(i18n, name, value);
  }
  if (step && 'step' in params) params.step = step;
  return i18n.t(key, params);
}

/** One line for an error (task rows, timelines): the reason when known, else the code's title. */
export function errorLine(
  i18n: ServerTextI18n,
  error: Pick<TaskError, 'code' | 'reason' | 'params'>,
  options: { step?: string | null } = {},
): string {
  return errorReason(i18n, error, options) ?? errorTitle(i18n, error);
}
