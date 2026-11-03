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
});

export type Config = z.infer<typeof Env> & {
  fetchAllowPrivateHosts: Set<string>;
  isProduction: boolean;
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
  if (isProduction && (fetchAllowPrivateHosts.size > 0 || c.SMTP_ALLOW_INSECURE_LOCALHOST)) {
    throw new Error(
      'FETCH_ALLOW_PRIVATE_HOSTS and SMTP_ALLOW_INSECURE_LOCALHOST are not allowed in production',
    );
  }
  if (isProduction && !c.WEB_ORIGIN.startsWith('https://')) {
    throw new Error('WEB_ORIGIN must be https in production');
  }
  return { ...c, fetchAllowPrivateHosts, isProduction };
}
