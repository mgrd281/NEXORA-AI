/**
 * Phase C configuration (docs/architecture/phase-c.md §8): OAuth clients,
 * exact redirect URIs, mock-provider base URLs and fixture sites refused in
 * production, and a browser worker that holds no secrets.
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_WORKER_FORBIDDEN_ENV,
  DEV_BROWSER_EXECUTABLE,
  googleEndpoints,
  loadBrowserWorkerConfig,
  loadConfig,
  microsoftEndpoints,
  scrubBrowserWorkerEnv,
} from '../../../src/config';

const BASE = {
  DATABASE_URL: 'postgresql://jarvis_app:x@localhost:5432/jarvis',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const PROD = { ...BASE, NODE_ENV: 'production', WEB_ORIGIN: 'https://jarvis.example' };

describe('OAuth clients', () => {
  it('are not configured without both id and secret', () => {
    const c = loadConfig(BASE);
    expect(c.oauth).toEqual({ google: null, microsoft: null });
    expect(() => loadConfig({ ...BASE, GOOGLE_CLIENT_ID: 'id' })).toThrow(
      /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
    );
    expect(() => loadConfig({ ...BASE, MICROSOFT_CLIENT_SECRET: 's' })).toThrow(
      /MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET/,
    );
  });

  it('use the real endpoints by default', () => {
    const c = loadConfig({
      ...PROD,
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'gs',
      MICROSOFT_CLIENT_ID: 'm',
      MICROSOFT_CLIENT_SECRET: 'ms',
    });
    expect(c.oauth.google?.endpoints).toEqual(googleEndpoints());
    expect(c.oauth.google?.endpoints.token).toBe('https://oauth2.googleapis.com/token');
    expect(c.oauth.google?.endpoints.gmail).toBe('https://gmail.googleapis.com/gmail/v1');
    expect(c.oauth.microsoft?.endpoints).toEqual(microsoftEndpoints('common'));
    expect(c.oauth.microsoft?.endpoints.authorize).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(c.oauth.microsoft?.endpoints.graph).toBe('https://graph.microsoft.com/v1.0');
  });

  it('point every endpoint at one mock origin outside production only', () => {
    const c = loadConfig({
      ...BASE,
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'gs',
      GOOGLE_BASE_URL_OVERRIDE: 'http://127.0.0.1:4610/',
      MICROSOFT_CLIENT_ID: 'm',
      MICROSOFT_CLIENT_SECRET: 'ms',
      MICROSOFT_TENANT: 'organizations',
      MICROSOFT_BASE_URL_OVERRIDE: 'http://127.0.0.1:4611',
    });
    expect(c.oauth.google?.endpoints.authorize).toBe('http://127.0.0.1:4610/o/oauth2/v2/auth');
    expect(c.oauth.google?.endpoints.calendar).toBe('http://127.0.0.1:4610/calendar/v3');
    expect(c.oauth.microsoft?.endpoints.token).toBe(
      'http://127.0.0.1:4611/organizations/oauth2/v2.0/token',
    );
    expect(c.oauth.microsoft?.endpoints.graph).toBe('http://127.0.0.1:4611/v1.0');
    for (const key of ['GOOGLE_BASE_URL_OVERRIDE', 'MICROSOFT_BASE_URL_OVERRIDE'])
      expect(() => loadConfig({ ...PROD, [key]: 'http://127.0.0.1:4610' })).toThrow(
        /not allowed in production/,
      );
  });

  it('accept only a Microsoft authority they can name', () => {
    expect(
      loadConfig({ ...BASE, MICROSOFT_TENANT: 'contoso.onmicrosoft.com' }).MICROSOFT_TENANT,
    ).toBe('contoso.onmicrosoft.com');
    expect(() => loadConfig({ ...BASE, MICROSOFT_TENANT: '../evil' })).toThrow(/MICROSOFT_TENANT/);
  });
});

describe('redirect URIs', () => {
  it('default to the web app callback, matched exactly', () => {
    expect([...loadConfig(PROD).oauthRedirectUris]).toEqual([
      'https://jarvis.example/connections/callback',
    ]);
    const c = loadConfig({
      ...PROD,
      OAUTH_REDIRECT_URIS:
        'https://jarvis.example/connections/callback, https://jarvis.example/ios/oauth',
    });
    expect(c.oauthRedirectUris.has('https://jarvis.example/ios/oauth')).toBe(true);
    expect(c.oauthRedirectUris.has('https://jarvis.example/ios/oauth/')).toBe(false);
  });

  it('must be https in production, without fragments or credentials', () => {
    expect(() =>
      loadConfig({ ...PROD, OAUTH_REDIRECT_URIS: 'http://jarvis.example/connections/callback' }),
    ).toThrow(/must be https/);
    expect(() => loadConfig({ ...BASE, OAUTH_REDIRECT_URIS: 'https://a.example/cb#x' })).toThrow(
      /fragment/,
    );
    expect(() => loadConfig({ ...BASE, OAUTH_REDIRECT_URIS: 'ftp://a.example/cb' })).toThrow(
      /https/,
    );
    expect(
      loadConfig({ ...BASE, OAUTH_REDIRECT_URIS: 'http://localhost:3000/connections/callback' })
        .oauthRedirectUris.size,
    ).toBe(1);
  });
});

describe('browser agent settings', () => {
  it('use the dev Chromium outside production and nothing by default in production', () => {
    expect(loadConfig(BASE).browserExecutablePath).toBe(DEV_BROWSER_EXECUTABLE);
    expect(loadConfig(PROD).browserExecutablePath).toBeNull();
    expect(
      loadConfig({ ...BASE, BROWSER_SITES: 'fixture-shop, fixture-booking' }).browserSites,
    ).toEqual(new Set(['fixture-shop', 'fixture-booking']));
    expect(loadConfig(BASE).browserSites).toBeNull();
  });

  it('refuse fixture sites and private hosts in production', () => {
    expect(() => loadConfig({ ...PROD, BROWSER_ALLOW_PRIVATE_HOSTS: '127.0.0.1:4599' })).toThrow(
      /not allowed in production/,
    );
    expect(() => loadConfig({ ...PROD, BROWSER_FIXTURE_ORIGIN: 'http://127.0.0.1:4599' })).toThrow(
      /not allowed in production/,
    );
    expect([
      ...loadConfig({ ...BASE, BROWSER_ALLOW_PRIVATE_HOSTS: '127.0.0.1:4599' })
        .browserAllowPrivateHosts,
    ]).toEqual(['127.0.0.1:4599']);
  });
});

describe('browser worker configuration (docs/adr/0017)', () => {
  const WORKER = { DATABASE_URL: BASE.DATABASE_URL };
  const WORKER_PROD = {
    ...WORKER,
    NODE_ENV: 'production',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'jarvis-evidence',
    BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
  };

  it('needs no secret at all', () => {
    const c = loadBrowserWorkerConfig(WORKER);
    expect(c.browserExecutablePath).toBe(DEV_BROWSER_EXECUTABLE);
    expect('SECRET_ENCRYPTION_KEY' in c).toBe(false);
    expect(loadBrowserWorkerConfig(WORKER_PROD).storageDriver).toBe('s3');
  });

  it('refuses to start in production when it can see a secret it must not hold', () => {
    for (const key of BROWSER_WORKER_FORBIDDEN_ENV)
      expect(() => loadBrowserWorkerConfig({ ...WORKER_PROD, [key]: 'x' }), key).toThrow(
        /must not be given/,
      );
  });

  it('requires an executable and refuses fixtures in production', () => {
    const { BROWSER_EXECUTABLE_PATH: _e, ...noExe } = WORKER_PROD;
    expect(() => loadBrowserWorkerConfig(noExe)).toThrow(/BROWSER_EXECUTABLE_PATH/);
    expect(() =>
      loadBrowserWorkerConfig({ ...WORKER_PROD, BROWSER_FIXTURE_ORIGIN: 'http://127.0.0.1:4599' }),
    ).toThrow(/not allowed in production/);
  });

  it('scrubs the secrets of a shared development .env', () => {
    const env: NodeJS.ProcessEnv = {
      ...WORKER,
      SECRET_ENCRYPTION_KEY: 'k',
      ANTHROPIC_API_KEY: 'a',
    };
    expect(scrubBrowserWorkerEnv(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'SECRET_ENCRYPTION_KEY',
    ]);
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBe(WORKER.DATABASE_URL);
  });
});
