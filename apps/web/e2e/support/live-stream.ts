/**
 * A real SSE server for behaviour tests: the app's EventSource connects to it (through a
 * Playwright route), and tests push contract-shaped stream events. Test code only.
 */
import { expect, type Page, type Route } from '@playwright/test';
import type { StreamEvent } from '@jarvis/contracts';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function liveStream(page: Page) {
  const clients = new Set<ServerResponse>();
  let refusing = false;
  const server = createServer((_req, res) => {
    if (refusing) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    res.on('close', () => clients.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let seq = 9000;
  return {
    /** Call after mockApi(): routes registered later take precedence. */
    async attach() {
      await page.route('**/api/v1/events*', (route: Route) =>
        route.continue({ url: `http://127.0.0.1:${port}/events` }),
      );
    },
    async connected() {
      await expect.poll(() => clients.size, { timeout: 10_000 }).toBeGreaterThan(0);
    },
    send(event: Omit<StreamEvent, 'id' | 'at'> & { at?: string }) {
      const full: StreamEvent = { id: String(seq++), at: new Date().toISOString(), ...event };
      for (const res of clients) res.write(`id: ${full.id}\ndata: ${JSON.stringify(full)}\n\n`);
    },
    /** Drops every connection (the browser reconnects with Last-Event-ID). */
    drop() {
      for (const res of clients) res.destroy();
      clients.clear();
    },
    /** While true, new connections are refused (503): the stream stays down. */
    refuse(value: boolean) {
      refusing = value;
    },
    async close() {
      for (const res of clients) res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type LiveStream = Awaited<ReturnType<typeof liveStream>>;
