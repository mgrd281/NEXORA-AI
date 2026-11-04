import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config';

const BASE = {
  DATABASE_URL: 'postgresql://jarvis_app:x@localhost:5432/jarvis',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const PROD = { ...BASE, NODE_ENV: 'production', WEB_ORIGIN: 'https://jarvis.example' };

describe('Phase B configuration', () => {
  it('stores attachments locally in development and nowhere in production unless configured', () => {
    expect(loadConfig({ ...BASE, NODE_ENV: 'development' }).storageDriver).toBe('local');
    expect(loadConfig({ ...BASE, NODE_ENV: 'test' }).storageDriver).toBe('local');
    expect(loadConfig(PROD).storageDriver).toBe('none');
    expect(
      loadConfig({ ...PROD, STORAGE_DRIVER: 's3', S3_BUCKET: 'jarvis-files' }).storageDriver,
    ).toBe('s3');
  });

  it('refuses unsafe or incomplete storage settings', () => {
    expect(() => loadConfig({ ...PROD, STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER=local/);
    expect(() => loadConfig({ ...BASE, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(() =>
      loadConfig({ ...BASE, STORAGE_DRIVER: 's3', S3_BUCKET: 'jarvis-files', S3_SSE: 'aws:kms' }),
    ).toThrow(/S3_SSE_KMS_KEY_ID/);
    expect(() => loadConfig({ ...BASE, S3_PREFIX: '/abs' })).toThrow(/S3_PREFIX/);
    expect(loadConfig({ ...BASE, S3_PREFIX: 'jarvis/prod/' }).S3_PREFIX).toBe('jarvis/prod/');
  });

  it('allows insecure webhook hosts only outside production', () => {
    const dev = loadConfig({
      ...BASE,
      WEBHOOK_ALLOW_INSECURE_HOSTS: '127.0.0.1:4700, localhost:4701',
    });
    expect([...dev.webhookAllowInsecureHosts]).toEqual(['127.0.0.1:4700', 'localhost:4701']);
    expect(() => loadConfig({ ...PROD, WEBHOOK_ALLOW_INSECURE_HOSTS: '127.0.0.1:4700' })).toThrow(
      /WEBHOOK_ALLOW_INSECURE_HOSTS/,
    );
  });

  it('leaves observability off unless configured, and wants a long metrics token', () => {
    const c = loadConfig(BASE);
    expect(c.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(c.SENTRY_DSN).toBeUndefined();
    expect(c.METRICS_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...BASE, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });
});
