import { loadConfig } from './config';
import { createDb } from './db/pool';
import { createListener } from './db/listener';
import { buildApp } from './http/app';
import { SecretBox } from './lib/crypto';
import { createAgentServices } from './modules/agent';
import { createStorage } from './modules/storage';
import { initTelemetry } from './observability';
import { registerRoutes } from './routes';

const config = loadConfig();
// First: tracing, error reporting and metrics (each only when configured) are
// running before the first request (docs/runbooks/observability.md).
const telemetry = initTelemetry(config, 'api');
await telemetry.ready;

const { db } = createDb(config.DATABASE_URL);
const secrets = new SecretBox(config.SECRET_ENCRYPTION_KEY, config.SECRET_ENCRYPTION_KEY_ID);
const storage = createStorage(config);
const listener = createListener(config.DATABASE_URL, (msg, err) => console.error(msg, err));

const app = await buildApp(
  {
    config,
    db,
    secrets,
    agent: createAgentServices({ config, db, secrets, storage }),
    storage,
    listen: listener.listen,
  },
  registerRoutes,
);

await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await listener.close();
    await db.destroy();
    // Last: flushes the final spans and error reports.
    await telemetry.shutdown();
    process.exit(0);
  });
}
