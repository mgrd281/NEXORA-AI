import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENTS_PATH, routes, telephonyWebhookRoutes, type RouteDef } from '@jarvis/contracts';
import { buildOpenApi, isUpToDate, OUTPUT_PATH } from '../../../scripts/openapi';

type Op = {
  operationId: string;
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content?: Record<string, unknown> };
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
  it('is OpenAPI 3.1 with both auth schemes (and the telephony webhooks’ signature)', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'bearerAuth',
      'cookieAuth',
      'twilioSignature',
    ]);
  });

  it('describes the telephony webhooks as their own group, signed, never session-authenticated', () => {
    for (const [name, hook] of Object.entries(telephonyWebhookRoutes)) {
      const path = hook.path.replace(/:([A-Za-z]+)/g, '{$1}');
      const op = doc.paths[path]?.post;
      expect(op, name).toBeDefined();
      expect(op!.operationId).toBe(name);
      expect(op!.tags).toEqual(['telephony-webhooks']);
      expect(op!.security).toEqual([{ twilioSignature: [] }]);
      expect(Object.keys(op!.requestBody!.content!)).toEqual(['application/x-www-form-urlencoded']);
    }
  });

  it('describes every route of the contract table', () => {
    for (const [name, r] of Object.entries(routes) as [string, RouteDef][]) {
      const op = opFor(r);
      expect(op, name).toBeDefined();
      expect(op!.operationId).toBe(name);
      const success = String(r.successStatus ?? (r.response === null ? 204 : 200));
      expect(Object.keys(op!.responses), name).toContain(success);
      expect(!!op!.requestBody, name).toBe(!!r.body || !!r.upload);
      // Unauthenticated routes opt out of the global security requirement.
      expect(op!.security, name).toEqual(r.auth === 'none' ? [] : undefined);
      if (r.auth !== 'none') expect(Object.keys(op!.responses), name).toContain('401');
      const headers = (op!.parameters ?? []).filter((p) => p.in === 'header').map((p) => p.name);
      expect(headers.includes('Idempotency-Key'), name).toBe(!!r.idempotent);
    }
  });

  it('documents 401 for a failed login', () => {
    const op = opFor(routes.login as RouteDef)!;
    expect(Object.keys(op.responses)).toContain('401');
    expect(JSON.stringify(op.responses['401'])).toContain('email or password is incorrect');
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

  it('describes file uploads as multipart and downloads as binary', () => {
    const upload = opFor(routes.uploadAttachment as RouteDef)! as Op & {
      requestBody: { content: Record<string, { schema: { required: string[] } }> };
    };
    expect(Object.keys(upload.requestBody.content)).toEqual(['multipart/form-data']);
    expect(upload.requestBody.content['multipart/form-data']!.schema.required).toEqual(['file']);
    expect(Object.keys(upload.responses)).toEqual(expect.arrayContaining(['201', '413', '415']));
    const download = opFor(routes.downloadAttachment as RouteDef)!;
    const ok = download.responses['200'] as { content: Record<string, unknown> };
    expect(Object.keys(ok.content)).toContain('application/pdf');
    expect(JSON.stringify(ok.content)).toContain('"format":"binary"');
  });

  it('is committed up to date (regenerate with `pnpm --filter @jarvis/api openapi`)', () => {
    expect(isUpToDate(readFileSync(OUTPUT_PATH, 'utf8'))).toBe(true);
  });
});
