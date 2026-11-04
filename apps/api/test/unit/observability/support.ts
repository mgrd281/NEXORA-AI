/** Helpers for observability unit tests (no database, no network). */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { loadConfig, type Config } from '../../../src/config';
import type { Db } from '../../../src/db/pool';
import { buildApp } from '../../../src/http/app';
import type { AppDeps } from '../../../src/services';

export const METRICS_TOKEN = 'metrics-token-0123456789abcdef';

export function obsConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    STORAGE_DRIVER: 'none',
    ...overrides,
  });
}

/** A Db stand-in for code paths that must not touch the database (any use throws). */
export const NO_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      throw new Error(`database used in a unit test (${String(prop)})`);
    },
  },
) as unknown as Db;

/**
 * A Kysely instance on a scripted driver (no network): every query is
 * recorded and answered by `answer` (default: no rows).
 */
export function fakeDb(
  answer: (sqlText: string, params: readonly unknown[]) => Record<string, unknown>[] = () => [],
): { db: Db; queries: string[] } {
  const queries: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(q.sql);
      return { rows: answer(q.sql, q.parameters) as R[] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const db = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
    },
  }) as unknown as Db;
  return { db, queries };
}

/**
 * The real buildApp (all hooks, error handler, health probes, /metrics) with
 * a few test routes instead of the v1 routes, and no database.
 */
export async function testApp(
  config: Config,
  opts: { db?: Db; routes?: (app: FastifyInstance) => void } = {},
): Promise<FastifyInstance> {
  const deps = {
    config,
    db: opts.db ?? NO_DB,
    secrets: null,
    agent: null,
    storage: null,
    listen: async () => async () => {},
  } as unknown as AppDeps;
  return buildApp(deps, (app) => {
    if (opts.routes) opts.routes(app);
    else defaultRoutes(app);
  });
}

/** Routes shaped like contract routes (config.routeName), plus one that fails. */
export function defaultRoutes(app: FastifyInstance): void {
  app.get('/v1/things/:id', { config: { routeName: 'getThing' } }, async () => ({ ok: true }));
  app.get('/v1/boom', { config: { routeName: 'boom' } }, async () => {
    throw new Error('boom for someone@example.com at https://secret.example/path?q=hidden');
  });
}

/** A bare Fastify app with the same test routes and none of buildApp's hooks (benchmark baseline). */
export function bareApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  defaultRoutes(app);
  return app;
}
