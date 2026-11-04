/**
 * Mock Microsoft identity platform (v2.0) + Microsoft Graph v1.0 on ONE origin —
 * the shape MICROSOFT_BASE_URL_OVERRIDE expects (apps/api/src/config.ts
 * microsoftEndpoints: /{tenant}/oauth2/v2.0/* and /v1.0/*). Development and
 * tests only.
 *
 *   GET  /{tenant}/oauth2/v2.0/authorize   auto-consent → 302 redirect_uri?code&state (response_mode=query)
 *   POST /{tenant}/oauth2/v2.0/token       authorization_code (PKCE S256, client secret, exact redirect
 *                                          URI, single use) and refresh_token — refresh tokens ROTATE:
 *                                          each refresh returns a new one and the old one is refused
 *                                          (invalid_grant), as a strict rotation policy does
 *   GET  /v1.0/me                          { id, displayName, mail, userPrincipalName }
 *   Mail  /me/messages, /me/mailFolders/{inbox|sentitems|drafts}/messages ($filter, $search, $top,
 *         $select, $orderby, $expand of singleValueExtendedProperties), /me/messages/{id},
 *         POST /me/messages (draft), PATCH /me/messages/{id}, POST …/createReply, POST …/send,
 *         POST /me/sendMail
 *   Calendar /me/calendarView, /me/events (GET with $filter on the extended property, POST with
 *         transactionId de-duplication), GET/PATCH(If-Match)/DELETE /me/events/{id},
 *         POST /me/events/{id}/cancel, POST /me/calendar/getSchedule
 * Errors as Graph sends them: { error: { code, message } } — 401 InvalidAuthenticationToken
 * (+ WWW-Authenticate error="invalid_token"), 403 ErrorAccessDenied, 404 ErrorItemNotFound,
 * 412 ErrorIrresolvableConflict, 429 TooManyRequests + Retry-After, 503 ServiceNotAvailable.
 * Scopes are compared case-insensitively without the https://graph.microsoft.com/ prefix.
 */
import {
  OAuthStore,
  hasAnyScope,
  overlaps,
  parseAddress,
  pkceChallenge,
  startServer,
} from './common.mjs';

const GRAPH = 'https://graph.microsoft.com/';
export const short = (s) => s.replace(GRAPH, '').toLowerCase();

const SCOPES = {
  user: ['User.Read'],
  mailRead: ['Mail.Read', 'Mail.ReadWrite'],
  mailWrite: ['Mail.ReadWrite'],
  mailSend: ['Mail.Send'],
  calRead: ['Calendars.Read', 'Calendars.ReadWrite'],
  calWrite: ['Calendars.ReadWrite'],
};

export function graphError(status, extra = {}) {
  const table = {
    400: ['ErrorInvalidRequest', 'The request is invalid.'],
    401: ['InvalidAuthenticationToken', 'Access token has expired or is not yet valid.'],
    403: ['ErrorAccessDenied', 'Access is denied. Check credentials and try again.'],
    404: ['ErrorItemNotFound', 'The specified object was not found in the store.'],
    409: ['ErrorConflict', 'Conflict.'],
    412: [
      'ErrorIrresolvableConflict',
      'The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item.',
    ],
    429: ['TooManyRequests', 'Too many requests, please try again later.'],
    500: ['InternalServerError', 'Internal server error.'],
    503: ['ServiceNotAvailable', 'The service is temporarily unavailable.'],
  };
  const [code, message] = table[status] ?? ['UnknownError', 'Error'];
  const headers = {};
  if (status === 401)
    headers['www-authenticate'] =
      'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", error="invalid_token"';
  if (status === 429 || status === 503) headers['retry-after'] = String(extra.retryAfter ?? 30);
  return {
    status,
    body: {
      error: {
        code: extra.code ?? code,
        message: extra.message ?? message,
        innerError: {
          date: new Date().toISOString(),
          'request-id': 'mock',
          'client-request-id': 'mock',
        },
      },
    },
    headers,
  };
}

/** Graph dateTimeTimeZone of an instant ("…T10:00:00.0000000", timeZone UTC or an IANA zone). */
function dtz(ms, tz) {
  if (!tz || tz === 'UTC')
    return {
      dateTime: new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.0000000'),
      timeZone: 'UTC',
    };
  const p = Object.fromEntries(
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
      .map((x) => [x.type, x.value]),
  );
  return {
    dateTime: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.0000000`,
    timeZone: tz,
  };
}

/** Parses a Graph dateTimeTimeZone (UTC, an IANA zone, or a few Windows names) to ms. */
const WINDOWS = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Eastern Standard Time': 'America/New_York',
  'GMT Standard Time': 'Europe/London',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Egypt Standard Time': 'Africa/Cairo',
};
function parseDtz(v) {
  if (!v?.dateTime) return NaN;
  const tz = WINDOWS[v.timeZone] ?? v.timeZone ?? 'UTC';
  const local = v.dateTime.replace(/\.\d+$/, '').replace(/Z$/, '');
  if (tz === 'UTC') return Date.parse(`${local}Z`);
  // Local wall time in `tz` → instant (two passes cover DST changes).
  const guess = Date.parse(`${local}Z`);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(
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
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return ms;
}

const EP_ANY =
  /singleValueExtendedProperties\/Any\(ep:\s*ep\/id eq '([^']+)' and ep\/value eq '([^']+)'\)/i;

/**
 * @param {{ clientId: string, clientSecret: string, port?: number, tenant?: string,
 *           accounts?: { email: string, name?: string, id?: string, timeZone?: string }[],
 *           accessTokenTtlSeconds?: number, rotateRefreshTokens?: boolean }} opts
 */
export async function startMicrosoftMock(opts) {
  const oauth = new OAuthStore({
    accessTokenTtlSeconds: opts.accessTokenTtlSeconds ?? 3599,
    rotateRefreshTokens: opts.rotateRefreshTokens ?? true,
  });
  const accounts = new Map();
  const directory = new Map();
  const invitations = [];
  const consent = { deny: false, grantOnly: null };
  let loginEmail = null;
  let counter = 0;
  const nextId = (p) => `${p}${(++counter).toString(36)}${Date.now().toString(36)}`.padEnd(24, 'A');

  function addAccount(a) {
    const email = a.email.toLowerCase();
    accounts.set(email, {
      email,
      name: a.name ?? 'Mock User',
      id:
        a.id ??
        `00000000-0000-0000-${String(accounts.size + 1).padStart(4, '0')}-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
      timeZone: a.timeZone ?? 'UTC',
      messages: [],
      events: new Map(),
    });
    loginEmail ??= email;
  }
  for (const a of opts.accounts ?? [{ email: 'owner@outlook.test', name: 'Owner' }]) addAccount(a);
  const account = (email) => {
    const a = accounts.get(String(email).toLowerCase());
    if (!a) throw new Error(`mock microsoft: unknown account ${email}`);
    return a;
  };

  /* -------------------------------- Mail -------------------------------- */

  const recipient = (x) => {
    const a = parseAddress(x);
    return { emailAddress: { name: a.name ?? a.address, address: a.address } };
  };

  function addMessage(email, input) {
    const acc = account(email);
    const id = input.id ?? nextId('AAMk');
    const from = parseAddress(input.from) ?? { name: acc.name, address: acc.email };
    const folder =
      input.folder ?? (from.address.toLowerCase() === acc.email ? 'sentitems' : 'inbox');
    const m = {
      id,
      conversationId: input.conversationId ?? input.threadId ?? nextId('AAQk'),
      subject: input.subject ?? '',
      body: input.body ?? '',
      from,
      to: (input.to ?? [acc.email]).map(parseAddress),
      cc: (input.cc ?? []).map(parseAddress),
      replyTo: input.replyTo ? [parseAddress(input.replyTo)] : [],
      receivedDateTime: new Date(
        input.date ?? Date.now() - (1000 - acc.messages.length) * 1000,
      ).toISOString(),
      isRead: input.unread === undefined ? folder !== 'inbox' : !input.unread,
      isDraft: folder === 'drafts',
      folder,
      headers: input.headers ?? {},
      internetMessageId: input.internetMessageId ?? `<${id.slice(0, 16)}@outlook.test>`,
      props: input.props ?? [],
      changeKey: 'CQAAAA1',
    };
    acc.messages.push(m);
    return id;
  }

  function messageResource(m, select, expand) {
    const full = {
      '@odata.etag': `W/"${m.changeKey}"`,
      id: m.id,
      changeKey: m.changeKey,
      createdDateTime: m.receivedDateTime,
      receivedDateTime: m.receivedDateTime,
      sentDateTime: m.receivedDateTime,
      hasAttachments: false,
      internetMessageId: m.internetMessageId,
      subject: m.subject,
      bodyPreview: m.body.replace(/\s+/g, ' ').slice(0, 255),
      importance: 'normal',
      parentFolderId: m.folder,
      conversationId: m.conversationId,
      isRead: m.isRead,
      isDraft: m.isDraft,
      webLink: `https://outlook.office365.test/owa/?ItemID=${encodeURIComponent(m.id)}`,
      body: { contentType: 'text', content: m.body },
      sender: { emailAddress: { name: m.from.name ?? m.from.address, address: m.from.address } },
      from: { emailAddress: { name: m.from.name ?? m.from.address, address: m.from.address } },
      toRecipients: m.to.map(recipient),
      ccRecipients: m.cc.map(recipient),
      replyTo: m.replyTo.map(recipient),
    };
    if (select?.includes('internetmessageheaders'))
      full.internetMessageHeaders = Object.entries(m.headers).map(([name, value]) => ({
        name,
        value,
      }));
    let out = full;
    if (select && select.length) {
      out = { '@odata.etag': full['@odata.etag'], id: m.id };
      for (const k of Object.keys(full)) if (select.includes(k.toLowerCase())) out[k] = full[k];
      if (full.internetMessageHeaders) out.internetMessageHeaders = full.internetMessageHeaders;
    }
    if (expand && /singleValueExtendedProperties/i.test(expand))
      out.singleValueExtendedProperties = m.props.map((p) => ({ id: p.id, value: p.value }));
    return out;
  }

  function filterMessages(list, query) {
    let out = [...list];
    const filter = query.get('$filter') ?? '';
    const ep = EP_ANY.exec(filter);
    if (ep)
      out = out.filter((m) =>
        m.props.some((p) => p.id.toLowerCase() === ep[1].toLowerCase() && p.value === ep[2]),
      );
    if (/isRead eq false/i.test(filter)) out = out.filter((m) => !m.isRead);
    const conv = /conversationId eq '([^']+)'/i.exec(filter);
    if (conv) out = out.filter((m) => m.conversationId === conv[1]);
    const from = /from\/emailAddress\/address eq '([^']+)'/i.exec(filter);
    if (from) out = out.filter((m) => m.from.address.toLowerCase() === from[1].toLowerCase());
    const since = /receivedDateTime ge ([0-9T:.Z-]+)/i.exec(filter);
    if (since) out = out.filter((m) => m.receivedDateTime >= since[1]);
    const search = query.get('$search');
    if (search) {
      const terms = search.replace(/^"|"$/g, '').toLowerCase();
      const fromTerm = /^from:(.+)$/.exec(terms);
      out = out.filter((m) =>
        fromTerm
          ? `${m.from.name ?? ''} ${m.from.address}`.toLowerCase().includes(fromTerm[1].trim())
          : `${m.subject} ${m.body} ${m.from.address} ${m.from.name ?? ''}`
              .toLowerCase()
              .includes(terms),
      );
    }
    if (!search) out.sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
    const top = Math.min(Number(query.get('$top') ?? 10), 1000);
    return out.slice(0, top);
  }

  /* ------------------------------ Calendar ------------------------------ */

  function eventResource(acc, e, tz) {
    return {
      '@odata.etag': `W/"${e.changeKey}"`,
      id: e.id,
      changeKey: e.changeKey,
      createdDateTime: new Date(e.created).toISOString(),
      lastModifiedDateTime: new Date(e.updated).toISOString(),
      transactionId: e.transactionId ?? null,
      originalStartTimeZone: e.originalTimeZone,
      originalEndTimeZone: e.originalTimeZone,
      iCalUId: `${e.id}@outlook.test`,
      subject: e.subject,
      bodyPreview: (e.body ?? '').slice(0, 255),
      body: { contentType: 'text', content: e.body ?? '' },
      isAllDay: e.isAllDay,
      isCancelled: e.isCancelled,
      isOrganizer: e.organizer.toLowerCase() === acc.email,
      showAs: e.showAs,
      responseStatus: {
        response: e.organizer.toLowerCase() === acc.email ? 'organizer' : 'accepted',
        time: '0001-01-01T00:00:00Z',
      },
      webLink: `https://outlook.office365.test/owa/?itemid=${encodeURIComponent(e.id)}&path=/calendar/item`,
      start: dtz(e.start, tz),
      end: dtz(e.end, tz),
      location: { displayName: e.location ?? '' },
      attendees: e.attendees.map((a) => ({
        type: 'required',
        status: { response: a.response ?? 'none', time: '0001-01-01T00:00:00Z' },
        emailAddress: { name: a.email, address: a.email },
      })),
      organizer: { emailAddress: { name: e.organizer, address: e.organizer } },
      ...(e.props.length ? { singleValueExtendedProperties: e.props } : {}),
    };
  }

  function addEvent(email, input) {
    const acc = account(email);
    const id = input.id ?? nextId('AAMkEv');
    const e = {
      id,
      subject: input.title ?? input.subject ?? '',
      body: input.description ?? '',
      start: Date.parse(input.start),
      end: Date.parse(input.end),
      isAllDay: !!input.allDay,
      isCancelled: false,
      showAs: input.showAs ?? 'busy',
      location: input.location ?? null,
      attendees: (input.attendees ?? []).map((a) => (typeof a === 'string' ? { email: a } : a)),
      organizer: input.organizer ?? acc.email,
      originalTimeZone: input.originalTimeZone ?? input.timeZone ?? 'UTC',
      transactionId: input.transactionId ?? null,
      props: input.props ?? [],
      changeKey: 'DwAAABYA1',
      created: Date.now(),
      updated: Date.now(),
      version: 1,
    };
    acc.events.set(id, e);
    return id;
  }

  function busyItems(acc, min, max) {
    return [...acc.events.values()]
      .filter((e) => !e.isCancelled && e.showAs !== 'free' && overlaps(e.start, e.end, min, max))
      .map((e) => ({
        isPrivate: false,
        status: e.showAs,
        start: dtz(e.start, 'UTC'),
        end: dtz(e.end, 'UTC'),
      }));
  }

  /* ------------------------------- Routing ------------------------------- */

  function authorize(ctx, required) {
    const bearer = oauth.checkBearer(ctx.req.headers.authorization);
    ctx.record.auth = {
      scopes: bearer.ok ? bearer.scopes : null,
      required,
      account: bearer.email ?? null,
    };
    if (!bearer.ok) return { error: graphError(401) };
    if (!hasAnyScope(bearer.scopes, required, short)) return { error: graphError(403) };
    return { acc: account(bearer.email) };
  }

  const tenant = '(?<tenant>[A-Za-z0-9.-]+)';
  const routes = [
    [
      'GET',
      new RegExp(`^/${tenant}/oauth2/v2\\.0/authorize$`),
      ({ query }) => {
        const redirectUri = query.get('redirect_uri');
        if (query.get('client_id') !== opts.clientId)
          return {
            status: 400,
            body: 'AADSTS700016: Application with identifier was not found in the directory.',
          };
        if (!redirectUri)
          return { status: 400, body: 'AADSTS900144: The request body must contain redirect_uri.' };
        if (query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge'))
          return { status: 400, body: 'AADSTS9002325: Proof Key for Code Exchange is required.' };
        const location = new URL(redirectUri);
        const state = query.get('state');
        if (consent.deny) {
          location.searchParams.set('error', 'access_denied');
          location.searchParams.set(
            'error_description',
            'AADSTS65004: User declined to consent to access the app.',
          );
          if (state) location.searchParams.set('state', state);
          return { status: 302, body: null, headers: { location: location.toString() } };
        }
        const requested = (query.get('scope') ?? '').split(/\s+/).filter(Boolean);
        const granted = consent.grantOnly
          ? requested.filter(
              (s) =>
                ['openid', 'email', 'offline_access', 'profile'].includes(s) ||
                /user\.read$/i.test(s) ||
                consent.grantOnly.map(short).includes(short(s)),
            )
          : requested;
        const code = oauth.issueCode({
          clientId: query.get('client_id'),
          redirectUri,
          scopes: granted,
          challenge: query.get('code_challenge'),
          method: 'S256',
          email: (query.get('login_hint') ?? loginEmail).toLowerCase(),
        });
        location.searchParams.set('code', code);
        if (state) location.searchParams.set('state', state);
        return { status: 302, body: null, headers: { location: location.toString() } };
      },
    ],
    [
      'POST',
      new RegExp(`^/${tenant}/oauth2/v2\\.0/token$`),
      ({ body }) => {
        const f = body.form ?? {};
        const fail = (error, description, code) => ({
          status: 400,
          body: {
            error,
            error_description: `${description}\r\nTrace ID: mock\r\nCorrelation ID: mock\r\nTimestamp: ${new Date().toISOString()}`,
            error_codes: [code],
            timestamp: new Date().toISOString(),
            trace_id: 'mock',
            correlation_id: 'mock',
          },
        });
        if (f.client_id !== opts.clientId || f.client_secret !== opts.clientSecret)
          return {
            status: 401,
            body: {
              error: 'invalid_client',
              error_description: 'AADSTS7000215: Invalid client secret provided.',
              error_codes: [7000215],
            },
          };
        // Graph scopes come back in their short form (e.g. "Mail.Read User.Read"), plus the OIDC ones.
        const scopeText = (scopes) =>
          [
            ...new Set(
              scopes
                .map((s) => (s.startsWith(GRAPH) ? s.slice(GRAPH.length) : s))
                .concat('profile'),
            ),
          ].join(' ');
        if (f.grant_type === 'authorization_code') {
          oauth.grantTypes.authorization_code += 1;
          const c = oauth.codes.get(f.code);
          if (!c || c.used || c.expiresAt < Date.now())
            return fail(
              'invalid_grant',
              'AADSTS70000: The provided value for the code parameter is not valid.',
              70000,
            );
          c.used = true;
          if (c.redirectUri !== f.redirect_uri)
            return fail(
              'invalid_grant',
              'AADSTS50148: The redirect_uri does not match the one in the authorization request.',
              50148,
            );
          if (!f.code_verifier || pkceChallenge(f.code_verifier) !== c.challenge)
            return fail(
              'invalid_grant',
              'AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.',
              501481,
            );
          const access = oauth.issueAccess(c.email, c.clientId, c.scopes);
          const refresh = c.scopes.includes('offline_access')
            ? oauth.issueRefresh(c.email, c.clientId, c.scopes)
            : null;
          return {
            status: 200,
            body: {
              token_type: 'Bearer',
              scope: scopeText(c.scopes.filter((s) => s !== 'offline_access')),
              expires_in: oauth.accessTokenTtlSeconds,
              ext_expires_in: oauth.accessTokenTtlSeconds,
              access_token: access,
              ...(refresh ? { refresh_token: refresh } : {}),
              id_token: 'mock.id.token',
            },
          };
        }
        if (f.grant_type === 'refresh_token') {
          oauth.grantTypes.refresh_token += 1;
          const r = oauth.refreshTokens.get(f.refresh_token);
          if (!r || !r.valid)
            return fail(
              'invalid_grant',
              'AADSTS70008: The provided authorization code or refresh token has expired due to inactivity.',
              70008,
            );
          const access = oauth.issueAccess(r.email, r.clientId, r.scopes);
          let refresh = f.refresh_token;
          if (oauth.rotateRefreshTokens) {
            r.valid = false; // strict rotation: the old refresh token is used up
            refresh = oauth.issueRefresh(r.email, r.clientId, r.scopes);
          }
          return {
            status: 200,
            body: {
              token_type: 'Bearer',
              scope: scopeText(r.scopes.filter((s) => s !== 'offline_access')),
              expires_in: oauth.accessTokenTtlSeconds,
              ext_expires_in: oauth.accessTokenTtlSeconds,
              access_token: access,
              refresh_token: refresh,
            },
          };
        }
        return fail(
          'unsupported_grant_type',
          'AADSTS70003: The app requested an unsupported grant type.',
          70003,
        );
      },
    ],
    [
      'GET',
      /^\/v1\.0\/me$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.user);
        if (a.error) return a.error;
        return {
          status: 200,
          body: {
            '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
            id: a.acc.id,
            displayName: a.acc.name,
            mail: a.acc.email,
            userPrincipalName: a.acc.email,
          },
        };
      },
    ],
    [
      'GET',
      /^\/v1\.0\/me\/(?:mailFolders\/(?<folder>[^/]+)\/)?messages$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailRead);
        if (a.error) return a.error;
        const folder = ctx.params.folder?.toLowerCase();
        const list = a.acc.messages.filter((m) => !folder || m.folder === folder);
        const select = (ctx.query.get('$select') ?? '').toLowerCase().split(',').filter(Boolean);
        const value = filterMessages(list, ctx.query).map((m) =>
          messageResource(m, select, ctx.query.get('$expand')),
        );
        return { status: 200, body: { '@odata.context': 'mock', value } };
      },
    ],
    [
      'GET',
      /^\/v1\.0\/me\/messages\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailRead);
        if (a.error) return a.error;
        const m = a.acc.messages.find((x) => x.id === ctx.params.id);
        if (!m) return graphError(404);
        const select = (ctx.query.get('$select') ?? '').toLowerCase().split(',').filter(Boolean);
        return { status: 200, body: messageResource(m, select, ctx.query.get('$expand')) };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/messages$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailWrite);
        if (a.error) return a.error;
        const b = ctx.body.json ?? {};
        const id = addMessage(a.acc.email, {
          from: { name: a.acc.name, address: a.acc.email },
          to: (b.toRecipients ?? []).map((r) => r.emailAddress.address),
          cc: (b.ccRecipients ?? []).map((r) => r.emailAddress.address),
          subject: b.subject ?? '',
          body: b.body?.content ?? '',
          folder: 'drafts',
          props: b.singleValueExtendedProperties ?? [],
          date: Date.now(),
        });
        const m = a.acc.messages.find((x) => x.id === id);
        return {
          status: 201,
          body: messageResource(m, null, '$expand=singleValueExtendedProperties'),
        };
      },
    ],
    [
      'PATCH',
      /^\/v1\.0\/me\/messages\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailWrite);
        if (a.error) return a.error;
        const m = a.acc.messages.find((x) => x.id === ctx.params.id);
        if (!m) return graphError(404);
        const b = ctx.body.json ?? {};
        if (b.subject !== undefined) m.subject = b.subject;
        if (b.body?.content !== undefined) m.body = b.body.content;
        if (b.toRecipients) m.to = b.toRecipients.map((r) => parseAddress(r.emailAddress.address));
        if (b.ccRecipients) m.cc = b.ccRecipients.map((r) => parseAddress(r.emailAddress.address));
        if (b.singleValueExtendedProperties) m.props = b.singleValueExtendedProperties;
        if (b.isRead !== undefined) m.isRead = !!b.isRead;
        return { status: 200, body: messageResource(m, null, null) };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/messages\/(?<id>[^/]+)\/createReply$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailWrite);
        if (a.error) return a.error;
        const original = a.acc.messages.find((x) => x.id === ctx.params.id);
        if (!original) return graphError(404);
        const b = ctx.body.json ?? {};
        const target = original.replyTo[0] ?? original.from;
        const id = addMessage(a.acc.email, {
          from: { name: a.acc.name, address: a.acc.email },
          to: [target.address],
          subject: /^re:/i.test(original.subject) ? original.subject : `RE: ${original.subject}`,
          body: `${b.comment ?? ''}\n\n> ${original.body.split('\n').join('\n> ')}`,
          folder: 'drafts',
          conversationId: original.conversationId,
          date: Date.now(),
        });
        const m = a.acc.messages.find((x) => x.id === id);
        return { status: 201, body: messageResource(m, null, null) };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/messages\/(?<id>[^/]+)\/send$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailSend);
        if (a.error) return a.error;
        const m = a.acc.messages.find((x) => x.id === ctx.params.id);
        if (!m) return graphError(404);
        if (!m.isDraft)
          return graphError(400, {
            code: 'ErrorInvalidOperation',
            message: 'Item is not a draft.',
          });
        if (m.to.length === 0)
          return graphError(400, {
            code: 'ErrorInvalidRecipients',
            message: 'At least one recipient is not valid.',
          });
        // Sent: the item moves to Sent Items and gets a new id (as Exchange does).
        m.isDraft = false;
        m.folder = 'sentitems';
        m.id = nextId('AAMkSent');
        m.isRead = true;
        m.receivedDateTime = new Date().toISOString();
        for (const r of m.to) invitations.push({ kind: 'mail', to: r.address, messageId: m.id });
        return { status: 202, body: null };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/messages\/(?<id>[^/]+)\/reply$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailSend);
        if (a.error) return a.error;
        const original = a.acc.messages.find((x) => x.id === ctx.params.id);
        if (!original) return graphError(404);
        const b = ctx.body.json ?? {};
        const override = (b.message?.toRecipients ?? []).map((r) => r.emailAddress.address);
        const target = original.replyTo[0] ?? original.from;
        const to = override.length ? override : [target.address];
        const id = addMessage(a.acc.email, {
          from: { name: a.acc.name, address: a.acc.email },
          to,
          subject: /^re:/i.test(original.subject) ? original.subject : `RE: ${original.subject}`,
          body: `${b.comment ?? ''}\n\n> ${original.body.split('\n').join('\n> ')}`,
          folder: 'sentitems',
          conversationId: original.conversationId,
          props: b.message?.singleValueExtendedProperties ?? [],
          date: Date.now(),
        });
        for (const r of to) invitations.push({ kind: 'mail', to: r, messageId: id });
        return { status: 202, body: null };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/sendMail$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.mailSend);
        if (a.error) return a.error;
        const msg = ctx.body.json?.message ?? {};
        const to = (msg.toRecipients ?? []).map((r) => r.emailAddress.address);
        if (to.length === 0)
          return graphError(400, {
            code: 'ErrorInvalidRecipients',
            message: 'At least one recipient is not valid.',
          });
        const id = addMessage(a.acc.email, {
          from: { name: a.acc.name, address: a.acc.email },
          to,
          cc: (msg.ccRecipients ?? []).map((r) => r.emailAddress.address),
          subject: msg.subject ?? '',
          body: msg.body?.content ?? '',
          folder: ctx.body.json?.saveToSentItems === false ? 'none' : 'sentitems',
          props: msg.singleValueExtendedProperties ?? [],
          date: Date.now(),
        });
        for (const r of to) invitations.push({ kind: 'mail', to: r, messageId: id });
        return { status: 202, body: null };
      },
    ],
    [
      'GET',
      /^\/v1\.0\/me\/(?:calendar\/)?calendarView$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calRead);
        if (a.error) return a.error;
        const min = Date.parse(ctx.query.get('startDateTime') ?? '');
        const max = Date.parse(ctx.query.get('endDateTime') ?? '');
        if (Number.isNaN(min) || Number.isNaN(max))
          return graphError(400, {
            code: 'ErrorInvalidParameter',
            message:
              'This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.',
          });
        const prefer = String(ctx.req.headers.prefer ?? '');
        const tz = /outlook\.timezone="([^"]+)"/.exec(prefer)?.[1] ?? 'UTC';
        const top = Math.min(Number(ctx.query.get('$top') ?? 10), 1000);
        const value = [...a.acc.events.values()]
          .filter((e) => !e.isCancelled && overlaps(e.start, e.end, min, max))
          .sort((x, y) => x.start - y.start)
          .slice(0, top)
          .map((e) => eventResource(a.acc, e, tz));
        return { status: 200, body: { value } };
      },
    ],
    [
      'GET',
      /^\/v1\.0\/me\/events$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calRead);
        if (a.error) return a.error;
        const ep = EP_ANY.exec(ctx.query.get('$filter') ?? '');
        const value = [...a.acc.events.values()]
          .filter(
            (e) =>
              !ep ||
              e.props.some((p) => p.id.toLowerCase() === ep[1].toLowerCase() && p.value === ep[2]),
          )
          .map((e) => eventResource(a.acc, e, 'UTC'));
        return { status: 200, body: { value } };
      },
    ],
    [
      'GET',
      /^\/v1\.0\/me\/events\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calRead);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e) return graphError(404);
        return { status: 200, body: eventResource(a.acc, e, 'UTC') };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/events$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calWrite);
        if (a.error) return a.error;
        const b = ctx.body.json ?? {};
        if (b.transactionId) {
          const existing = [...a.acc.events.values()].find(
            (e) => e.transactionId === b.transactionId,
          );
          if (existing) return { status: 201, body: eventResource(a.acc, existing, 'UTC') };
        }
        const start = parseDtz(b.start);
        const end = parseDtz(b.end);
        if (Number.isNaN(start) || Number.isNaN(end))
          return graphError(400, { code: 'ErrorInvalidRequest', message: 'Invalid start or end.' });
        const id = addEvent(a.acc.email, {
          title: b.subject ?? '',
          description: b.body?.content ?? '',
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          allDay: !!b.isAllDay,
          location: b.location?.displayName ?? null,
          attendees: (b.attendees ?? []).map((x) => ({ email: x.emailAddress.address })),
          originalTimeZone: b.start?.timeZone ?? 'UTC',
          transactionId: b.transactionId ?? null,
          props: b.singleValueExtendedProperties ?? [],
        });
        const e = a.acc.events.get(id);
        // Graph sends meeting requests to attendees whenever an event with attendees is created.
        for (const att of e.attendees)
          invitations.push({ eventId: id, to: att.email, kind: 'invite', from: a.acc.email });
        return { status: 201, body: eventResource(a.acc, e, 'UTC') };
      },
    ],
    [
      'PATCH',
      /^\/v1\.0\/me\/events\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calWrite);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e || e.isCancelled) return graphError(404);
        const ifMatch = ctx.req.headers['if-match'];
        if (ifMatch && ifMatch !== `W/"${e.changeKey}"`) return graphError(412);
        const b = ctx.body.json ?? {};
        if (b.subject !== undefined) e.subject = b.subject;
        if (b.body?.content !== undefined) e.body = b.body.content;
        if (b.location) e.location = b.location.displayName ?? null;
        if (b.start) e.start = parseDtz(b.start);
        if (b.end) e.end = parseDtz(b.end);
        if (b.attendees) e.attendees = b.attendees.map((x) => ({ email: x.emailAddress.address }));
        e.version += 1;
        e.changeKey = `DwAAABYA${e.version}`;
        e.updated = Date.now();
        if (e.attendees.length)
          for (const att of e.attendees)
            invitations.push({ eventId: e.id, to: att.email, kind: 'update', from: a.acc.email });
        return { status: 200, body: eventResource(a.acc, e, 'UTC') };
      },
    ],
    [
      'DELETE',
      /^\/v1\.0\/me\/events\/(?<id>[^/]+)$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calWrite);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e || e.isCancelled) return graphError(404);
        const ifMatch = ctx.req.headers['if-match'];
        if (ifMatch && ifMatch !== `W/"${e.changeKey}"`) return graphError(412);
        e.isCancelled = true;
        return { status: 204, body: null };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/events\/(?<id>[^/]+)\/cancel$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calWrite);
        if (a.error) return a.error;
        const e = a.acc.events.get(ctx.params.id);
        if (!e || e.isCancelled) return graphError(404);
        if (e.organizer.toLowerCase() !== a.acc.email)
          return graphError(400, {
            code: 'ErrorAccessDenied',
            message:
              "Your request can't be completed. You need to be an organizer to cancel a meeting.",
          });
        e.isCancelled = true;
        for (const att of e.attendees)
          invitations.push({ eventId: e.id, to: att.email, kind: 'cancel', from: a.acc.email });
        return { status: 202, body: null };
      },
    ],
    [
      'POST',
      /^\/v1\.0\/me\/calendar\/getSchedule$/,
      (ctx) => {
        const a = authorize(ctx, SCOPES.calRead);
        if (a.error) return a.error;
        const b = ctx.body.json ?? {};
        const min = parseDtz(b.startTime);
        const max = parseDtz(b.endTime);
        const value = (b.schedules ?? []).map((who) => {
          const key = String(who).toLowerCase();
          if (accounts.has(key))
            return {
              scheduleId: who,
              availabilityView: '',
              scheduleItems: busyItems(accounts.get(key), min, max),
              workingHours: {},
            };
          if (directory.has(key) && directory.get(key) !== null)
            return {
              scheduleId: who,
              availabilityView: '',
              scheduleItems: directory
                .get(key)
                .filter((x) => overlaps(Date.parse(x.start), Date.parse(x.end), min, max))
                .map((x) => ({
                  isPrivate: false,
                  status: 'busy',
                  start: dtz(Date.parse(x.start), 'UTC'),
                  end: dtz(Date.parse(x.end), 'UTC'),
                })),
              workingHours: {},
            };
          return {
            scheduleId: who,
            availabilityView: '',
            scheduleItems: [],
            error: {
              message: 'The specified mailbox could not be found.',
              responseCode: 'ErrorMailRecipientNotFound',
            },
          };
        });
        return { status: 200, body: { value } };
      },
    ],
  ];

  const srv = await startServer({ port: opts.port ?? 0, routes, errorBody: (s) => graphError(s) });
  const tenantName = opts.tenant ?? 'common';

  return {
    kind: 'microsoft',
    url: srv.url,
    port: srv.port,
    issuer: `${srv.url}/${tenantName}/v2.0`,
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
    setFreeBusy(email, busy) {
      directory.set(email.toLowerCase(), busy);
    },
    messages: (email) => account(email).messages.map((m) => ({ ...m })),
    sent: (email) =>
      account(email)
        .messages.filter((m) => m.folder === 'sentitems')
        .map((m) => ({ ...m })),
    drafts: (email) =>
      account(email)
        .messages.filter((m) => m.folder === 'drafts')
        .map((m) => ({ ...m })),
    events: (email) =>
      [...account(email).events.values()].map((e) => eventResource(account(email), e, 'UTC')),
    revokeGrants: (email) => oauth.revokeAccount(email),
    expireAccessTokens: (email) => oauth.expireAccess(email),
    failNext: srv.failNext,
    clearFailures: srv.clearFailures,
    errors: {
      invalidToken: () => graphError(401),
      insufficientScope: () => graphError(403),
      rateLimited: (seconds = 30) => graphError(429, { retryAfter: seconds }),
      unavailable: (status = 503) => graphError(status),
    },
    close: srv.close,
  };
}
