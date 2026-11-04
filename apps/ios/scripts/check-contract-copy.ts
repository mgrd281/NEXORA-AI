/**
 * Checks that the iPhone app mirrors the shared contracts and the server's sentences:
 *
 *   pnpm --filter @jarvis/api exec tsx ../ios/scripts/check-contract-copy.ts
 *
 * 1. Every contracts enum the app mirrors in Core/Models/Enums.swift has exactly the
 *    contract's values (plus `unknown`, the lenient fallback for newer servers).
 * 2. Every ServerMessageKey is rendered by ServerMessageText (ServerMessage.swift) as
 *    `server.<key>`, its English default value equals the server's canonical template
 *    (apps/api/src/modules/agent/i18n.ts), and the String Catalog's en/de/ar entries equal
 *    the server's en/de/ar templates (`{name}` → `%@`, or `%N$@` where German or Arabic
 *    reorder the parameters).
 * 3. Every TaskErrorReason, PolicyReason and ApiErrorReason has app copy (webhook reasons
 *    excepted: webhooks are managed on the web only).
 * 4. Every endpoint the app calls (Core/Networking/APIClient+Endpoints.swift) is a route of
 *    the contract route table with the same method, an `idempotent` route is sent with an
 *    Idempotency-Key, and every Phase B route except the web-only webhooks has an endpoint.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contracts from '../../../packages/contracts/src/index.ts';
import { SERVER_STRINGS } from '../../api/src/modules/agent/i18n.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const problems: string[] = [];
const LOCALES = ['en', 'de', 'ar'] as const;

/* 1. Enum mirrors ------------------------------------------------------------ */

const enumsSwift = read('Jarvis/Core/Models/Enums.swift');

/** Raw values of a Swift `enum Name: String, …` declared in Enums.swift. */
function swiftRawValues(name: string): string[] | null {
  const start = enumsSwift.search(new RegExp(`\\benum ${name}: String\\b`));
  if (start < 0) return null;
  const body = enumsSwift.slice(start, enumsSwift.indexOf('\n}', start));
  const values: string[] = [];
  for (const m of body.matchAll(/^\s+case (\w+)(?: = "([^"]+)")?\s*$/gm)) values.push(m[2] ?? m[1]);
  return values;
}

const mirrors: Record<string, readonly string[]> = {
  AppLocale: contracts.Locale.options,
  ThemePreference: contracts.ThemePreference.options,
  Platform: contracts.Platform.options,
  Role: contracts.Role.options,
  RiskLevel: contracts.RiskLevel.options,
  TaskStatus: contracts.TaskStatus.options,
  StepStatus: contracts.StepStatus.options,
  ApprovalStatus: contracts.ApprovalStatus.options,
  TaskSource: contracts.TaskSource.options,
  ToolId: contracts.ToolId.options,
  ConnectionProvider: contracts.ConnectionProvider.options,
  ConnectionStatus: contracts.ConnectionStatus.options,
  MemoryKind: contracts.MemoryKind.options,
  ErrorCode: contracts.ErrorCode.options,
  EventType: [...contracts.TaskEventType.options, ...contracts.AccountEventType.options],
  TaskOutcome: contracts.TaskOutcome.options,
  MissingInfo: contracts.MissingInfo.options,
  MessageKind: contracts.MessageKind.options,
  AttachmentMediaType: contracts.AttachmentMediaType.options,
  SkillId: contracts.SkillId.options,
  SkillStatus: contracts.SkillStatus.options,
  SkillUnavailableReason: contracts.SkillUnavailableReason.options,
  ScheduleFrequency: contracts.ScheduleFrequency.options,
  Weekday: contracts.Weekday.options,
  ScheduleStatus: contracts.ScheduleStatus.options,
  SchedulePauseReason: contracts.SchedulePauseReason.options,
  ScheduleRunStatus: contracts.ScheduleRunStatus.options,
  ScheduleRunReason: contracts.ScheduleRunReason.options,
};

for (const [name, expected] of Object.entries(mirrors)) {
  const actual = swiftRawValues(name);
  if (!actual) {
    problems.push(`Enums.swift: enum ${name} not found`);
    continue;
  }
  const want = new Set([...expected, 'unknown']);
  const missing = [...want].filter((v) => !actual.includes(v));
  const extra = actual.filter((v) => !want.has(v));
  if (missing.length || extra.length) {
    problems.push(
      `Enums.swift: ${name} missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
    );
  }
}

/* 2. Server messages --------------------------------------------------------- */

const messageSwift = read('Jarvis/Core/Models/ServerMessage.swift');
const catalog = JSON.parse(read('Jarvis/Resources/Localizable.xcstrings')) as {
  strings: Record<string, { localizations?: Record<string, { stringUnit?: { value?: string } }> }>;
};
const rendered = new Map<string, { localizationKey: string; defaultValue: string }>();
for (const m of messageSwift.matchAll(
  /case "([\w.]+)":\s*\n\s*text = String\(localized: "([\w.]+)", defaultValue: "((?:[^"\\]|\\.)*)"\)/g,
)) {
  rendered.set(m[1], { localizationKey: m[2], defaultValue: m[3] });
}

/** `{name}` → `%@` when the parameters keep the English order, else `%N$@`. */
function toFormat(template: string, order: string[]): string {
  const used = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const sequential = used.length === order.length && used.every((name, i) => name === order[i]);
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    sequential ? '%@' : `%${order.indexOf(name) + 1}$@`,
  );
}

const serverKeys = contracts.ServerMessageKey.options as readonly string[];
for (const key of serverKeys) {
  const entry = rendered.get(key);
  const templates = (SERVER_STRINGS as Record<string, Record<(typeof LOCALES)[number], string>>)[
    key
  ];
  if (!entry) {
    problems.push(`ServerMessage.swift: no case for ServerMessageKey "${key}"`);
    continue;
  }
  if (entry.localizationKey !== `server.${key}`) {
    problems.push(`ServerMessage.swift: "${key}" uses localization key ${entry.localizationKey}`);
  }
  const order = [...entry.defaultValue.matchAll(/\\\(p\.(\w+)\)/g)].map((m) => m[1]);
  const english = entry.defaultValue.replace(/\\\(p\.(\w+)\)/g, '{$1}').replace(/\\"/g, '"');
  if (english !== templates.en) {
    problems.push(
      `ServerMessage.swift: "${key}" default ${JSON.stringify(english)} ≠ server ${JSON.stringify(templates.en)}`,
    );
  }
  for (const locale of LOCALES) {
    const value = catalog.strings[`server.${key}`]?.localizations?.[locale]?.stringUnit?.value;
    const expected = toFormat(templates[locale], order);
    if (value !== expected) {
      problems.push(
        `Localizable.xcstrings: server.${key} [${locale}] ${JSON.stringify(value)} ≠ ${JSON.stringify(expected)}`,
      );
    }
  }
}
for (const key of rendered.keys()) {
  if (!serverKeys.includes(key))
    problems.push(`ServerMessage.swift: case "${key}" is not a ServerMessageKey`);
}

/* 3. Reason copy ------------------------------------------------------------- */

/** `case "X"` labels inside the declaration that starts at `marker` (up to its `default:`). */
function caseLabels(source: string, marker: string): Set<string> {
  const start = source.indexOf(marker);
  if (start < 0) return new Set();
  const body = source.slice(start, source.indexOf('default:', start));
  return new Set([...body.matchAll(/case "([A-Z_]+)"/g)].map((m) => m[1]));
}

const errorSwift = read('Jarvis/App/ErrorText.swift');
const eventSwift = read('Jarvis/Features/Tasks/TaskEventText.swift');
const coverage: [string, readonly string[], Set<string>][] = [
  [
    'TaskErrorText.reasonText',
    contracts.TaskErrorReason.options,
    caseLabels(errorSwift, 'static func reasonText'),
  ],
  [
    'ApiErrorReasonText.describe',
    contracts.ApiErrorReason.options.filter((r) => !r.startsWith('WEBHOOK_')),
    caseLabels(errorSwift, 'enum ApiErrorReasonText'),
  ],
  [
    'PolicyReasonText.describe',
    contracts.PolicyReason.options,
    caseLabels(eventSwift, 'enum PolicyReasonText'),
  ],
];
for (const [name, expected, actual] of coverage) {
  const missing = expected.filter((r) => !actual.has(r));
  if (missing.length) problems.push(`${name}: no copy for ${JSON.stringify(missing)}`);
}

/* 4. Endpoints ---------------------------------------------------------------- */

const endpointsSwift = read('Jarvis/Core/Networking/APIClient+Endpoints.swift');
/** The argument list of a call starting at `open` (the index of its "("). */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return '';
}
const calls: { method: string; path: string; args: string }[] = [];
for (const m of endpointsSwift.matchAll(/\b(send|upload|download)\(/g)) {
  const args = callArguments(endpointsSwift, m.index + m[0].length - 1);
  const call =
    /^\s*(?:\.(get|post|patch|delete),\s*)?"((?:[^"\\]|\\\((?:[^()]|\([^()]*\))*\))*)"/.exec(args);
  if (!call) continue;
  const method =
    m[1] === 'upload' ? 'POST' : m[1] === 'download' ? 'GET' : (call[1] ?? '').toUpperCase();
  const path = call[2].replace(/\\\(Self\.id\([^)]*\)\)/g, ':id');
  calls.push({ method, path, args });
}
const routeTable = Object.entries(contracts.routes) as [
  string,
  { method: string; path: string; tag: string; idempotent?: boolean },
][];
for (const call of calls) {
  const route = routeTable.find(([, r]) => r.method === call.method && r.path === call.path);
  if (!route) {
    problems.push(
      `APIClient+Endpoints.swift: ${call.method} ${call.path} is not in the contract route table`,
    );
  } else if (route[1].idempotent && !call.args.includes('idempotencyKey:')) {
    problems.push(
      `APIClient+Endpoints.swift: ${route[0]} is idempotent but is sent without an Idempotency-Key`,
    );
  }
}
const phaseBTags = new Set(['conversations', 'attachments', 'skills', 'schedules', 'meta']);
for (const [name, route] of routeTable) {
  if (!phaseBTags.has(route.tag)) continue;
  if (!calls.some((c) => c.method === route.method && c.path === route.path)) {
    problems.push(
      `APIClient+Endpoints.swift: no endpoint for ${name} (${route.method} ${route.path})`,
    );
  }
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `✓ ${Object.keys(mirrors).length} enums mirror the contracts; ${serverKeys.length} server messages match the API's ` +
    `en/de/ar templates; every TaskErrorReason, PolicyReason and (non-webhook) ApiErrorReason has copy; ` +
    `${calls.length} app endpoints are contract routes, and every non-webhook Phase B route has one.`,
);
