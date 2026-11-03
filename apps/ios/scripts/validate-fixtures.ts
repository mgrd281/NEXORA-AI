/**
 * Validates the iOS test fixtures against the shared Zod contracts, so the Swift
 * decoding tests exercise exactly what the API sends.
 *
 *   pnpm --filter @jarvis/api exec tsx ../ios/scripts/validate-fixtures.ts
 *
 * Each fixture must parse with its schema AND round-trip unchanged (no unknown keys
 * stripped, no defaults filled in). `unknown-values.json` must FAIL, and only on the
 * fields that carry deliberately unknown enum values — it proves the app tolerates
 * values newer than this build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import {
  ApiErrorBody,
  Approval,
  HomeSnapshot,
  LoginResponse,
  Me,
  StreamEvent,
  TaskDetail,
  routes,
} from '../../../packages/contracts/src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../JarvisTests/Fixtures');

const valid: Record<string, z.ZodType> = {
  'task-detail.json': TaskDetail,
  'home-snapshot.json': HomeSnapshot,
  'api-error.json': ApiErrorBody,
  'task-page.json': routes.listTasks.response,
  'me.json': Me,
  'login-response.json': LoginResponse,
  'approval-generic.json': Approval,
  'memories-page.json': routes.listMemories.response,
  'connections.json': routes.listConnections.response,
  'sessions.json': routes.listSessions.response,
  'stream-event.json': StreamEvent,
  'stream-event-ephemeral.json': StreamEvent,
};

/** Paths that must be the only failures in unknown-values.json. */
const expectedUnknownPaths = new Set([
  'status',
  'riskLevel',
  'source',
  'planner.mode',
  'error.code',
  'steps.0.status',
  'steps.0.toolId',
  'steps.0.policy.decision',
  'steps.0.evidence.0.kind',
  'approvals.0.status',
  'approvals.0.details.kind',
  'events.0.type',
]);

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`✗ ${msg}`);
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
for (const file of files) {
  const data: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  if (file === 'unknown-values.json') {
    const r = TaskDetail.safeParse(data);
    if (r.success) {
      fail(`${file}: expected to violate the contract, but it parsed`);
      continue;
    }
    const paths = new Set(r.error.issues.map((i) => i.path.join('.')));
    const unexpected = [...paths].filter((p) => !expectedUnknownPaths.has(p));
    const missing = [...expectedUnknownPaths].filter((p) => !paths.has(p));
    if (unexpected.length || missing.length) {
      fail(`${file}: unexpected issue paths ${JSON.stringify(unexpected)}, missing ${JSON.stringify(missing)}`);
    } else {
      console.log(`✓ ${file}: rejected by TaskDetail only at the ${paths.size} unknown-value fields`);
    }
    continue;
  }
  const schema = valid[file];
  if (!schema) {
    fail(`${file}: no schema mapped — add it to validate-fixtures.ts`);
    continue;
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    fail(`${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    continue;
  }
  if (!isDeepStrictEqual(r.data, data)) {
    fail(`${file}: parses, but not exactly (unknown keys stripped or defaults applied)`);
    continue;
  }
  console.log(`✓ ${file}`);
}

for (const file of Object.keys(valid)) {
  if (!files.includes(file)) fail(`${file}: mapped but missing on disk`);
}

if (failures) {
  console.error(`\n${failures} fixture problem(s)`);
  process.exit(1);
}
console.log(`\nAll ${files.length} fixtures match the contracts.`);
