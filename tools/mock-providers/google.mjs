/**
 * Mock Google: OAuth 2.0 / OpenID Connect (accounts.google.com,
 * oauth2.googleapis.com, openidconnect.googleapis.com), Gmail API v1 and
 * Google Calendar API v3 on ONE origin — the shape GOOGLE_BASE_URL_OVERRIDE
 * expects (apps/api/src/config.ts googleEndpoints). Development and tests
 * only; never used in production (the API refuses the override there).
 *
 * Implements the documented request/response shapes JARVIS uses:
 *   GET  /o/oauth2/v2/auth            auto-consent → 302 redirect_uri?code&state&iss
 *                                     (consent.deny → error=access_denied; consent.grantOnly → partial grant)
 *   POST /token                       authorization_code (PKCE S256 verified, single-use codes,
 *                                     exact redirect_uri, client secret) and refresh_token
 *                                     (invalid_grant once revoked); include_granted_scopes
 *   POST /revoke                      token=… → 200, unknown token → 400 invalid_token
 *   GET  /v1/userinfo                 { sub, email, email_verified }
 *   Gmail  users.threads.list/get, users.messages.list/get/send, users.drafts.create, users.getProfile
 *   Calendar events.list/get/insert/patch/delete, freeBusy.query
 * Errors as Google sends them: 401 + WWW-Authenticate error="invalid_token", 403
 * insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT, 404 notFound, 409 duplicate,
 * 410 deleted, 412 conditionNotMet, 429 rateLimitExceeded + Retry-After, 5xx backendError.
 * Every API request records the token's scopes and the scopes the endpoint
 * accepts (record.auth), so tests can prove least privilege.
 */
import {
  OAuthStore,
  b64url,
  formatAddress,
  hasAnyScope,
  overlaps,
  parseAddress,
  parseRfc822,
  pkceChallenge,
  startServer,
  token,
} from './common.mjs';

const G = 'https://www.googleapis.com/auth/';
export const GOOGLE_SCOPES = {
  gmailRead: [`${G}gmail.readonly`, `${G}gmail.modify`, 'https://mail.google.com/'],
  gmailCompose: [`${G}gmail.compose`, `${G}gmail.modify`, 'https://mail.google.com/'],
  gmailSend: [
    `${G}gmail.send`,
    `${G}gmail.compose`,
    `${G}gmail.modify`,
    'https://mail.google.com/',
  ],
  calendarRead: [
    `${G}calendar.events.readonly`,
    `${G}calendar.events`,
    `${G}calendar.readonly`,
    `${G}calendar`,
  ],
  calendarWrite: [`${G}calendar.events`, `${G}calendar`],
  freeBusy: [
    `${G}calendar.freebusy`,
    `${G}calendar.events.freebusy`,
    `${G}calendar.readonly`,
    `${G}calendar`,
  ],
  identity: ['openid', 'email'],
};

/** Google's error envelope (JSON API style). */
export function googleError(status, extra = {}) {
  const table = {
    400: { reason: 'badRequest', message: 'Bad Request', status: 'INVALID_ARGUMENT' },
    401: {
      reason: 'authError',
      message:
        'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
      status: 'UNAUTHENTICATED',
    },
    403: {
      reason: 'insufficientPermissions',
      message: 'Request had insufficient authentication scopes.',
      status: 'PERMISSION_DENIED',
    },
    404: { reason: 'notFound', message: 'Requested entity was not found.', status: 'NOT_FOUND' },
    409: {
      reason: 'duplicate',
      message: 'The requested identifier already exists.',
      status: 'ALREADY_EXISTS',
    },
    410: { reason: 'deleted', message: 'Resource has been deleted', status: 'NOT_FOUND' },
    412: {
      reason: 'conditionNotMet',
      message: 'Precondition Failed',
      status: 'FAILED_PRECONDITION',
    },
    429: {
      reason: 'rateLimitExceeded',
      message: 'Quota exceeded for quota metric and limit.',
      status: 'RESOURCE_EXHAUSTED',
    },
    500: { reason: 'backendError', message: 'Backend Error', status: 'INTERNAL' },
    503: {
      reason: 'backendError',
      message: 'The service is currently unavailable.',
      status: 'UNAVAILABLE',
    },
  };
  const t = table[status] ?? { reason: 'unknown', message: 'Error', status: 'UNKNOWN' };
  const body = {
    error: {
      code: status,
      message: extra.message ?? t.message,
      errors: [
        { message: extra.message ?? t.message, domain: 'global', reason: extra.reason ?? t.reason },
      ],
      status: t.status,
      ...(status === 403
        ? {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
                domain: 'googleapis.com',
              },
            ],
          }
        : {}),
    },
  };
  const headers = {};
  if (status === 401)
    headers['www-authenticate'] =
      'Bearer realm="https://accounts.google.com/", error="invalid_token"';
  if (status === 403)
    headers['www-authenticate'] =
      'Bearer realm="https://accounts.google.com/", error="insufficient_scope"';
  if (status === 429) headers['retry-after'] = String(extra.retryAfter ?? 30);
  return { status, body, headers };
}

const BASE32HEX = /^[a-v0-9]{5,1024}$/;

function rfc3339(ms) {
  return new Date(ms).toISOString();
}

/** Local date-time string of an instant in a zone, as Google returns it (with offset). */
function zonedIso(ms, tz) {
  if (!tz || tz === 'UTC') return new Date(ms).toISOString().replace('.000Z', 'Z');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  const offsetMin = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

/**
 * @param {{ clientId: string, clientSecret: string, port?: number,
 *           accounts?: { email: string, name?: string, sub?: string, timeZone?: string }[],
 *           accessTokenTtlSeconds?: number }} opts
 */
export async function startGoogleMock(opts) {
  const oauth = new OAuthStore({ accessTokenTtlSeconds: opts.accessTokenTtlSeconds ?? 3599 });
  const accounts = new Map();
  /** Busy times of people outside this mock (freeBusy of other calendars). null = not shared. */
  const directory = new Map();
  const invitations = [];
  let loginEmail = null;
  let counter = 0;
  const nextId = (prefix = '') =>
    `${prefix}${(++counter).toString(16).padStart(8, '0')}${Date.now().toString(16)}`;
  const consent = { deny: false, grantOnly: null, omitScopeInResponse: false };

  function addAccount(a) {
    const email = a.email.toLowerCase();
    accounts.set(email, {
      email,
      name: a.name ?? null,
      sub:
        a.sub ??
        `1${String(accounts.size + 1).padStart(8, '0')}${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
      timeZone: a.timeZone ?? 'UTC',
      messages: [],
      drafts: [],
      events: new Map(),
      historyId: 1000,
    });
    loginEmail ??= email;
  }
  for (const a of opts.accounts ?? [{ email: 'owner@gmail.test', name: 'Owner' }]) addAccount(a);
  const account = (email) => {
    const a = accounts.get(String(email).toLowerCase());
    if (!a) throw new Error(`mock google: unknown account ${email}`);
    return a;
  };

  /* ------------------------------ Gmail model ------------------------------ */

  function toGmailMessage(acc, m) {
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labels],
      from: m.from,
      to: m.to,
      cc: m.cc,
      replyTo: m.replyTo,
      subject: m.subject,
      body: m.body,
      html: m.html,
      date: m.date,
      headers: m.headers,
      messageIdHeader: m.messageIdHeader,
      account: acc.email,
    };
  }

  function addMessage(email, input) {
    const acc = account(email);
    const id = input.id ?? nextId('m');
    const from = parseAddress(input.from) ?? { name: null, address: acc.email };
    const sentByOwner = from.address.toLowerCase() === acc.email;
    const labels = new Set(input.labels ?? (sentByOwner ? ['SENT'] : ['INBOX']));
    if (input.unread ?? !sentByOwner) labels.add('UNREAD');
    const m = {
      id,
      threadId: input.threadId ?? id,
      labels,
      from,
      to: (input.to ?? [acc.email]).map(parseAddress),
      cc: (input.cc ?? []).map(parseAddress),
      replyTo: input.replyTo ? parseAddress(input.replyTo) : null,
      subject: input.subject ?? '',
      body: input.body ?? '',
      html: input.html ?? null,
      date: input.date
        ? new Date(input.date).getTime()
        : Date.now() - (1000 - acc.messages.length) * 1000,
      headers: input.headers ?? {},
      messageIdHeader: input.messageIdHeader ?? `<${id}@mail.gmail.test>`,
      inReplyTo: input.inReplyTo ?? null,
    };
    acc.messages.push(m);
    acc.historyId += 1;
    return id;
  }

  function headersOf(m) {
    const h = [
      { name: 'From', value: formatAddress(m.from) },
      { name: 'To', value: m.to.map(formatAddress).join(', ') },
      ...(m.cc.length ? [{ name: 'Cc', value: m.cc.map(formatAddress).join(', ') }] : []),
      ...(m.replyTo ? [{ name: 'Reply-To', value: formatAddress(m.replyTo) }] : []),
      { name: 'Subject', value: m.subject },
      { name: 'Date', value: new Date(m.date).toUTCString() },
      { name: 'Message-ID', value: m.messageIdHeader },
      ...(m.inReplyTo ? [{ name: 'In-Reply-To', value: m.inReplyTo }] : []),
      ...Object.entries(m.headers).map(([name, value]) => ({ name, value })),
    ];
    return h;
  }

  function messageResource(m, format, metadataHeaders) {
    const base = {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labels],
      snippet: m.body.replace(/\s+/g, ' ').slice(0, 160),
      historyId: '1',
      internalDate: String(m.date),
      sizeEstimate: m.body.length + 400,
    };
    if (format === 'minimal') return base;
    let headers = headersOf(m);
    if (format === 'metadata' && metadataHeaders.length) {
      const want = new Set(metadataHeaders.map((x) => x.toLowerCase()));
      headers = headers.filter((x) => want.has(x.name.toLowerCase()));
    }
    if (format === 'metadata')
      return {
        ...base,
        payload: { partId: '', mimeType: 'multipart/alternative', filename: '', headers },
      };
    const textPart = {
      partId: '0',
      mimeType: 'text/plain',
      filename: '',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
      body: { size: Buffer.byteLength(m.body), data: b64url(Buffer.from(m.body, 'utf8')) },
    };
    const parts = [textPart];
    if (m.html)
      parts.push({
        partId: '1',
        mimeType: 'text/html',
        filename: '',
        headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
        body: { size: Buffer.byteLength(m.html), data: b64url(Buffer.from(m.html, 'utf8')) },
      });
    return {
      ...base,
      payload: {
        partId: '',
        mimeType: 'multipart/alternative',
        filename: '',
        headers,
        body: { size: 0 },
        parts,
      },
    };
  }

  /** The subset of Gmail search operators JARVIS emits. */
  function matches(m, acc, q) {
    if (!q) return true;
    const tokens = q.match(/(?:[a-z0-9_]+:)?(?:"[^"]*"|\([^)]*\)|\S+)/gi) ?? [];
    for (const raw of tokens) {
      const t = raw.trim();
      const op = /^([a-z0-9_]+):(.*)$/i.exec(t);
      const value = (op ? op[2] : t).replace(/^["(]|[")]$/g, '').toLowerCase();
      if (op) {
        const name = op[1].toLowerCase();
        if (name === 'is' && value === 'unread' && !m.labels.has('UNREAD')) return false;
        if (name === 'in' && value === 'inbox' && !m.labels.has('INBOX')) return false;
        if (name === 'in' && value === 'sent' && !m.labels.has('SENT')) return false;
        if (name === 'from' && !formatAddress(m.from).toLowerCase().includes(value)) return false;
        if (
          name === 'rfc822msgid' &&
          m.messageIdHeader.replace(/[<>]/g, '').toLowerCase() !== value.replace(/[<>]/g, '')
        )
          return false;
        if (name === 'newer_than') {
          const d = /^(\d+)d$/.exec(value);
          if (d && m.date < Date.now() - Number(d[1]) * 86_400_000) return false;
        }
        if (name === 'subject' && !m.subject.toLowerCase().includes(value)) return false;
        continue;
      }
      if (t === '-in:chats') continue;
      const hay = `${m.subject} ${m.body} ${formatAddress(m.from)}`.toLowerCase();
      if (!hay.includes(value)) return false;
    }
    return true;
  }

  function threadsOf(acc) {
    const byThread = new Map();
    for (const m of acc.messages) {
      const list = byThread.get(m.threadId) ?? [];
      list.push(m);
      byThread.set(m.threadId, list);
    }
    for (const list of byThread.values()) list.sort((a, b) => a.date - b.date);
    return byThread;
  }

  /* ---------------------------- Calendar model ---------------------------- */

  function eventResource(acc, e) {
    return {
      kind: 'calendar#event',
      etag: `"${e.etag}"`,
      id: e.id,
      status: e.status,
      htmlLink: `https://calendar.google.test/event?eid=${e.id}`,
      created: rfc3339(e.created),
      updated: rfc3339(e.updated),
      summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      ...(e.location ? { location: e.location } : {}),
      creator: { email: acc.email, self: true },
      organizer: e.organizer ?? { email: acc.email, self: true },
      start: e.allDay
        ? { date: e.startDate }
        : { dateTime: zonedIso(e.start, e.timeZone), timeZone: e.timeZone },
      end: e.allDay
        ? { date: e.endDate }
        : { dateTime: zonedIso(e.end, e.timeZone), timeZone: e.timeZone },
      ...(e.transparency ? { transparency: e.transparency } : {}),
      ...(e.attendees.length
        ? {
            attendees: e.attendees.map((a) => ({
              email: a.email,
              ...(a.displayName ? { displayName: a.displayName } : {}),
              responseStatus: a.responseStatus ?? 'needsAction',
              ...(a.organizer ? { organizer: true } : {}),
              ...(a.email.toLowerCase() === acc.email ? { self: true } : {}),
            })),
          }
        : {}),
      iCalUID: `${e.id}@google.test`,
      sequence: e.sequence,
      reminders: { useDefault: true },
      eventType: 'default',
    };
  }

  function parseEventTime(t, fallbackTz) {
    if (!t) return null;
    if (t.date) {
      return {
        allDay: true,
        date: t.date,
        ms: Date.parse(`${t.date}T00:00:00Z`),
        tz: t.timeZone ?? fallbackTz,
      };
    }
    if (t.dateTime) {
      const ms = Date.parse(t.dateTime);
      if (Number.isNaN(ms)) return null;
      return { allDay: false, ms, tz: t.timeZone ?? fallbackTz };
    }
    return null;
  }

  function addEvent(email, input) {
    const acc = account(email);
    const id = input.id ?? nextId('ev').replace(/[^a-v0-9]/g, 'a');
    const allDay = !!input.allDay;
    const e = {
      id,
      status: input.status ?? 'confirmed',
      summary: input.title ?? input.summary ?? '(no title)',
      description: input.description ?? null,
      location: input.location ?? null,
      timeZone: input.timeZone ?? acc.timeZone,
      allDay,
      start: allDay ? Date.parse(`${input.start}T00:00:00Z`) : Date.parse(input.start),
      end: allDay ? Date.parse(`${input.end}T00:00:00Z`) : Date.parse(input.end),
      startDate: allDay ? input.start : null,
      endDate: allDay ? input.end : null,
      attendees: (input.attendees ?? []).map((x) => (typeof x === 'string' ? { email: x } : x)),
      organizer: input.organizer ? { email: input.organizer } : null,
      transparency: input.transparency ?? null,
      etag: 1,
      sequence: 0,
      created: Date.now(),
      updated: Date.now(),
    };
    acc.events.set(id, e);
    return id;
  }

  function busyOf(acc, minMs, maxMs) {
    const out = [];
    for (const e of acc.events.values()) {
      if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
      const self = e.attendees.find((a) => a.email.toLowerCase() === acc.email);
      if (self?.responseStatus === 'declined') continue;
      if (!overlaps(e.start, e.end, minMs, maxMs)) continue;
      out.push({ start: rfc3339(Math.max(e.start, minMs)), end: rfc3339(Math.min(e.end, maxMs)) });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  /* -------------------------------- Routing ------------------------------- */

  /** Bearer check + scope check, recorded on the request. */
  function authorize(ctx, required) {
    const bearer = oauth.checkBearer(ctx.req.headers.authorization);
    ctx.record.auth = {
      scopes: bearer.ok ? bearer.scopes : null,
      required,
      account: bearer.email ?? null,
    };
    if (!bearer.ok) return { error: googleError(401) };
    if (!hasAnyScope(bearer.scopes, required)) return { error: googleError(403) };
    return { acc: account(bearer.email) };
  }

  const routes = [
    /* --------------------------- OAuth / OIDC --------------------------- */
    [
      'GET',
      /^\/o\/oauth2\/v2\/auth$/,
      ({ query }) => {
        const clientId = query.get('client_id');
        const redirectUri = query.get('redirect_uri');
        const state = query.get('state');
        if (clientId !== opts.clientId) return { status: 400, body: 'Error 401: invalid_client' };
        if (!redirectUri) return { status: 400, body: 'Error 400: redirect_uri_mismatch' };
        if (query.get('response_type') !== 'code')
          return { status: 400, body: 'unsupported_response_type' };
        if (query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge'))
          return {
            status: 400,
            body: 'Error 400: invalid_request (PKCE S256 required by this mock)',
          };
        const location = new URL(redirectUri);
        if (consent.deny) {
          location.searchParams.set('error', 'access_denied');
          if (state) location.searchParams.set('state', state);
          return { status: 302, body: null, headers: { location: location.toString() } };
        }
        const email = (query.get('login_hint') ?? loginEmail).toLowerCase();
        const requested = (query.get('scope') ?? '').split(/\s+/).filter(Boolean);
        const granted = consent.grantOnly
          ? requested.filter(
              (s) => GOOGLE_SCOPES.identity.includes(s) || consent.grantOnly.includes(s),
            )
          : requested;
        const code = oauth.issueCode({
          clientId,
          redirectUri,
          scopes: granted,
          challenge: query.get('code_challenge'),
          method: 'S256',
          email,
          include: query.get('include_granted_scopes') === 'true',
          offline: query.get('access_type') === 'offline',
        });
        const stored = oauth.codes.get(code);
        stored.include = query.get('include_granted_scopes') === 'true';
        stored.offline = query.get('access_type') === 'offline';
        location.searchParams.set('code', code);
        if (state) location.searchParams.set('state', state);
        location.searchParams.set('scope', granted.join(' '));
        location.searchParams.set('iss', ctxIssuer());
        return { status: 302, body: null, headers: { location: location.toString() } };
      },
    ],
    [
      'POST',
      /^\/token$/,
      ({ body }) => {
        const f = body.form ?? {};
        if (f.client_id !== opts.clientId || f.client_secret !== opts.clientSecret)
          return {
            status: 401,
            body: { error: 'invalid_client', error_description: 'Unauthorized' },
          };
        if (f.grant_type === 'authorization_code') {
          oauth.grantTypes.authorization_code += 1;
          const c = oauth.codes.get(f.code);
          if (!c || c.used || c.expiresAt < Date.now() || c.clientId !== f.client_id)
            return {
              status: 400,
              body: { error: 'invalid_grant', error_description: 'Malformed auth code.' },
            };
          c.used = true;
          if (c.redirectUri !== f.redirect_uri)
            return {
              status: 400,
              body: { error: 'redirect_uri_mismatch', error_description: 'Bad Request' },
            };
          if (!f.code_verifier || pkceChallenge(f.code_verifier) !== c.challenge)
            return {
              status: 400,
              body: { error: 'invalid_grant', error_description: 'Invalid code verifier.' },
            };
          const scopes = oauth.recordGrant(c.email, c.clientId, c.scopes, c.include);
          const access = oauth.issueAccess(c.email, c.clientId, scopes);
          const refresh = c.offline ? oauth.issueRefresh(c.email, c.clientId, scopes) : null;
          return {
            status: 200,
            body: {
              access_token: access,
              expires_in: oauth.accessTokenTtlSeconds,
              ...(refresh ? { refresh_token: refresh } : {}),
              ...(consent.omitScopeInResponse ? {} : { scope: scopes.join(' ') }),
              token_type: 'Bearer',
              id_token: `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: account(c.email).sub, email: c.email }))}.`,
            },
          };
        }
        if (f.grant_type === 'refresh_token') {
          oauth.grantTypes.refresh_token += 1;
          const r = oauth.refreshTokens.get(f.refresh_token);
          if (!r || !r.valid || r.clientId !== f.client_id)
            return {
              status: 400,
              body: {
                error: 'invalid_grant',
                error_description: 'Token has been expired or revoked.',
              },
            };
          const access = oauth.issueAccess(r.email, r.clientId, r.scopes);
          return {
            status: 200,
            body: {
              access_token: access,
              expires_in: oauth.accessTokenTtlSeconds,
              scope: r.scopes.join(' '),
              token_type: 'Bearer',
            },
          };
        }
        return {
          status: 400,
          body: { error: 'unsupported_grant_type', error_description: 'Invalid grant_type' },
        };
      },
    ],
    [
      'POST',
      /^\/revoke$/,
      ({ body, query }) => {
        const t = body.form?.token ?? query.get('token');
        const refresh = oauth.refreshTokens.get(t);
        const access = oauth.accessTokens.get(t);
        if ((!refresh || !refresh.valid) && (!access || !access.valid))
          return {
            status: 400,
            body: { error: 'invalid_token', error_description: 'Token expired or revoked' },
          };
        const email = (refresh ?? access).email;
        oauth.revokeAccount(email);
        oauth.revoked.push(t);
        return { status: 200, body: {} };
      },
    ],
    [
      'GET',
      /^\/v1\/userinfo$/,
      (ctx) => {
        const a = authorize(ctx, ['openid', 'email']);
        if (a.error) return a.error;
        return { status: 200, body: { sub: a.acc.sub, email: a.acc.email, email_verified: true } };
      },
    ],

    /* -------------------------------- Gmail ------------------------------- */
    [
      'GET',
      /^\/gmail\/v1\/users\/me\/profile$/,
      (ctx) => {
        const a = authorize(ctx, [...GOOGLE_SCOPES.gmailRead, ...GOOGLE_SCOPES.gmailCompose]);
        if (a.error) return a.error;
        return {
          status: 200,
          body: {
            emailAddress: a.acc.email,
            messagesTotal: a.acc.messages.length,
            threadsTotal: threadsOf(a.acc).size,
            historyId: String(a.acc.historyId),
          },
        };
      },
    ],
    [
      'GET',
      /^\/gmail\/v1\/users\/me\/threads$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.gmailRead);
        if (a.error) return a.error;
        const q = ctx.query.get('q') ?? '';
        const max = Math.min(Number(ctx.query.get('maxResults') ?? 100), 500);
        const threads = [...threadsOf(a.acc).entries()]
          .filter(([, msgs]) => msgs.some((m) => !m.labels.has('DRAFT') && matches(m, a.acc, q)))
          .sort((x, y) => y[1].at(-1).date - x[1].at(-1).date)
          .slice(0, max)
          .map(([id, msgs]) => ({
            id,
            snippet: msgs.at(-1).body.slice(0, 160),
            historyId: String(a.acc.historyId),
          }));
        return {
          status: 200,
          body: { ...(threads.length ? { threads } : {}), resultSizeEstimate: threads.length },
        };
      },
    ],
    [
      'GET',
      /^\/gmail\/v1\/users\/me\/threads\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.gmailRead);
        if (a.error) return a.error;
        const msgs = threadsOf(a.acc).get(ctx.params.id);
        if (!msgs) return googleError(404);
        const format = ctx.query.get('format') ?? 'full';
        const meta = ctx.query.getAll('metadataHeaders');
        return {
          status: 200,
          body: {
            id: ctx.params.id,
            historyId: String(a.acc.historyId),
            messages: msgs
              .filter((m) => !m.labels.has('DRAFT'))
              .map((m) => messageResource(m, format, meta)),
          },
        };
      },
    ],
    [
      'GET',
      /^\/gmail\/v1\/users\/me\/messages$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.gmailRead);
        if (a.error) return a.error;
        const q = ctx.query.get('q') ?? '';
        const found = a.acc.messages
          .filter((m) => matches(m, a.acc, q))
          .sort((x, y) => y.date - x.date)
          .map((m) => ({ id: m.id, threadId: m.threadId }));
        return {
          status: 200,
          body: { ...(found.length ? { messages: found } : {}), resultSizeEstimate: found.length },
        };
      },
    ],
    [
      'GET',
      /^\/gmail\/v1\/users\/me\/messages\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.gmailRead);
        if (a.error) return a.error;
        const m = a.acc.messages.find((x) => x.id === ctx.params.id);
        if (!m) return googleError(404);
        return {
          status: 200,
          body: messageResource(
            m,
            ctx.query.get('format') ?? 'full',
            ctx.query.getAll('metadataHeaders'),
          ),
        };
      },
    ],
    [
      'POST',
      /^\/gmail\/v1\/users\/me\/messages\/send$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.gmailSend);
        if (a.error) return a.error;
        const raw = ctx.body.json?.raw;
        if (typeof raw !== 'string') return googleError(400, { message: "'raw' is required" });
        const parsed = parseRfc822(Buffer.from(raw, 'base64url').toString('utf8'));
        const to = String(parsed.headers.to ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (to.length === 0) return googleError(400, { message: 'Invalid To header' });
        const threadId = ctx.body.json?.threadId;
        if (threadId && !threadsOf(a.acc).has(threadId)) return googleError(404);
        const id = addMessage(a.acc.email, {
          from: parsed.headers.from ?? a.acc.email,
          to,
          cc: parsed.headers.cc ? parsed.headers.cc.split(',') : [],
          subject: parsed.subject,
          body: parsed.body,
          labels: ['SENT'],
          unread: false,
          threadId: threadId ?? undefined,
          messageIdHeader: parsed.headers['message-id'] ?? undefined,
          inReplyTo: parsed.headers['in-reply-to'] ?? null,
          date: Date.now(),
        });
        const m = a.acc.messages.find((x) => x.id === id);
        return { status: 200, body: { id, threadId: m.threadId, labelIds: ['SENT'] } };
      },
    ],
    [
      'POST',
      /^\/gmail\/v1\/users\/me\/drafts$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.gmailCompose);
        if (a.error) return a.error;
        const message = ctx.body.json?.message;
        if (!message || typeof message.raw !== 'string')
          return googleError(400, { message: "'message.raw' is required" });
        if (message.threadId && !threadsOf(a.acc).has(message.threadId)) return googleError(404);
        const parsed = parseRfc822(Buffer.from(message.raw, 'base64url').toString('utf8'));
        const messageId = nextId('m');
        const draft = {
          id: `r-${nextId('')}`,
          message: {
            id: messageId,
            threadId: message.threadId ?? messageId,
            labelIds: ['DRAFT'],
          },
          headers: parsed.headers,
          subject: parsed.subject,
          body: parsed.body,
        };
        a.acc.drafts.push(draft);
        return { status: 200, body: { id: draft.id, message: draft.message } };
      },
    ],

    /* ------------------------------ Calendar ------------------------------ */
    [
      'GET',
      /^\/calendar\/v3\/calendars\/(?<cal>[^/]+)\/events$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.calendarRead);
        if (a.error) return a.error;
        const min = ctx.query.get('timeMin') ? Date.parse(ctx.query.get('timeMin')) : -Infinity;
        const max = ctx.query.get('timeMax') ? Date.parse(ctx.query.get('timeMax')) : Infinity;
        const limit = Math.min(Number(ctx.query.get('maxResults') ?? 250), 2500);
        const q = (ctx.query.get('q') ?? '').toLowerCase();
        const items = [...a.acc.events.values()]
          .filter((e) => e.status !== 'cancelled' || ctx.query.get('showDeleted') === 'true')
          .filter((e) => overlaps(e.start, e.end, min, max))
          .filter(
            (e) =>
              !q ||
              `${e.summary} ${e.description ?? ''} ${e.location ?? ''}`.toLowerCase().includes(q),
          )
          .sort((x, y) => x.start - y.start);
        const page = items.slice(0, limit).map((e) => eventResource(a.acc, e));
        return {
          status: 200,
          body: {
            kind: 'calendar#events',
            etag: `"${a.acc.historyId}"`,
            summary: a.acc.email,
            updated: rfc3339(Date.now()),
            timeZone: a.acc.timeZone,
            accessRole: 'owner',
            items: page,
            ...(items.length > limit ? { nextPageToken: token('p_', 6) } : {}),
          },
        };
      },
    ],
    [
      'GET',
      /^\/calendar\/v3\/calendars\/(?<cal>[^/]+)\/events\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.calendarRead);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e) return googleError(404);
        return { status: 200, body: eventResource(a.acc, e) };
      },
    ],
    [
      'POST',
      /^\/calendar\/v3\/calendars\/(?<cal>[^/]+)\/events$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.calendarWrite);
        if (a.error) return a.error;
        const b = ctx.body.json ?? {};
        if (b.id !== undefined && !BASE32HEX.test(b.id))
          return googleError(400, { message: 'Invalid resource id value.' });
        if (b.id && a.acc.events.has(b.id)) return googleError(409);
        const start = parseEventTime(b.start, a.acc.timeZone);
        const end = parseEventTime(b.end, a.acc.timeZone);
        if (!start || !end)
          return googleError(400, { message: 'Missing time zone definition for start time.' });
        if (end.ms < start.ms)
          return googleError(400, { message: 'The specified time range is empty.' });
        const id = addEvent(a.acc.email, {
          id: b.id,
          title: b.summary ?? '',
          description: b.description,
          location: b.location,
          allDay: start.allDay,
          start: start.allDay ? start.date : new Date(start.ms).toISOString(),
          end: end.allDay ? end.date : new Date(end.ms).toISOString(),
          timeZone: start.tz,
          attendees: (b.attendees ?? []).map((x) => ({
            email: x.email,
            responseStatus: 'needsAction',
          })),
        });
        const sendUpdates = ctx.query.get('sendUpdates') ?? 'none';
        const e = a.acc.events.get(id);
        if (sendUpdates !== 'none')
          for (const att of e.attendees)
            invitations.push({ eventId: id, to: att.email, kind: 'invite', from: a.acc.email });
        return { status: 200, body: eventResource(a.acc, e) };
      },
    ],
    [
      'PATCH',
      /^\/calendar\/v3\/calendars\/(?<cal>[^/]+)\/events\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.calendarWrite);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e || e.status === 'cancelled') return googleError(404);
        const ifMatch = ctx.req.headers['if-match'];
        if (ifMatch && ifMatch !== `"${e.etag}"`) return googleError(412);
        const b = ctx.body.json ?? {};
        if (b.summary !== undefined) e.summary = b.summary;
        if (b.description !== undefined) e.description = b.description;
        if (b.location !== undefined) e.location = b.location;
        if (b.start) {
          const s = parseEventTime(b.start, e.timeZone);
          if (!s) return googleError(400);
          e.start = s.ms;
          e.timeZone = s.tz;
        }
        if (b.end) {
          const t = parseEventTime(b.end, e.timeZone);
          if (!t) return googleError(400);
          e.end = t.ms;
        }
        if (b.attendees)
          e.attendees = b.attendees.map((x) => ({ email: x.email, responseStatus: 'needsAction' }));
        e.etag += 1;
        e.sequence += 1;
        e.updated = Date.now();
        if ((ctx.query.get('sendUpdates') ?? 'none') !== 'none')
          for (const att of e.attendees)
            invitations.push({ eventId: e.id, to: att.email, kind: 'update', from: a.acc.email });
        return { status: 200, body: eventResource(a.acc, e) };
      },
    ],
    [
      'DELETE',
      /^\/calendar\/v3\/calendars\/(?<cal>[^/]+)\/events\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.calendarWrite);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e) return googleError(404);
        if (e.status === 'cancelled') return googleError(410);
        const ifMatch = ctx.req.headers['if-match'];
        if (ifMatch && ifMatch !== `"${e.etag}"`) return googleError(412);
        e.status = 'cancelled';
        e.etag += 1;
        if ((ctx.query.get('sendUpdates') ?? 'none') !== 'none')
          for (const att of e.attendees)
            invitations.push({ eventId: e.id, to: att.email, kind: 'cancel', from: a.acc.email });
        return { status: 204, body: null };
      },
    ],
    [
      'POST',
      /^\/calendar\/v3\/freeBusy$/,
      (ctx) => {
        const a = authorize(ctx, GOOGLE_SCOPES.freeBusy);
        if (a.error) return a.error;
        const b = ctx.body.json ?? {};
        const min = Date.parse(b.timeMin);
        const max = Date.parse(b.timeMax);
        if (Number.isNaN(min) || Number.isNaN(max))
          return googleError(400, { message: 'Missing timeMin/timeMax' });
        const calendars = {};
        for (const item of b.items ?? []) {
          const id = String(item.id);
          const key = id.toLowerCase();
          if (key === 'primary' || key === a.acc.email) {
            calendars[id] = { busy: busyOf(a.acc, min, max) };
          } else if (accounts.has(key)) {
            calendars[id] = { busy: busyOf(accounts.get(key), min, max) };
          } else if (directory.has(key) && directory.get(key) !== null) {
            calendars[id] = {
              busy: directory
                .get(key)
                .filter((x) => overlaps(Date.parse(x.start), Date.parse(x.end), min, max))
                .map((x) => ({
                  start: new Date(x.start).toISOString(),
                  end: new Date(x.end).toISOString(),
                })),
            };
          } else {
            calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
          }
        }
        return {
          status: 200,
          body: {
            kind: 'calendar#freeBusy',
            timeMin: new Date(min).toISOString(),
            timeMax: new Date(max).toISOString(),
            calendars,
          },
        };
      },
    ],
  ];

  const srv = await startServer({
    port: opts.port ?? 0,
    routes,
    errorBody: (status) => googleError(status),
  });
  const ctxIssuer = () => srv.url;

  return {
    kind: 'google',
    url: srv.url,
    port: srv.port,
    issuer: srv.url,
    requests: srv.requests,
    oauth,
    consent,
    invitations,
    addAccount,
    setLoginAccount(email) {
      loginEmail = email.toLowerCase();
    },
    addMessage,
    addEvent,
    /** Busy times of someone outside this mock; null = their calendar is not shared. */
    setFreeBusy(email, busy) {
      directory.set(email.toLowerCase(), busy);
    },
    messages: (email) => account(email).messages.map((m) => toGmailMessage(account(email), m)),
    sent: (email) =>
      account(email)
        .messages.filter((m) => m.labels.has('SENT'))
        .map((m) => toGmailMessage(account(email), m)),
    drafts: (email) => account(email).drafts.map((d) => ({ ...d })),
    events: (email) =>
      [...account(email).events.values()].map((e) => eventResource(account(email), e)),
    /** Every token of the account stops working: refresh → invalid_grant, API → 401. */
    revokeGrants: (email) => oauth.revokeAccount(email),
    /** Access tokens stop working (401 invalid_token); refresh still works. */
    expireAccessTokens: (email) => oauth.expireAccess(email),
    failNext: srv.failNext,
    clearFailures: srv.clearFailures,
    errors: {
      invalidToken: () => googleError(401),
      insufficientScope: () => googleError(403),
      rateLimited: (seconds = 30) => googleError(429, { retryAfter: seconds }),
      unavailable: (status = 503) => googleError(status),
    },
    close: srv.close,
  };
}
