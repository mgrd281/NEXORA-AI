/**
 * Read models of the browser agent's records (docs/architecture/phase-c.md
 * §3.8, §4.5): evidence files and browser sessions. Shared by the evidence,
 * orders, bookings and task routes and the account export, so a file looks
 * identical wherever it is listed. Storage keys and drivers, recipe requests
 * and results stay server-side (the export adds request / result itself).
 */
import { buildPath, routes, type BrowserSession, type EvidenceArtifact } from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import type { BrowserSessionRow, EvidenceArtifactRow } from '../../db/types';
import { getRecipe } from '../browser/sites';

/** The columns toEvidenceArtifact reads (storage key and driver stay on the server). */
export const EVIDENCE_COLUMNS = [
  'id',
  'kind',
  'media_type',
  'size_bytes',
  'sha256',
  'page_url',
  'task_id',
  'browser_session_id',
  // Phase D: a call recording's call.
  'call_session_id',
  'created_at',
] as const;

export type EvidenceView = Pick<EvidenceArtifactRow, (typeof EVIDENCE_COLUMNS)[number]>;

/** The columns toBrowserSession reads (never request / result / worker id). */
export const BROWSER_SESSION_COLUMNS = [
  'id',
  'task_id',
  'step_id',
  'site_id',
  'operation',
  'status',
  'stop_reason',
  'handover_url',
  'navigations',
  'requests',
  'blocked_requests',
  'started_at',
  'ended_at',
  'created_at',
] as const;

export type BrowserSessionView = Pick<BrowserSessionRow, (typeof BROWSER_SESSION_COLUMNS)[number]>;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export function evidenceDownloadPath(id: string): string {
  return buildPath(routes.downloadEvidence.path, { id });
}

export function toEvidenceArtifact(row: EvidenceView): EvidenceArtifact {
  return {
    id: row.id,
    kind: row.kind,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    pageUrl: row.page_url,
    taskId: row.task_id,
    browserSessionId: row.browser_session_id,
    callSessionId: row.call_session_id,
    downloadPath: evidenceDownloadPath(row.id),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function toBrowserSession(
  row: BrowserSessionView,
  artifacts: readonly EvidenceArtifact[],
): BrowserSession {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    siteId: row.site_id,
    siteName: getRecipe(row.site_id)?.name ?? null,
    operation: row.operation,
    status: row.status,
    stopReason: row.stop_reason,
    handoverUrl: row.handover_url,
    navigations: row.navigations,
    requests: row.requests,
    blockedRequests: row.blocked_requests,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    createdAt: new Date(row.created_at).toISOString(),
    artifacts: [...artifacts],
  };
}

/**
 * The evidence files with these ids that the caller can see (RLS), by id.
 * Ids of deleted files (their task's retention ran) are simply absent.
 */
export async function loadEvidenceByIds(
  trx: Trx,
  ids: readonly (string | null)[],
): Promise<Map<string, EvidenceArtifact>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, EvidenceArtifact>();
  if (wanted.length === 0) return out;
  const rows = await trx
    .selectFrom('evidence_artifacts')
    .select(EVIDENCE_COLUMNS)
    .where('id', 'in', wanted)
    .execute();
  for (const r of rows) out.set(r.id, toEvidenceArtifact(r));
  return out;
}

/** Picks the files of `ids` (in that order) that still exist. */
export function pickEvidence(
  byId: ReadonlyMap<string, EvidenceArtifact>,
  ids: readonly (string | null)[],
): EvidenceArtifact[] {
  const seen = new Set<string>();
  const out: EvidenceArtifact[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const a = byId.get(id);
    if (a) out.push(a);
  }
  return out;
}

/** TaskDetail.browserSessions: the task's sessions, oldest first, each with its files. */
export async function loadTaskBrowserSessions(trx: Trx, taskId: string): Promise<BrowserSession[]> {
  const sessions = await trx
    .selectFrom('browser_sessions')
    .select(BROWSER_SESSION_COLUMNS)
    .where('task_id', '=', taskId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (sessions.length === 0) return [];
  const files = await trx
    .selectFrom('evidence_artifacts')
    .select(EVIDENCE_COLUMNS)
    .where('task_id', '=', taskId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const bySession = new Map<string, EvidenceArtifact[]>();
  for (const f of files) {
    if (f.browser_session_id === null) continue; // Phase D: a call recording (TaskDetail.calls)
    const list = bySession.get(f.browser_session_id) ?? [];
    list.push(toEvidenceArtifact(f));
    bySession.set(f.browser_session_id, list);
  }
  return sessions.map((s) => toBrowserSession(s, bySession.get(s.id) ?? []));
}
