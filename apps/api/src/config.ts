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
});

export type StorageDriver = 'none' | 'local' | 's3';

export type Config = z.infer<typeof Env> & {
  fetchAllowPrivateHosts: Set<string>;
  isProduction: boolean;
  /** STORAGE_DRIVER resolved (see above). */
  storageDriver: StorageDriver;
  /** WEBHOOK_ALLOW_INSECURE_HOSTS parsed (host:port entries). */
  webhookAllowInsecureHosts: Set<string>;
};

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
  return { ...c, fetchAllowPrivateHosts, isProduction, storageDriver, webhookAllowInsecureHosts };
}
