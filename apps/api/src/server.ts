import { loadConfig } from './config';
import { createDb } from './db/pool';
import { createListener } from './db/listener';
import { buildApp } from './http/app';
import { SecretBox } from './lib/crypto';
import { createAgentServices } from './modules/agent';
import { registerRoutes } from './routes';

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL);
const secrets = new SecretBox(config.SECRET_ENCRYPTION_KEY, config.SECRET_ENCRYPTION_KEY_ID);
const listener = createListener(config.DATABASE_URL, (msg, err) => console.error(msg, err));

const app = await buildApp(
  {
    config,
    db,
    secrets,
    agent: createAgentServices({ config, db, secrets }),
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
    process.exit(0);
  });
}
