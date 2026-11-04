/**
 * Validates the iOS test fixtures against the shared Zod contracts, so the Swift
 * decoding tests exercise exactly what the API sends.
 *
 *   pnpm --filter @jarvis/api exec tsx ../ios/scripts/validate-fixtures.ts
 *
 * - Each fixture in `valid` must parse with its schema AND round-trip unchanged (no
 *   unknown keys stripped, no defaults filled in).
 * - Each fixture in `unknownValues` must FAIL, and only at the paths that carry
 *   deliberately unknown enum values or union variants: it proves the app tolerates
 *   values newer than this build (the Swift tests decode them to `.unknown`).
 * - Each fixture in `olderServer` is a payload of a server before Phase B: it must parse,
 *   and the only differences after parsing are the listed contract defaults (the Swift
 *   tests check the app applies the same defaults).
 * - Phase C adds a fixture for every new schema the app decodes (providers, OAuth start and
 *   callback, calendars, email watches, orders, bookings, evidence, browser sessions, the four
 *   new approval kinds and email drafts) and newer-server variants of each new enum family.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  ApiErrorBody,
  Approval,
  Attachment,
  Booking,
  BookingConfirmation,
  BookingSlots,
  CalendarEventList,
  ConversationDetail,
  EmailMessageSummary,
  EmailThreadSummary,
  EvidenceArtifact,
  FreeBusyResult,
  HomeSnapshot,
  LoginResponse,
  Me,
  OAuthCallbackResult,
  OAuthStartResponse,
  Order,
  PreparedCart,
  ScheduleDetail,
  SchedulePreview,
  ShoppingComparison,
  StreamEvent,
  TaskDetail,
  routes,
} from '../../../packages/contracts/src/index.ts';

/** The part of a Zod schema this script uses (typed here: `zod` is not a dependency of apps/ios). */
interface Schema {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '../JarvisTests/Fixtures');

const valid: Record<string, Schema> = {
  'task-detail.json': TaskDetail,
  'task-detail-question.json': TaskDetail,
  'home-snapshot.json': HomeSnapshot,
  'api-error.json': ApiErrorBody,
  'api-error-conversation-busy.json': ApiErrorBody,
  'api-error-file-too-large.json': ApiErrorBody,
  'task-page.json': routes.listTasks.response,
  'me.json': Me,
  'login-response.json': LoginResponse,
  'approval-generic.json': Approval,
  'approval-schedule.json': Approval,
  'approval-memory.json': Approval,
  'memories-page.json': routes.listMemories.response,
  'connections.json': routes.listConnections.response,
  'sessions.json': routes.listSessions.response,
  'stream-event.json': StreamEvent,
  'stream-event-ephemeral.json': StreamEvent,
  'stream-event-conversation.json': StreamEvent,
  // Phase B
  'conversation-page.json': routes.listConversations.response,
  'conversation-detail.json': ConversationDetail,
  'attachment.json': Attachment,
  'skills.json': routes.listSkills.response,
  'schedules.json': routes.listSchedules.response,
  'schedule-detail.json': ScheduleDetail,
  'schedule-preview.json': SchedulePreview,
  'time-zones.json': routes.listTimeZones.response,
  // Phase C
  'connection-providers.json': routes.listConnectionProviders.response,
  'connections-phase-c.json': routes.listConnections.response,
  'oauth-start.json': OAuthStartResponse,
  'oauth-callback-result.json': OAuthCallbackResult,
  'calendar-upcoming.json': routes.listUpcomingEvents.response,
  'calendar-events.json': CalendarEventList,
  'email-watches.json': routes.listEmailWatches.response,
  'orders-page.json': routes.listOrders.response,
  'order.json': Order,
  'bookings-page.json': routes.listBookings.response,
  'booking.json': Booking,
  'evidence-artifact.json': EvidenceArtifact,
  'task-detail-shopping.json': TaskDetail,
  'task-detail-connection-expired.json': TaskDetail,
  'approval-purchase.json': Approval,
  'approval-calendar-event.json': Approval,
  'approval-booking.json': Approval,
  'approval-form-submission.json': Approval,
  'approval-email-draft.json': Approval,
  'home-snapshot-upcoming.json': HomeSnapshot,
  'skills-phase-c.json': routes.listSkills.response,
  'stream-event-order.json': StreamEvent,
  // Tool outputs the app models (step results), decoded leniently when a route sends them
  'free-busy-result.json': FreeBusyResult,
  'email-thread-summary.json': EmailThreadSummary,
  'email-message-summary.json': EmailMessageSummary,
  'shopping-comparison.json': ShoppingComparison,
  'prepared-cart.json': PreparedCart,
  'booking-slots.json': BookingSlots,
  'booking-confirmation.json': BookingConfirmation,
};

/** Fixtures with values newer than this build, and the only paths allowed to fail. */
const unknownValues: Record<string, { schema: Schema; paths: string[] }> = {
  'unknown-values.json': {
    schema: TaskDetail,
    paths: [
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
    ],
  },
  'unknown-values-conversation.json': {
    schema: ConversationDetail,
    paths: [
      'turns.0.type',
      'turns.1.message.kind',
      'turns.1.message.language',
      'turns.1.message.attachments.0.mediaType',
      'turns.2.task.outcome',
      'turns.2.task.question.missing.0',
    ],
  },
  'unknown-values-schedule.json': {
    schema: ScheduleDetail,
    paths: [
      'recurrence.byWeekday.1',
      'status',
      'pausedReason',
      'createdBy',
      'runs.0.status',
      'runs.0.reason',
    ],
  },
  'unknown-values-skills.json': {
    schema: routes.listSkills.response,
    paths: [
      'items.0.id',
      'items.0.status',
      'items.0.unavailableReason',
      'items.0.tools.0',
      'items.0.maxRisk',
      'items.0.requiredConnections.0',
      'items.0.modelUse',
    ],
  },
  // Phase C
  'unknown-values-connections.json': {
    schema: routes.listConnections.response,
    paths: ['items.0.provider', 'items.0.status', 'items.0.capabilities.0', 'items.0.statusReason'],
  },
  'unknown-values-commerce.json': {
    schema: Order,
    paths: ['status', 'failureReason', 'evidence.0.kind', 'evidence.0.mediaType'],
  },
  'unknown-values-phase-c.json': {
    schema: TaskDetail,
    paths: [
      'steps.0.evidence.0.code',
      'approvals.0.details.mode',
      'approvals.0.details.via',
      'approvals.1.details.action',
      'browserSessions.0.status',
      'browserSessions.0.stopReason',
    ],
  },
};

/** Payloads of a server before Phase B: parse, with exactly these contract defaults applied. */
const olderServer: Record<string, { schema: Schema; defaults: Record<string, unknown> }> = {
  'me-before-phase-b.json': {
    schema: Me,
    defaults: {
      'preferences.retention': { memoryDays: null, taskHistoryDays: null },
      'preferences.skills': { disabled: [] },
      // Phase C: purchases are off unless the user sets a limit.
      'preferences.spending.monthlyPurchaseLimitUsd': 0,
    },
  },
};

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`✗ ${msg}`);
};

/** Dotted paths where `after` differs from `before` (added or changed keys). */
function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) =>
      changedPaths(
        (before as Record<string, unknown>)[k],
        (after as Record<string, unknown>)[k],
        prefix ? `${prefix}.${k}` : k,
      ),
    );
  }
  return [prefix];
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
for (const file of files) {
  const data: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));

  const unknown = unknownValues[file];
  if (unknown) {
    const r = unknown.schema.safeParse(data);
    if (r.success) {
      fail(`${file}: expected to violate the contract, but it parsed`);
      continue;
    }
    const paths = new Set(r.error.issues.map((i) => i.path.join('.')));
    const unexpected = [...paths].filter((p) => !unknown.paths.includes(p));
    const missing = unknown.paths.filter((p) => !paths.has(p));
    if (unexpected.length || missing.length) {
      fail(
        `${file}: unexpected issue paths ${JSON.stringify(unexpected)}, missing ${JSON.stringify(missing)}`,
      );
    } else {
      console.log(`✓ ${file}: rejected only at the ${paths.size} unknown-value fields`);
    }
    continue;
  }

  const older = olderServer[file];
  if (older) {
    const r = older.schema.safeParse(data);
    if (!r.success) {
      fail(`${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    const changed = changedPaths(data, r.data);
    const expected = Object.keys(older.defaults);
    const wrong = expected.filter((path) => {
      const value = path
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], r.data);
      return !isDeepStrictEqual(value, older.defaults[path]);
    });
    if (!isDeepStrictEqual(changed.sort(), [...expected].sort()) || wrong.length) {
      fail(
        `${file}: parsing changed ${JSON.stringify(changed)}; expected only the defaults ${JSON.stringify(expected)}`,
      );
    } else {
      console.log(
        `✓ ${file}: an older server's payload parses, with only the defaults ${expected.join(', ')}`,
      );
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

for (const file of [
  ...Object.keys(valid),
  ...Object.keys(unknownValues),
  ...Object.keys(olderServer),
]) {
  if (!files.includes(file)) fail(`${file}: mapped but missing on disk`);
}

if (failures) {
  console.error(`\n${failures} fixture problem(s)`);
  process.exit(1);
}
console.log(`\nAll ${files.length} fixtures match the contracts.`);
