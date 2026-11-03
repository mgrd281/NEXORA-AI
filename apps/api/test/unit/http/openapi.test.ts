import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENTS_PATH, routes, type RouteDef } from '@jarvis/contracts';
import { buildOpenApi, isUpToDate, OUTPUT_PATH } from '../../../scripts/openapi';

type Op = {
  operationId: string;
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};
const doc = buildOpenApi() as {
  openapi: string;
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};
const opFor = (r: RouteDef) =>
  doc.paths[r.path.replace(/:(\w+)/g, '{$1}')]?.[r.method.toLowerCase()];

describe('OpenAPI document', () => {
  it('is OpenAPI 3.1 with both auth schemes', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'bearerAuth',
      'cookieAuth',
    ]);
  });

  it('describes every route of the contract table', () => {
    for (const [name, r] of Object.entries(routes) as [string, RouteDef][]) {
      const op = opFor(r);
      expect(op, name).toBeDefined();
      expect(op!.operationId).toBe(name);
      const success = String(r.successStatus ?? (r.response === null ? 204 : 200));
      expect(Object.keys(op!.responses), name).toContain(success);
      expect(!!op!.requestBody, name).toBe(!!r.body);
      // Unauthenticated routes opt out of the global security requirement.
      expect(op!.security, name).toEqual(r.auth === 'none' ? [] : undefined);
      if (r.auth !== 'none') expect(Object.keys(op!.responses), name).toContain('401');
      const headers = (op!.parameters ?? []).filter((p) => p.in === 'header').map((p) => p.name);
      expect(headers.includes('Idempotency-Key'), name).toBe(!!r.idempotent);
    }
  });

  it('describes the SSE endpoint', () => {
    const op = doc.paths[EVENTS_PATH]!.get!;
    expect(Object.keys(op.responses['200'] as object)).toContain('content');
    expect(JSON.stringify(op.responses['200'])).toContain('text/event-stream');
    expect(op.parameters!.map((p) => p.name)).toEqual(['Last-Event-ID', 'lastEventId']);
  });

  it('only references schemas that exist', () => {
    const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g)].map(
      (m) => m[1]!,
    );
    expect(refs.length).toBeGreaterThan(50);
    for (const ref of new Set(refs)) expect(doc.components.schemas, ref).toHaveProperty(ref);
  });

  it('is committed up to date (regenerate with `pnpm --filter @jarvis/api openapi`)', () => {
    expect(isUpToDate(readFileSync(OUTPUT_PATH, 'utf8'))).toBe(true);
  });
});
