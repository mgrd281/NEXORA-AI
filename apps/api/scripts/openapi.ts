/**
 * Generates docs/api/openapi.json (OpenAPI 3.1) from the shared contract route
 * table, using Zod 4's native JSON Schema conversion. The output is
 * deterministic (no timestamps) so it can be committed and checked in CI.
 *
 *   pnpm --filter @jarvis/api openapi           # write docs/api/openapi.json
 *   pnpm --filter @jarvis/api openapi --check   # fail if the file is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import * as contracts from '@jarvis/contracts';
import {
  EVENTS_PATH,
  routes,
  telephonyWebhookRoutes,
  TWILIO_SIGNATURE_HEADER,
  type RouteDef,
  type RouteName,
  type TelephonyWebhookDef,
} from '@jarvis/contracts';

type Json = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_PATH = resolve(here, '../../../docs/api/openapi.json');
const API_VERSION = (
  JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as { version: string }
).version;

const SCHEMA_REF = (id: string) => `#/components/schemas/${id}`;
const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}');

/** Exported contract schemas that are request-side (rendered with io: 'input', inline). */
const REQUEST_SCHEMAS = new Set([
  'LoginRequest',
  'UpdateMeRequest',
  'DeleteAccountRequest',
  'CreateTaskRequest',
  'RetryTaskRequest',
  'ApprovalDecisionRequest',
  'CreateSmtpConnectionRequest',
  'CreateMemoryRequest',
  'UpdateMemoryRequest',
  'VoiceSessionStart',
  'VoiceSessionEnd',
  'PageQuery',
  'TaskListQuery',
  'MemoryListQuery',
  // Phase B
  'FollowUpRequest',
  'ConversationListQuery',
  'ConversationDetailQuery',
  'UpdateSkillRequest',
  'CreateScheduleRequest',
  'UpdateScheduleRequest',
  'SchedulePreviewRequest',
  'CreateWebhookRequest',
  'UpdateWebhookRequest',
  // Phase C
  'OAuthStartRequest',
  'OAuthCallbackRequest',
  'CalendarEventListQuery',
  'OrderListQuery',
  'BookingListQuery',
  // Phase D
  'CallListQuery',
  'ConfirmPhoneVerificationRequest',
  'PhoneCallInput',
  'TwilioVoiceForm',
  'TwilioGatherForm',
  'TwilioStatusForm',
  'TwilioAmdForm',
  'TwilioDialForm',
  'TwilioRecordingForm',
]);
/** Primitive building blocks that read better inline than as $refs. */
const INLINE_PRIMITIVES = new Set(['Id', 'Timestamp', 'MicroUsd']);

const ERROR_DESCRIPTIONS: Record<string, string> = {
  '400': 'VALIDATION_FAILED — the path, query or body is invalid.',
  '401': 'UNAUTHENTICATED — missing, expired or revoked session.',
  '402': 'BUDGET_EXCEEDED — the monthly AI budget is used up.',
  '403': 'FORBIDDEN / POLICY_DENIED — not allowed (cookie requests must come from the web origin).',
  '404': 'NOT_FOUND — does not exist or is not visible to this user.',
  '409':
    'CONFLICT / INVALID_STATE / APPROVAL_EXPIRED / APPROVAL_MISMATCH — state does not allow this.',
  '413': 'PAYLOAD_TOO_LARGE — the file is larger than the limit (details.reason FILE_TOO_LARGE).',
  '415':
    'UNSUPPORTED_MEDIA_TYPE — the content is not an accepted file type, or does not match its name (details.reason).',
  '422': 'IDEMPOTENCY_MISMATCH / CONNECTION_FAILED / FETCH_BLOCKED — semantically rejected.',
  '429': 'RATE_LIMITED — too many requests.',
  '500': 'INTERNAL — unexpected server error.',
  '503':
    'MODEL_NOT_CONFIGURED / SERVICE_UNAVAILABLE — the requested capability is unavailable (details.reason).',
};

/** Phase D: the errors of the telephony webhooks (Twilio logs them; nothing else reads them). */
const WEBHOOK_ERRORS: Record<string, string> = {
  '400': 'VALIDATION_FAILED — the path, query or form parameters are invalid.',
  '403':
    'FORBIDDEN — details.reason WEBHOOK_SIGNATURE_INVALID (no or a wrong X-Twilio-Signature, or another account).',
  '404':
    'NOT_FOUND — telephony is not configured, or no call / verification matches the id and token.',
  '415': 'UNSUPPORTED_MEDIA_TYPE — not application/x-www-form-urlencoded.',
  '429': 'RATE_LIMITED — too many requests.',
  '500': 'INTERNAL — unexpected server error.',
};

/** Route-specific error statuses beyond the generic rules. */
const EXTRA_ERRORS: Partial<Record<RouteName, string[]>> = {
  createTask: ['402', '409', '503'],
  retryTask: ['402', '409', '503'],
  cancelTask: ['409'],
  decideApproval: ['409'],
  connectSmtp: ['422'],
  testConnection: ['409', '422'],
  deleteAccount: ['403'],
  login: ['401'],
  // Phase B
  followUp: ['402', '409', '503'],
  deleteConversation: ['409'],
  uploadAttachment: ['413', '415', '503'],
  downloadAttachment: ['503'],
  updateSkill: ['409'],
  createSchedule: ['409'],
  updateSchedule: ['409'],
  pauseSchedule: ['409'],
  resumeSchedule: ['409'],
  createWebhook: ['409', '422'],
  updateWebhook: ['422'],
  testWebhook: ['409'],
  // Phase C (docs/architecture/phase-c.md §3.1, §3.3, §3.8)
  startOAuthConnection: ['404', '503'],
  completeOAuthConnection: ['409', '422', '503'],
  listCalendarEvents: ['409', '503'],
  downloadEvidence: ['503'],
  // Phase D (docs/architecture/phase-d.md §6)
  deleteDoNotCall: ['404'],
  startPhoneVerification: ['409', '503'],
  confirmPhoneVerification: ['409'],
};

/** Route-specific wording where the generic description would mislead. */
const ERROR_DESCRIPTION_OVERRIDES: Partial<Record<RouteName, Record<string, string>>> = {
  login: {
    '401': 'UNAUTHENTICATED — the email or password is incorrect, or the account is disabled.',
  },
  // Phase C
  startOAuthConnection: {
    '400':
      'VALIDATION_FAILED — invalid body, or details.reason REDIRECT_URI_NOT_ALLOWED (not exactly one of the server’s redirect URIs) / CONNECTION_NOT_OAUTH.',
    '404': 'NOT_FOUND — connectionId is not this user’s connection of that provider.',
    '429':
      'RATE_LIMITED — too many requests, or details.reason OAUTH_PENDING_LIMIT { max } (unfinished authorizations).',
    '503': 'SERVICE_UNAVAILABLE — details.reason PROVIDER_NOT_CONFIGURED { provider }.',
  },
  completeOAuthConnection: {
    '400':
      'VALIDATION_FAILED — invalid body, or details.reason OAUTH_STATE_INVALID (unknown, used, or started by another session; wrong iss) / OAUTH_STATE_EXPIRED / OAUTH_DENIED { provider } / OAUTH_SCOPE_NOT_GRANTED { capabilities }.',
    '409':
      'CONFLICT — details.reason OAUTH_ACCOUNT_MISMATCH { provider } (signed in to another account than the connected one).',
    '422': 'CONNECTION_FAILED — details.reason OAUTH_EXCHANGE_FAILED { provider }.',
    '503': 'SERVICE_UNAVAILABLE — details.reason PROVIDER_NOT_CONFIGURED { provider }.',
  },
  listCalendarEvents: {
    '400': `VALIDATION_FAILED — invalid query, or a window whose “to” is not after “from” or that is wider than ${contracts.CALENDAR_LIMITS.listMaxDays} days.`,
    '409':
      'CONNECTION_REQUIRED — details.reason CALENDAR_NOT_CONNECTED (no active calendar connection).',
    '503':
      'SERVICE_UNAVAILABLE — details.reason CALENDAR_UNAVAILABLE { provider } (no calendar answered).',
  },
  downloadEvidence: {
    '503':
      'SERVICE_UNAVAILABLE — details.reason EVIDENCE_NOT_AVAILABLE (stored by another storage driver, or no storage) / STORAGE_UNAVAILABLE.',
  },
  // Phase D
  updateMe: {
    '400':
      'VALIDATION_FAILED — invalid body, or details.reason PHONE_NUMBER_INVALID (not a valid number) / CALL_DESTINATION_BLOCKED (a premium-rate or similar number).',
  },
  startPhoneVerification: {
    '400':
      'VALIDATION_FAILED — details.reason CALL_DESTINATION_BLOCKED { country } (a country this server does not call).',
    '409':
      'INVALID_STATE — details.reason PHONE_NUMBER_REQUIRED (no number on the account) / PHONE_ALREADY_VERIFIED.',
    '429': `RATE_LIMITED — too many requests, or details.reason PHONE_VERIFICATION_LIMIT { max } (${contracts.CALL_LIMITS.verificationMaxPerDay} verification calls a day).`,
    '503': 'SERVICE_UNAVAILABLE — details.reason TELEPHONY_NOT_CONFIGURED.',
  },
  confirmPhoneVerification: {
    '400':
      'VALIDATION_FAILED — invalid body, or details.reason PHONE_VERIFICATION_INVALID { attemptsLeft } / PHONE_VERIFICATION_EXPIRED.',
    '409': 'INVALID_STATE — details.reason PHONE_NUMBER_REQUIRED (the number changed meanwhile).',
  },
};

/** Removes JSON-Schema noise that OpenAPI consumers do not need. */
function tidy(node: unknown, top = true): unknown {
  if (Array.isArray(node)) return node.map((n) => tidy(n, false));
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  const obj = node as Json;
  for (const [k, v] of Object.entries(obj)) {
    if (top && (k === '$schema' || k === '$id')) continue;
    // Zod adds exhaustive regexes next to standard formats; the format says it all.
    if (k === 'pattern' && ['uuid', 'date-time', 'email'].includes(obj.format as string)) continue;
    if ((k === 'minimum' || k === 'maximum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER)
      continue;
    out[k] = tidy(v, false);
  }
  return out;
}

function inputSchema(schema: z.ZodType): Json {
  return tidy(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as Json;
}

export function buildOpenApi(): Json {
  const exported = Object.entries(contracts as Record<string, unknown>).filter(
    (e): e is [string, z.ZodType] => e[1] instanceof z.ZodType,
  );
  const nameOf = new Map<z.ZodType, string>(exported.map(([n, s]) => [s, n]));

  // Response-side named components (with $refs between them).
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of exported) {
    if (!REQUEST_SCHEMAS.has(name) && !INLINE_PRIMITIVES.has(name))
      registry.add(schema, { id: name });
  }
  const requestComponents: Record<string, Json> = {};
  const responseRef = (route: string, schema: z.ZodType): string => {
    const existing = registry.get(schema)?.id;
    if (existing) return existing;
    const id = `${pascal(route)}Response`;
    registry.add(schema, { id });
    return id;
  };
  const requestRef = (route: string, schema: z.ZodType): string => {
    const name = nameOf.get(schema) ?? `${pascal(route)}Request`;
    requestComponents[name] ??= inputSchema(schema);
    return name;
  };

  const paths: Record<string, Record<string, Json>> = {};
  for (const [name, route] of Object.entries(routes) as [RouteName, RouteDef][]) {
    const parameters: Json[] = [];
    if (route.params) {
      for (const [param, schema] of Object.entries(route.params.shape))
        parameters.push({
          name: param,
          in: 'path',
          required: true,
          schema: inputSchema(schema as z.ZodType),
        });
    }
    if (route.query) {
      const q = inputSchema(route.query) as {
        properties?: Record<string, Json>;
        required?: string[];
      };
      for (const [param, schema] of Object.entries(q.properties ?? {}))
        parameters.push({
          name: param,
          in: 'query',
          required: q.required?.includes(param) ?? false,
          schema,
        });
    }
    if (route.idempotent) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description:
          'Client-generated key (8–128 chars). A repeated request with the same key and body replays the first response; a different body is rejected with IDEMPOTENCY_MISMATCH.',
        schema: { type: 'string', minLength: 8, maxLength: 128 },
      });
    }

    const status = String(route.successStatus ?? (route.response === null ? 204 : 200));
    const responses: Record<string, Json> = {};
    if (route.download) {
      // A file streamed to its owner, not JSON.
      responses[status] = {
        description: 'The file',
        headers: {
          'Content-Disposition': {
            description: 'attachment; filename="…" (RFC 6266, UTF-8 filename*)',
            schema: { type: 'string' },
          },
          'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
        },
        content: Object.fromEntries(
          route.download.mediaTypes.map((t) => [
            t,
            { schema: { type: 'string', format: 'binary' } },
          ]),
        ),
      };
    } else if (route.response === null) {
      responses[status] = { description: 'No Content' };
    } else {
      responses[status] = {
        description: status === '202' ? 'Accepted' : status === '201' ? 'Created' : 'OK',
        content: {
          'application/json': { schema: { $ref: SCHEMA_REF(responseRef(name, route.response)) } },
        },
      };
    }
    if (name === 'exportAccount') {
      responses[status]!.headers = {
        'Content-Disposition': {
          description: 'attachment; filename="jarvis-export-YYYY-MM-DD.json"',
          schema: { type: 'string' },
        },
      };
    }

    const errors = new Set<string>(['429', '500']);
    if (route.params || route.query || route.body || route.upload) errors.add('400');
    if (route.auth !== 'none') errors.add('401');
    if (route.auth === 'platform_admin' || (route.auth === 'user' && route.method !== 'GET'))
      errors.add('403');
    if (route.params) errors.add('404');
    if (route.idempotent) {
      errors.add('409');
      errors.add('422');
    }
    for (const e of EXTRA_ERRORS[name] ?? []) errors.add(e);
    for (const code of [...errors].sort()) {
      responses[code] = {
        description: ERROR_DESCRIPTION_OVERRIDES[name]?.[code] ?? ERROR_DESCRIPTIONS[code]!,
        content: { 'application/json': { schema: { $ref: SCHEMA_REF('ApiErrorBody') } } },
      };
    }

    const op: Json = {
      operationId: name,
      summary: route.summary,
      tags: [route.tag],
      ...(route.auth === 'none' ? { security: [] } : {}),
      ...(route.auth === 'platform_admin'
        ? {
            description:
              'Requires the platform_admin role. Returns aggregates only — never user content.',
          }
        : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: SCHEMA_REF(requestRef(name, route.body)) },
                },
              },
            },
          }
        : {}),
      ...(route.upload
        ? {
            requestBody: {
              required: true,
              description: `One file, at most ${route.upload.maxBytes} bytes. The type is identified from the content; the file name's extension must agree.`,
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    properties: { [route.upload.field]: { type: 'string', format: 'binary' } },
                    required: [route.upload.field],
                  },
                  encoding: {
                    [route.upload.field]: { contentType: route.upload.mediaTypes.join(', ') },
                  },
                },
              },
            },
          }
        : {}),
      responses,
    };
    const path = toOpenApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = op;
  }

  // Server-Sent Events: described by hand (not part of the JSON route table).
  paths[EVENTS_PATH] = {
    get: {
      operationId: 'streamEvents',
      summary: 'Real-time event stream (Server-Sent Events)',
      tags: ['events'],
      description: [
        'Streams the signed-in user’s task, notification and connection events as text/event-stream.',
        'The stream starts with `retry: 3000`. Each event is framed as',
        '`id: <id>\\nevent: message\\ndata: <StreamEvent JSON>\\n\\n`; ephemeral events',
        '(e.g. `task.answer.delta`) omit `id:` and are never replayed. A `: heartbeat` comment',
        'is sent every 25 s. To resume, reconnect with `Last-Event-ID` (or `?lastEventId=`):',
        'up to the 200 newest persisted events after that id are replayed before live delivery.',
        'The `data:` payload of every frame is a StreamEvent (`x-sse-data`).',
        'The stream ends as soon as its session is signed out, revoked or expires, or the account',
        'is disabled or deleted; reconnecting then gets 401.',
      ].join(' '),
      parameters: [
        {
          name: 'Last-Event-ID',
          in: 'header',
          required: false,
          description: 'Resume after this event id.',
          schema: { type: 'string', pattern: '^\\d{1,15}$' },
        },
        {
          name: 'lastEventId',
          in: 'query',
          required: false,
          description: 'Alternative to the Last-Event-ID header for clients that cannot set it.',
          schema: { type: 'string', pattern: '^\\d{1,15}$' },
        },
      ],
      responses: {
        '200': {
          description: 'Event stream',
          content: {
            'text/event-stream': {
              schema: { type: 'string' },
              'x-sse-data': { $ref: SCHEMA_REF('StreamEvent') },
            },
          },
        },
        '401': {
          description: ERROR_DESCRIPTIONS['401'],
          content: { 'application/json': { schema: { $ref: SCHEMA_REF('ApiErrorBody') } } },
        },
        '429': {
          description: ERROR_DESCRIPTIONS['429'],
          content: { 'application/json': { schema: { $ref: SCHEMA_REF('ApiErrorBody') } } },
        },
      },
    },
  };

  // Phase D: the telephony provider's webhooks — a separate route group (no session; every
  // request carries X-Twilio-Signature and the call's URL token), never called by clients.
  for (const [name, hook] of Object.entries(telephonyWebhookRoutes) as [
    string,
    TelephonyWebhookDef,
  ][]) {
    const parameters: Json[] = [];
    for (const [param, schema] of Object.entries(hook.params.shape))
      parameters.push({
        name: param,
        in: 'path',
        required: true,
        schema: inputSchema(schema as z.ZodType),
      });
    const q = inputSchema(hook.query) as { properties?: Record<string, Json>; required?: string[] };
    for (const [param, schema] of Object.entries(q.properties ?? {}))
      parameters.push({
        name: param,
        in: 'query',
        required: q.required?.includes(param) ?? false,
        description:
          param === 't'
            ? 'The call’s URL token (random, stored only as a hash): selects the owner of the call.'
            : 'The turn this answer belongs to (processed once).',
        schema,
      });
    const errors = (codes: string[]) =>
      Object.fromEntries(
        codes.map((code) => [
          code,
          {
            description: WEBHOOK_ERRORS[code]!,
            content: { 'application/json': { schema: { $ref: SCHEMA_REF('ApiErrorBody') } } },
          },
        ]),
      );
    const path = toOpenApiPath(hook.path);
    paths[path] ??= {};
    paths[path][hook.method.toLowerCase()] = {
      operationId: name,
      summary: hook.summary,
      tags: ['telephony-webhooks'],
      description:
        'Called by Twilio only. Authenticated by X-Twilio-Signature (base64 HMAC-SHA1 of PUBLIC_WEBHOOK_BASE_URL + path + query followed by every form parameter name and value sorted by name, keyed with the account’s auth token) and the call’s URL token — not by a session.',
      security: [{ twilioSignature: [] }],
      parameters,
      requestBody: {
        required: true,
        content: {
          'application/x-www-form-urlencoded': {
            schema: { $ref: SCHEMA_REF(requestRef(name, hook.form)) },
          },
        },
      },
      responses: {
        ...(hook.responds === 'twiml'
          ? {
              '200': {
                description: 'TwiML',
                content: { 'text/xml': { schema: { type: 'string' } } },
              },
            }
          : { '204': { description: 'No Content' } }),
        ...errors(['400', '403', '404', '415', '429', '500']),
      },
    };
  }

  // Liveness / readiness probes (unauthenticated, no data).
  paths['/healthz'] = {
    get: {
      operationId: 'healthz',
      summary: 'Liveness probe',
      tags: ['system'],
      security: [],
      responses: {
        '200': {
          description: 'Process is up',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { const: true } },
                required: ['ok'],
              },
            },
          },
        },
      },
    },
  };
  paths['/readyz'] = {
    get: {
      operationId: 'readyz',
      summary: 'Readiness probe (database reachable)',
      tags: ['system'],
      security: [],
      responses: Object.fromEntries(
        ['200', '503'].map((code) => [
          code,
          {
            description: code === '200' ? 'Ready' : 'Database unreachable',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' }, database: { type: 'boolean' } },
                  required: ['ok', 'database'],
                },
              },
            },
          },
        ]),
      ),
    },
  };

  const generated = z.toJSONSchema(registry, {
    io: 'output',
    uri: SCHEMA_REF,
    unrepresentable: 'any',
  }) as { schemas: Record<string, unknown> };
  const schemas: Record<string, unknown> = {};
  for (const [id, schema] of Object.entries({ ...generated.schemas, ...requestComponents }).sort(
    ([a], [b]) => a.localeCompare(b),
  ))
    schemas[id] = tidy(schema);

  const tags = [
    ...new Set([
      ...Object.values(routes).map((r) => r.tag),
      'events',
      'system',
      'telephony-webhooks',
    ]),
  ];
  return {
    openapi: '3.1.0',
    info: {
      title: 'JARVIS API',
      version: API_VERSION,
      description:
        'HTTP API v1 of JARVIS. Native clients authenticate with a bearer token from POST /v1/auth/login; the web app uses an httpOnly session cookie, and cookie-authenticated state changes must carry Origin = the web app origin. Errors use the ApiErrorBody shape. Money is integer micro-USD.',
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    tags: tags.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Opaque session token returned to native clients by POST /v1/auth/login.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'jarvis_session',
          description:
            'httpOnly session cookie set for the web client. Mutations must send the web app Origin.',
        },
        twilioSignature: {
          type: 'apiKey',
          in: 'header',
          name: TWILIO_SIGNATURE_HEADER,
          description:
            'Telephony webhooks only: Twilio’s request signature, validated against the configured auth token.',
        },
      },
      schemas,
    },
  };
}

export function renderOpenApi(): string {
  return `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
}

/** Formats like `prettier --write` would, so the committed file passes format checks. */
async function formatLikeRepo(json: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(OUTPUT_PATH)) ?? {};
    return await prettier.format(json, { ...options, parser: 'json', filepath: OUTPUT_PATH });
  } catch {
    return json; // prettier unavailable: plain JSON is still valid output
  }
}

/** Semantic comparison: formatting differences never count as stale. */
export function isUpToDate(fileContent: string): boolean {
  try {
    return JSON.stringify(JSON.parse(fileContent)) === JSON.stringify(buildOpenApi());
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      current = '';
    }
    if (!isUpToDate(current)) {
      console.error(`${OUTPUT_PATH} is out of date. Run: pnpm --filter @jarvis/api openapi`);
      process.exit(1);
    }
    console.log('openapi.json is up to date');
  } else {
    const doc = buildOpenApi();
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, await formatLikeRepo(renderOpenApi()));
    const ops = Object.values(doc.paths as Record<string, object>).reduce<number>(
      (n, p) => n + Object.keys(p).length,
      0,
    );
    console.log(`wrote ${OUTPUT_PATH} (${ops} operations)`);
  }
}
