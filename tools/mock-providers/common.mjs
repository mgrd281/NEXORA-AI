/**
 * Shared core of the mock OAuth / API providers (dev and tests only — never
 * imported by apps/api/src). Dependency-free Node: an HTTP server with a tiny
 * router, request recording, error injection, and an OAuth 2.0 authorization
 * server (authorization code + PKCE S256, refresh tokens, revocation) that
 * each provider mock configures with its own documented response shapes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest();
export const token = (prefix, bytes = 24) => `${prefix}${randomBytes(bytes).toString('base64url')}`;

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export const pkceChallenge = (verifier) => b64url(sha256(verifier));

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (!raw) return { raw, json: null, form: null };
  if (type.includes('application/x-www-form-urlencoded'))
    return { raw, json: null, form: Object.fromEntries(new URLSearchParams(raw)) };
  try {
    return { raw, json: JSON.parse(raw), form: null };
  } catch {
    return { raw, json: null, form: null, invalidJson: true };
  }
}

export function send(res, status, body, headers = {}) {
  if (body === undefined || body === null || status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type':
      typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a mock server. `routes` is a list of [method, RegExp, handler(ctx)];
 * a handler returns { status, body, headers } (or undefined after answering
 * itself). Every request is recorded in `requests`; `failNext` injects one or
 * more canned responses for matching requests before the routes run, and a
 * request header `X-Mock-Error: <status>` does the same per request.
 */
export async function startServer({ port = 0, host = '127.0.0.1', routes, errorBody, onRequest }) {
  const requests = [];
  const failures = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const body = await readBody(req);
    const record = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      body: body.json ?? body.form ?? (body.raw || null),
      /** Filled by the provider: the scopes of the bearer token and the scopes the endpoint required. */
      auth: null,
      status: 0,
    };
    requests.push(record);
    const finish = (status, payload, headers) => {
      record.status = status;
      send(res, status, payload, headers);
    };
    try {
      onRequest?.(record);
      const injected = failures.findIndex(
        (f) =>
          f.times > 0 &&
          (!f.method || f.method === record.method) &&
          (typeof f.path === 'string' ? record.path.includes(f.path) : f.path.test(record.path)),
      );
      if (injected >= 0) {
        const f = failures[injected];
        f.times -= 1;
        if (f.times <= 0) failures.splice(injected, 1);
        if (f.delayMs) await sleep(f.delayMs);
        if (f.passThrough) {
          // A slow but otherwise normal response.
        } else {
          return finish(f.status, f.body, f.headers);
        }
      }
      const header = req.headers['x-mock-error'];
      if (header) {
        const status = Number(header);
        const spec = errorBody(status);
        return finish(status, spec.body, spec.headers);
      }
      for (const [method, pattern, handler] of routes) {
        if (method !== record.method) continue;
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        const out = await handler({
          req,
          res,
          url,
          query: url.searchParams,
          body,
          params: m.groups ?? {},
          record,
          finish,
        });
        if (out) finish(out.status, out.body, out.headers);
        return;
      }
      finish(404, {
        error: { code: 404, message: `mock: no route for ${record.method} ${url.pathname}` },
      });
    } catch (err) {
      finish(500, { error: { code: 500, message: `mock failure: ${err?.message ?? err}` } });
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    requests,
    failNext(match, response, times = 1) {
      failures.push({
        method: match.method,
        path: match.path,
        status: response.status,
        body: response.body,
        headers: response.headers ?? {},
        delayMs: response.delayMs ?? 0,
        passThrough: response.passThrough ?? false,
        times,
      });
    },
    clearFailures() {
      failures.length = 0;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/**
 * The OAuth 2.0 state of one provider: authorization codes (single use, bound
 * to client, redirect URI and PKCE challenge), access tokens and refresh
 * tokens per (account, client) grant.
 */
export class OAuthStore {
  constructor({ accessTokenTtlSeconds = 3599, rotateRefreshTokens = false }) {
    this.accessTokenTtlSeconds = accessTokenTtlSeconds;
    this.rotateRefreshTokens = rotateRefreshTokens;
    this.codes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
    /** (account email + client id) → scopes granted so far (incremental authorization). */
    this.grants = new Map();
    this.revoked = [];
    this.grantTypes = { authorization_code: 0, refresh_token: 0 };
  }

  grantKey(email, clientId) {
    return `${email.toLowerCase()} ${clientId}`;
  }

  issueCode({ clientId, redirectUri, scopes, challenge, method, email }) {
    const code = token('code_', 18);
    this.codes.set(code, {
      clientId,
      redirectUri,
      scopes,
      challenge,
      method,
      email,
      expiresAt: Date.now() + 10 * 60_000,
      used: false,
    });
    return code;
  }

  /** Records the scopes of a new consent; `include` = also keep the earlier ones (Google include_granted_scopes). */
  recordGrant(email, clientId, scopes, include) {
    const key = this.grantKey(email, clientId);
    const before = include ? (this.grants.get(key) ?? []) : [];
    const all = [...new Set([...before, ...scopes])];
    this.grants.set(key, all);
    return all;
  }

  issueAccess(email, clientId, scopes) {
    const access = token('at_');
    this.accessTokens.set(access, {
      email,
      clientId,
      scopes,
      expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000,
      valid: true,
    });
    return access;
  }

  issueRefresh(email, clientId, scopes) {
    const refresh = token('rt_');
    this.refreshTokens.set(refresh, { email, clientId, scopes, valid: true });
    return refresh;
  }

  /** The bearer token of a request: { ok, email, scopes } or { ok: false }. */
  checkBearer(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
    if (!m) return { ok: false };
    const t = this.accessTokens.get(m[1]);
    if (!t || !t.valid || t.expiresAt <= Date.now()) return { ok: false };
    return { ok: true, email: t.email, scopes: t.scopes, clientId: t.clientId };
  }

  /** Every token of the account becomes invalid (the user revoked the app / the grant expired). */
  revokeAccount(email) {
    const e = email.toLowerCase();
    for (const t of this.accessTokens.values()) if (t.email.toLowerCase() === e) t.valid = false;
    for (const t of this.refreshTokens.values()) if (t.email.toLowerCase() === e) t.valid = false;
  }

  /** Access tokens stop working (401 invalid_token); refresh tokens keep working. */
  expireAccess(email) {
    for (const t of this.accessTokens.values())
      if (!email || t.email.toLowerCase() === email.toLowerCase()) t.valid = false;
  }
}

/** The scopes a token grants, compared the way a provider does (Graph: case-insensitive, short names). */
export function hasAnyScope(granted, required, normalize = (s) => s) {
  const g = new Set(granted.map(normalize));
  return required.some((r) => g.has(normalize(r)));
}

/** "Name <addr>" / "addr" → { name, address }. */
export function parseAddress(value) {
  if (!value) return null;
  if (typeof value === 'object') return { name: value.name ?? null, address: value.address };
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(value);
  if (m) return { name: m[1] ? m[1].trim() : null, address: m[2].trim() };
  return { name: null, address: String(value).trim() };
}

export function formatAddress(a) {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/**
 * A minimal RFC 5322 parser for messages the API sends (Gmail `raw`):
 * headers (unfolded), and a text/plain body in 7bit/8bit, base64 or
 * quoted-printable. Enough for what JARVIS writes.
 */
export function parseRfc822(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  let body = split >= 0 ? text.slice(split + 2) : '';
  const headers = {};
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (encoding === 'base64')
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  else if (encoding === 'quoted-printable')
    body = body
      .replace(/=\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return { headers, body, subject: decodeMimeWords(headers.subject ?? '') };
}

/** RFC 2047 encoded words (=?UTF-8?B?…?= / =?UTF-8?Q?…?=). */
export function decodeMimeWords(s) {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _cs, enc, data) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64').toString('utf8')
      : Buffer.from(
          data
            .replace(/_/g, ' ')
            .replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))),
          'latin1',
        ).toString('utf8'),
  );
}

export const splitList = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Overlap of [aStart, aEnd) and [bStart, bEnd) (ms). */
export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
