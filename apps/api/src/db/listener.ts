import pg from 'pg';

type Handler = (payload: string) => void;

/**
 * One dedicated LISTEN connection per process, fanned out to in-process
 * subscribers (SSE clients, worker wake-ups). Reconnects with backoff.
 */
export function createListener(
  connectionString: string,
  log: (msg: string, err?: unknown) => void = () => {},
) {
  const subs = new Map<string, Set<Handler>>();
  let client: pg.Client | null = null;
  let connecting: Promise<pg.Client> | null = null;
  let closed = false;

  async function connect(): Promise<pg.Client> {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      let delay = 500;
      for (;;) {
        try {
          const c = new pg.Client({ connectionString });
          await c.connect();
          c.on('notification', (n) => {
            if (!n.payload) return;
            for (const h of subs.get(n.channel) ?? []) {
              try {
                h(n.payload);
              } catch (err) {
                log('listener handler failed', err);
              }
            }
          });
          c.on('error', (err) => {
            log('listener connection error', err);
            client = null;
            if (!closed) void resubscribe();
          });
          for (const ch of subs.keys()) await c.query(`LISTEN ${pg.escapeIdentifier(ch)}`);
          client = c;
          return c;
        } catch (err) {
          if (closed) throw err;
          log(`listener connect failed; retrying in ${delay}ms`, err);
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function resubscribe() {
    await connect().catch(() => undefined);
  }

  async function listen(channel: string, handler: Handler): Promise<() => Promise<void>> {
    const first = !subs.has(channel);
    const set = subs.get(channel) ?? new Set<Handler>();
    set.add(handler);
    subs.set(channel, set);
    const c = await connect();
    if (first) await c.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    return async () => {
      set.delete(handler);
    };
  }

  async function close() {
    closed = true;
    await client?.end().catch(() => undefined);
    client = null;
  }

  return { listen, close };
}
