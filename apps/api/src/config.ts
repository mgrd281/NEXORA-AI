import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('127.0.0.1'),
  APP_VERSION: z.string().default('0.1.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Runtime connection — role jarvis_app (RLS enforced). */
  DATABASE_URL: z.string().url(),
  /** Migration connection — role jarvis_owner. Only needed by db:migrate and tests. */
  DATABASE_OWNER_URL: z.string().url().optional(),

  /** Public origin of the web app; cookie-authenticated mutations must come from it. */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Session lifetime in days. */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** 32-byte key, base64. Encrypts connection secrets at rest (AES-256-GCM). */
  SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  SECRET_ENCRYPTION_KEY_ID: z.string().default('k1'),

  /** Optional. Without it JARVIS runs the offline rules planner and says so in the UI. */
  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_FAST: z.string().default('claude-haiku-5-5'),
  MODEL_BALANCED: z.string().default('claude-sonnet-5-5'),
  MODEL_DEEP: z.string().default('claude-opus-5-5'),

  /**
   * Development/test only: hosts (host:port) that web.fetch may reach even though
   * they resolve to private addresses. Refused in production.
   */
  FETCH_ALLOW_PRIVATE_HOSTS: z.string().default(''),
  /** Development/test only: allow SMTP connections without TLS to localhost. */
  SMTP_ALLOW_INSECURE_LOCALHOST: bool.default(false),

  /** Approval requests expire after this many hours. */
  APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  /* ---------------------------------------------------------------- */
  /* Phase B (docs/architecture/phase-b.md §9). All optional.          */
  /* ---------------------------------------------------------------- */

  /**
   * Object storage for attachments: 'local' (a directory; development/test
   * only), 's3' (any S3-compatible service), or 'none' (uploads unavailable,
   * and the UI says so). Unset: 'local' outside production, 'none' in production.
   */
  STORAGE_DRIVER: z.enum(['none', 'local', 's3']).optional(),
  /** Directory of the local driver (created if missing). */
  STORAGE_LOCAL_DIR: z.string().min(1).default('.data/attachments'),
  S3_BUCKET: z.string().min(3).max(63).optional(),
  S3_REGION: z.string().min(1).default('eu-central-1'),
  /** For S3-compatible services (MinIO, R2, …); unset for AWS. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Deployment prefix before the per-tenant key, e.g. "jarvis/". */
  S3_PREFIX: z
    .string()
    .regex(/^(?:[A-Za-z0-9._-]+\/)*$/, 'empty, or path segments each ending in /')
    .default(''),
  /** Server-side encryption of every object (at rest). */
  S3_SSE: z.enum(['AES256', 'aws:kms']).default('AES256'),
  S3_SSE_KMS_KEY_ID: z.string().optional(),
  // Credentials come from the AWS default chain (AWS_ACCESS_KEY_ID, roles, …), never from here.

  /**
   * Development/test only: webhook hosts (host:port) that may be reached over
   * plain http and on private addresses (a local receiver). Refused in production.
   */
  WEBHOOK_ALLOW_INSECURE_HOSTS: z.string().default(''),

  /** OpenTelemetry traces are exported (OTLP/HTTP) only when this is set. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  /** Default: jarvis-api / jarvis-worker by process. */
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
  /** Errors are reported to Sentry (PII scrubbed) only when this is set. */
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  /** GET /metrics (Prometheus) is served only when this is set; send it as a bearer token. */
  METRICS_TOKEN: z.string().min(24).optional(),
  /**
   * Worker only: port of its own GET /metrics listener (same token). Unset: the
   * worker records job, tool, model and webhook metrics but nothing serves them.
   */
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** Interface of that listener; 0.0.0.0 in containers. */
  WORKER_METRICS_HOST: z.string().min(1).default('127.0.0.1'),

  /**
   * How often the worker turns due schedules into runs (ms). The default suits
   * production; end-to-end tests shorten it.
   */
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),

  /* ---------------------------------------------------------------- */
  /* Phase C (docs/architecture/phase-c.md §8). All optional.          */
  /* ---------------------------------------------------------------- */

  /**
   * OAuth 2.0 clients (confidential, server-side). Without both id and secret
   * a provider shows as "not configured on this server" and cannot be connected.
   */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  /** Microsoft identity platform authority: common, organizations, consumers, or a tenant id / domain. */
  MICROSOFT_TENANT: z
    .string()
    .regex(
      /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/,
      'common, organizations, consumers, a tenant id or a domain',
    )
    .default('common'),
  /**
   * Comma-separated redirect URIs clients may use, matched exactly (no
   * prefixes, no wildcards). Default: <WEB_ORIGIN>/connections/callback.
   * Register the same URIs with each provider. https only in production.
   */
  OAUTH_REDIRECT_URIS: z.string().optional(),
  /**
   * Development/test only (refused in production): one origin that serves
   * every Google / Microsoft endpoint path, i.e. the local mock providers
   * (tools/mock-providers). Real deployments always talk to the real hosts.
   */
  GOOGLE_BASE_URL_OVERRIDE: z.string().url().optional(),
  MICROSOFT_BASE_URL_OVERRIDE: z.string().url().optional(),
  /** Worker: how often threads watched for replies are checked for being due (ms). */
  EMAIL_WATCH_TICK_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),

  /**
   * Browser agent (src/browser-worker.ts, docs/adr/0017). The Chromium binary
   * playwright-core launches. Unset: /opt/pw-browsers/chromium outside
   * production; in production the browser worker refuses to start without it.
   */
  BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
  /** Browser sessions one browser worker runs at once. */
  BROWSER_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * Development/test only (refused in production): host:port entries the
   * browser may reach although they resolve to private addresses (fixture sites).
   */
  BROWSER_ALLOW_PRIVATE_HOSTS: z.string().default(''),
  /**
   * Development/test only (refused in production): origin of the local fixture
   * site (scripts/fixture-site.mjs); enables the fixture shop and booking recipes.
   */
  BROWSER_FIXTURE_ORIGIN: z.string().url().optional(),
  /** Comma-separated recipe ids to enable (default: every recipe whose site is available here). */
  BROWSER_SITES: z.string().optional(),
});

export type StorageDriver = 'none' | 'local' | 's3';

/** Endpoints of Google's OAuth 2.0 / OpenID Connect, Gmail API v1 and Calendar API v3. */
export interface GoogleEndpoints {
  /** RFC 9207 `iss` of authorization responses. */
  issuer: string;
  authorize: string;
  token: string;
  revoke: string;
  userinfo: string;
  /** Base of Gmail API v1, e.g. https://gmail.googleapis.com/gmail/v1 */
  gmail: string;
  /** Base of Calendar API v3, e.g. https://www.googleapis.com/calendar/v3 */
  calendar: string;
}

/** Endpoints of the Microsoft identity platform (v2.0) and Microsoft Graph v1.0. */
export interface MicrosoftEndpoints {
  issuer: string;
  authorize: string;
  token: string;
  /** Base of Microsoft Graph, e.g. https://graph.microsoft.com/v1.0 */
  graph: string;
}

export interface OAuthClient<E> {
  clientId: string;
  clientSecret: string;
  endpoints: E;
}

export type Config = z.infer<typeof Env> & {
  fetchAllowPrivateHosts: Set<string>;
  isProduction: boolean;
  /** STORAGE_DRIVER resolved (see above). */
  storageDriver: StorageDriver;
  /** WEBHOOK_ALLOW_INSECURE_HOSTS parsed (host:port entries). */
  webhookAllowInsecureHosts: Set<string>;
  /** Phase C: the configured OAuth clients (null = not configured on this server). */
  oauth: {
    google: OAuthClient<GoogleEndpoints> | null;
    microsoft: OAuthClient<MicrosoftEndpoints> | null;
  };
  /** Phase C: OAUTH_REDIRECT_URIS resolved (exact strings). */
  oauthRedirectUris: ReadonlySet<string>;
  /** Phase C: BROWSER_EXECUTABLE_PATH resolved (null: no browser on this server). */
  browserExecutablePath: string | null;
  /** Phase C: BROWSER_ALLOW_PRIVATE_HOSTS parsed (host:port entries). */
  browserAllowPrivateHosts: Set<string>;
  /** Phase C: BROWSER_SITES parsed; null = every recipe whose site is available. */
  browserSites: ReadonlySet<string> | null;
};

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Google endpoints: the real hosts, or every path on one mock origin (non-production). */
export function googleEndpoints(override?: string): GoogleEndpoints {
  if (override) {
    const o = trimSlash(override);
    return {
      issuer: o,
      authorize: `${o}/o/oauth2/v2/auth`,
      token: `${o}/token`,
      revoke: `${o}/revoke`,
      userinfo: `${o}/v1/userinfo`,
      gmail: `${o}/gmail/v1`,
      calendar: `${o}/calendar/v3`,
    };
  }
  return {
    issuer: 'https://accounts.google.com',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    gmail: 'https://gmail.googleapis.com/gmail/v1',
    calendar: 'https://www.googleapis.com/calendar/v3',
  };
}

/** Microsoft endpoints for a tenant: the real hosts, or one mock origin (non-production). */
export function microsoftEndpoints(tenant: string, override?: string): MicrosoftEndpoints {
  const login = override ? trimSlash(override) : 'https://login.microsoftonline.com';
  const graph = override ? `${trimSlash(override)}/v1.0` : 'https://graph.microsoft.com/v1.0';
  return {
    issuer: `${login}/${tenant}/v2.0`,
    authorize: `${login}/${tenant}/oauth2/v2.0/authorize`,
    token: `${login}/${tenant}/oauth2/v2.0/token`,
    graph,
  };
}

/** The development default of BROWSER_EXECUTABLE_PATH (the Playwright Chromium of the dev image). */
export const DEV_BROWSER_EXECUTABLE = '/opt/pw-browsers/chromium';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  const fetchAllowPrivateHosts = new Set(
    c.FETCH_ALLOW_PRIVATE_HOSTS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const webhookAllowInsecureHosts = new Set(
    c.WEBHOOK_ALLOW_INSECURE_HOSTS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (
    isProduction &&
    (fetchAllowPrivateHosts.size > 0 ||
      c.SMTP_ALLOW_INSECURE_LOCALHOST ||
      webhookAllowInsecureHosts.size > 0)
  ) {
    throw new Error(
      'FETCH_ALLOW_PRIVATE_HOSTS, SMTP_ALLOW_INSECURE_LOCALHOST and WEBHOOK_ALLOW_INSECURE_HOSTS are not allowed in production',
    );
  }
  if (isProduction && !c.WEB_ORIGIN.startsWith('https://')) {
    throw new Error('WEB_ORIGIN must be https in production');
  }
  const storageDriver: StorageDriver = c.STORAGE_DRIVER ?? (isProduction ? 'none' : 'local');
  if (isProduction && storageDriver === 'local') {
    throw new Error('STORAGE_DRIVER=local is for development and tests; use s3 in production');
  }
  if (storageDriver === 's3' && !c.S3_BUCKET) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET');
  }
  if (c.S3_SSE === 'aws:kms' && storageDriver === 's3' && !c.S3_SSE_KMS_KEY_ID) {
    throw new Error('S3_SSE=aws:kms needs S3_SSE_KMS_KEY_ID');
  }

  // Phase C — OAuth clients, redirect URIs, mock providers, browser agent.
  const phaseC = resolvePhaseC(c, isProduction);
  return {
    ...c,
    fetchAllowPrivateHosts,
    isProduction,
    storageDriver,
    webhookAllowInsecureHosts,
    ...phaseC,
  };
}

type PhaseCConfig = Pick<
  Config,
  | 'oauth'
  | 'oauthRedirectUris'
  | 'browserExecutablePath'
  | 'browserAllowPrivateHosts'
  | 'browserSites'
>;

/** The Phase C part of the configuration, with its production guards. */
function resolvePhaseC(c: z.infer<typeof Env>, isProduction: boolean): PhaseCConfig {
  const pair = (name: string, id?: string, secret?: string) => {
    if (!!id !== !!secret)
      throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be set together`);
    return id && secret ? { clientId: id, clientSecret: secret } : null;
  };
  if (isProduction && (c.GOOGLE_BASE_URL_OVERRIDE || c.MICROSOFT_BASE_URL_OVERRIDE)) {
    throw new Error(
      'GOOGLE_BASE_URL_OVERRIDE and MICROSOFT_BASE_URL_OVERRIDE (mock providers) are not allowed in production',
    );
  }
  const browserAllowPrivateHosts = new Set(list(c.BROWSER_ALLOW_PRIVATE_HOSTS));
  if (isProduction && (browserAllowPrivateHosts.size > 0 || c.BROWSER_FIXTURE_ORIGIN)) {
    throw new Error(
      'BROWSER_ALLOW_PRIVATE_HOSTS and BROWSER_FIXTURE_ORIGIN (fixture sites) are not allowed in production',
    );
  }
  const google = pair('GOOGLE', c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET);
  const microsoft = pair('MICROSOFT', c.MICROSOFT_CLIENT_ID, c.MICROSOFT_CLIENT_SECRET);

  const redirects = list(c.OAUTH_REDIRECT_URIS);
  const oauthRedirectUris = new Set(
    redirects.length > 0 ? redirects : [`${trimSlash(c.WEB_ORIGIN)}/connections/callback`],
  );
  for (const uri of oauthRedirectUris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new Error(`OAUTH_REDIRECT_URIS: ${uri} is not a URL`);
    }
    if (u.hash || u.username || u.password)
      throw new Error(`OAUTH_REDIRECT_URIS: ${uri} must not have a fragment or credentials`);
    if (u.protocol !== 'https:' && (isProduction || u.protocol !== 'http:'))
      throw new Error(
        `OAUTH_REDIRECT_URIS: ${uri} must be https${isProduction ? '' : ' (or http in development)'}`,
      );
  }

  return {
    oauth: {
      google: google ? { ...google, endpoints: googleEndpoints(c.GOOGLE_BASE_URL_OVERRIDE) } : null,
      microsoft: microsoft
        ? {
            ...microsoft,
            endpoints: microsoftEndpoints(c.MICROSOFT_TENANT, c.MICROSOFT_BASE_URL_OVERRIDE),
          }
        : null,
    },
    oauthRedirectUris,
    browserExecutablePath:
      c.BROWSER_EXECUTABLE_PATH ?? (isProduction ? null : DEV_BROWSER_EXECUTABLE),
    browserAllowPrivateHosts,
    browserSites: c.BROWSER_SITES === undefined ? null : new Set(list(c.BROWSER_SITES)),
  };
}

/* ------------------------------------------------------------------ */
/* Browser worker (docs/adr/0017)                                      */
/* ------------------------------------------------------------------ */

/**
 * Secrets the browser worker must never hold: with them, a compromised
 * browser process could decrypt connection tokens, call models or act as the
 * OAuth clients. In production their presence is a startup error; in
 * development (one shared .env) they are removed from process.env before any
 * browser starts (scrubBrowserWorkerEnv).
 */
export const BROWSER_WORKER_FORBIDDEN_ENV = [
  'SECRET_ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  'DATABASE_OWNER_URL',
  'METRICS_TOKEN',
] as const;

const BrowserWorkerEnv = Env.pick({
  NODE_ENV: true,
  APP_VERSION: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  STORAGE_DRIVER: true,
  STORAGE_LOCAL_DIR: true,
  S3_BUCKET: true,
  S3_REGION: true,
  S3_ENDPOINT: true,
  S3_FORCE_PATH_STYLE: true,
  S3_PREFIX: true,
  S3_SSE: true,
  S3_SSE_KMS_KEY_ID: true,
  OTEL_EXPORTER_OTLP_ENDPOINT: true,
  OTEL_SERVICE_NAME: true,
  SENTRY_DSN: true,
  SENTRY_ENVIRONMENT: true,
  BROWSER_EXECUTABLE_PATH: true,
  BROWSER_WORKER_CONCURRENCY: true,
  BROWSER_ALLOW_PRIVATE_HOSTS: true,
  BROWSER_FIXTURE_ORIGIN: true,
  BROWSER_SITES: true,
});

/** What the browser worker process is configured with: no secrets beyond its database URL. */
export type BrowserWorkerConfig = z.infer<typeof BrowserWorkerEnv> & {
  isProduction: boolean;
  storageDriver: StorageDriver;
  browserExecutablePath: string | null;
  browserAllowPrivateHosts: Set<string>;
  browserSites: ReadonlySet<string> | null;
};

export function loadBrowserWorkerConfig(env: NodeJS.ProcessEnv = process.env): BrowserWorkerConfig {
  const parsed = BrowserWorkerEnv.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid browser worker configuration:\n${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  if (isProduction) {
    const present = BROWSER_WORKER_FORBIDDEN_ENV.filter(
      (k) => env[k] !== undefined && env[k] !== '',
    );
    if (present.length > 0)
      throw new Error(
        `The browser worker must not be given ${present.join(', ')} (docs/adr/0017): remove them from its environment`,
      );
  }
  const browserAllowPrivateHosts = new Set(list(c.BROWSER_ALLOW_PRIVATE_HOSTS));
  if (isProduction && (browserAllowPrivateHosts.size > 0 || c.BROWSER_FIXTURE_ORIGIN)) {
    throw new Error(
      'BROWSER_ALLOW_PRIVATE_HOSTS and BROWSER_FIXTURE_ORIGIN (fixture sites) are not allowed in production',
    );
  }
  const storageDriver: StorageDriver = c.STORAGE_DRIVER ?? (isProduction ? 'none' : 'local');
  if (isProduction && storageDriver === 'local') {
    throw new Error('STORAGE_DRIVER=local is for development and tests; use s3 in production');
  }
  if (storageDriver === 's3' && !c.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET');
  const browserExecutablePath =
    c.BROWSER_EXECUTABLE_PATH ?? (isProduction ? null : DEV_BROWSER_EXECUTABLE);
  if (isProduction && !browserExecutablePath)
    throw new Error('BROWSER_EXECUTABLE_PATH is required for the browser worker in production');
  return {
    ...c,
    isProduction,
    storageDriver,
    browserExecutablePath,
    browserAllowPrivateHosts,
    browserSites: c.BROWSER_SITES === undefined ? null : new Set(list(c.BROWSER_SITES)),
  };
}

/**
 * Development: removes BROWSER_WORKER_FORBIDDEN_ENV from `env` (the shared
 * .env holds them) so nothing the browser worker starts can read them.
 * Returns the names it removed.
 */
export function scrubBrowserWorkerEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const k of BROWSER_WORKER_FORBIDDEN_ENV) {
    if (env[k] !== undefined) {
      delete env[k];
      removed.push(k);
    }
  }
  return removed;
}
