/**
 * Telemetry redaction (docs/architecture/phase-b.md §3.10, docs/runbooks/observability.md).
 *
 * Span attributes, metric labels and error reports carry only bounded enums
 * and ids — route names, tool ids, job kinds, model ids, status codes, token
 * counts — never content: no prompts, model output, page or document text,
 * email addresses, subjects, bodies, memories, URLs, query strings, file
 * names, headers or cookies. Call sites are written that way; this module is
 * the second line of defence that enforces it whatever a caller passes.
 */

export type AttributeValue = string | number | boolean;

/** Replacement for a value that looked like content. */
export const REDACTED = '[redacted]';

/** Most attributes a span (or error tag set) keeps. */
export const MAX_ATTRIBUTES = 32;
/** Longest string value kept (ids, enums, model names and route templates are far shorter). */
export const MAX_VALUE_CHARS = 128;

/** Attribute keys: dotted lower-case segments (OpenTelemetry semantic-convention style). */
const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
/**
 * Key segments that name content. A key with any of these segments is
 * dropped whatever its value ("url.full", "jarvis.task.title", "email").
 * Segments are compared whole, so "gen_ai.usage.input_tokens" stays.
 */
const CONTENT_SEGMENTS = new Set([
  'answer',
  'authorization',
  'body',
  'completion',
  'content',
  'cookie',
  'cookies',
  'domain',
  'email',
  'file',
  'filename',
  'header',
  'headers',
  'host',
  'hostname',
  'input',
  'ip',
  'memory',
  'message',
  'messages',
  'note',
  'output',
  'password',
  'path',
  'prompt',
  'query',
  'question',
  'recipient',
  'recipients',
  'request_body',
  'response_body',
  'result',
  'secret',
  'subject',
  'summary',
  'text',
  'title',
  'to',
  'token',
  'translation',
  'url',
  'user_agent',
]);

/**
 * A safe string value: an id, enum, model name, route name or route
 * template. No whitespace, no "@" (addresses), no "?", "=", "&", "%" or "#"
 * (query strings, encoded text) and no "://" (links).
 */
const SAFE_VALUE = /^[A-Za-z0-9_.:/+-]*$/;

export function safeKey(key: string): boolean {
  if (!KEY.test(key)) return false;
  return !key.split('.').some((segment) => CONTENT_SEGMENTS.has(segment));
}

export function safeValue(value: unknown): value is AttributeValue {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return value.length <= MAX_VALUE_CHARS && SAFE_VALUE.test(value) && !value.includes('://');
}

/**
 * The attributes that may be recorded: unsafe keys are dropped, unsafe values
 * replaced with REDACTED, at most MAX_ATTRIBUTES entries.
 */
export function sanitizeAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  let n = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (n >= MAX_ATTRIBUTES) break;
    if (value === undefined || value === null || !safeKey(key)) continue;
    out[key] = safeValue(value) ? value : REDACTED;
    n++;
  }
  return out;
}

/** A bounded metric label value: safe values pass (truncated to 64), anything else is 'other'. */
export function labelValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.length === 0) return 'other';
  return safeValue(value) ? value.slice(0, 64) : 'other';
}

/**
 * The bounded type of an error for telemetry: its code (AgentError /
 * AppError / Node system errors) or class name — never its message, which
 * may quote content.
 */
export function errorType(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && safeValue(code) && code.length <= 64) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && safeValue(name) && name.length <= 64) return name;
  }
  return 'Error';
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;
const WWW = /\bwww\.[^\s"'<>)]+/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PAIR =
  /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|session)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const WEBHOOK_SECRET = /\bwhsec_[A-Za-z0-9+/=]+/g;
const ANTHROPIC_KEY = /\bsk-[A-Za-z0-9_-]{10,}/g;
const LONG_DIGITS = /\b\d{12,}\b/g;

/** Longest free text kept in an error report (after scrubbing). */
export const MAX_TEXT_CHARS = 512;

/**
 * Scrubs free text that must be reported (an exception message): addresses,
 * links, credentials and long numbers are replaced, the rest is truncated.
 * Error messages in this code base are developer English, but some quote a
 * URL, an address or a provider's reply — those parts never leave.
 */
export function scrubText(text: string): string {
  const s = text
    .replace(LINK, '[url]')
    .replace(WWW, '[url]')
    .replace(EMAIL, '[email]')
    .replace(BEARER, '$1 [redacted]')
    .replace(SECRET_PAIR, `$1$2${REDACTED}`)
    .replace(WEBHOOK_SECRET, REDACTED)
    .replace(ANTHROPIC_KEY, REDACTED)
    .replace(LONG_DIGITS, '[number]');
  return s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS - 1)}…` : s;
}

/** A request path without query string or fragment. */
export function pathOnly(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  try {
    // An absolute URL: keep only its path (the host is ours anyway).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return new URL(path).pathname;
  } catch {
    return REDACTED;
  }
  return path;
}

/* ------------------------------------------------------------------ */
/* Sentry events                                                       */
/* ------------------------------------------------------------------ */

/** The parts of a Sentry event this module touches (structural, so tests need no SDK). */
export interface ScrubbableEvent {
  message?: string;
  logentry?: { message?: string; params?: unknown[] };
  request?: {
    url?: string;
    method?: string;
    data?: unknown;
    query_string?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    env?: unknown;
    [key: string]: unknown;
  };
  user?: { id?: string | number; [key: string]: unknown };
  breadcrumbs?: unknown[];
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: {
          vars?: unknown;
          pre_context?: unknown;
          context_line?: unknown;
          post_context?: unknown;
          [key: string]: unknown;
        }[];
      };
      [key: string]: unknown;
    }[];
  };
  [key: string]: unknown;
}

/** Contexts Sentry adds about the process itself (no user data). */
const SAFE_CONTEXTS = new Set([
  'app',
  'cloud_resource',
  'culture',
  'device',
  'os',
  'runtime',
  'trace',
]);
/** Request headers worth keeping: none of them identifies a user or carries content. */
const SAFE_HEADERS = new Set(['content-type', 'content-length', 'accept']);

/**
 * Sentry beforeSend: removes everything that could be content or personal
 * data — request bodies, cookies, query strings, auth and other headers,
 * environment, user email / IP / name (only the pseudonymous id stays),
 * breadcrumbs, extras, local variables, source context lines — and scrubs
 * exception messages.
 * Tags keep only safe keys and values. Mutates and returns the event.
 */
export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.request) {
    const r = event.request;
    const headers = r.headers ?? {};
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers))
      if (SAFE_HEADERS.has(k.toLowerCase())) kept[k] = v;
    event.request = {
      ...(typeof r.method === 'string' ? { method: r.method } : {}),
      ...(typeof r.url === 'string' ? { url: pathOnly(r.url) } : {}),
      headers: kept,
    };
  }
  if (event.user) {
    const id = event.user.id;
    event.user = id !== undefined && safeValue(String(id)) ? { id } : {};
  }
  delete event.breadcrumbs;
  delete event.extra;
  if (event.tags) event.tags = sanitizeAttributes(event.tags);
  if (event.contexts) {
    for (const key of Object.keys(event.contexts))
      if (!SAFE_CONTEXTS.has(key)) delete event.contexts[key];
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  if (event.logentry) {
    event.logentry = {
      ...(typeof event.logentry.message === 'string'
        ? { message: scrubText(event.logentry.message) }
        : {}),
    };
  }
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = scrubText(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      // Local variables may hold anything; source lines are not needed to find a frame.
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  return event;
}
