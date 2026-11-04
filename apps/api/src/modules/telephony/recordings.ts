/**
 * Call recordings (docs/architecture/phase-d.md §3.2, docs/security/telephony.md §2): only when
 * the approved input asks for one AND the callee said yes on that call. The recording is started
 * at the provider only after the consent turn was stored (never from the start of the call);
 * call.recording_fetch copies the finished MP3 into the user's evidence storage (kind
 * 'recording', audio/mpeg, at most CALL_LIMITS.maxRecordingBytes; a database trigger refuses
 * it without consent) and then deletes the provider's copy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { CALL_LIMITS, EVIDENCE_MEDIA_TYPE } from '@jarvis/contracts';
import { withContext, type Db, type DbContext } from '../../db/pool';
import type { CallSessionRow } from '../../db/types';
import { evidenceStorageKey } from '../browser/evidence';
import type { ObjectStorage } from '../storage/types';
import { evidence } from '../agent/tools/types';
import type { TelephonyGateway } from './gateway';
import { TelephonyError } from './twilio/errors';

/** Starts the recording of a live call whose callee consented (once: recording_sid). */
export async function startCallRecording(
  deps: { db: Db },
  ctx: DbContext,
  gw: TelephonyGateway,
  row: CallSessionRow,
  token: string,
): Promise<string | null> {
  if (row.recording_consent !== 'accepted' || row.recording_mode === 'off' || row.recording_sid)
    return row.recording_sid;
  if (!row.provider_call_sid) return null;
  try {
    const rec = await gw.startRecording(
      row.provider_call_sid,
      gw.webhookUrl('twilioCallRecording', row.id, token),
    );
    await withContext(deps.db, ctx, (trx) =>
      trx
        .updateTable('call_sessions')
        .set({ recording_sid: rec.sid })
        .where('id', '=', row.id)
        .where('recording_sid', 'is', null)
        .where('recording_consent', '=', 'accepted')
        .execute(),
    );
    return rec.sid;
  } catch {
    // Not recorded (the call continues unrecorded; nothing is claimed).
    return null;
  }
}

export interface RecordingFetchDeps {
  db: Db;
  storage: ObjectStorage | null;
}

/**
 * Downloads a consented call's recording into evidence storage, records evidence on the step,
 * and deletes the provider's copy. Idempotent: a stored recording is not fetched again (only
 * the provider's copy is deleted). Throws to be retried (provider or storage unavailable).
 */
export async function fetchCallRecording(
  deps: RecordingFetchDeps,
  ctx: DbContext,
  gw: TelephonyGateway,
  callId: string,
  recordingSid: string,
): Promise<'stored' | 'already_stored' | 'not_consented'> {
  const row = await withContext(deps.db, ctx, (trx) =>
    trx.selectFrom('call_sessions').selectAll().where('id', '=', callId).executeTakeFirst(),
  );
  if (!row || row.recording_sid !== recordingSid || row.recording_consent !== 'accepted')
    return 'not_consented';
  const existing = await withContext(deps.db, ctx, (trx) =>
    trx
      .selectFrom('evidence_artifacts')
      .select('id')
      .where('call_session_id', '=', callId)
      .where('kind', '=', 'recording')
      .executeTakeFirst(),
  );
  if (existing) {
    await deleteAtProvider(gw, recordingSid);
    return 'already_stored';
  }
  if (!deps.storage) throw new Error('evidence storage is not configured');
  const body = await gw.fetchRecording(recordingSid, CALL_LIMITS.maxRecordingBytes);
  if (body.length === 0) throw new Error('the provider returned an empty recording');
  const id = randomUUID();
  const key = evidenceStorageKey(ctx, id);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const mediaType = EVIDENCE_MEDIA_TYPE.recording;
  await deps.storage.put(key, { body, contentType: mediaType, sha256 });
  const seconds = row.duration_seconds ?? 0;
  await withContext(deps.db, ctx, async (trx) => {
    await trx
      .insertInto('evidence_artifacts')
      .values({
        id,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: row.task_id,
        browser_session_id: null,
        call_session_id: row.id,
        kind: 'recording',
        media_type: mediaType,
        size_bytes: body.length,
        sha256,
        storage_driver: deps.storage!.driver,
        storage_key: key,
        page_url: null,
      })
      .execute();
    // The step's evidence names the stored recording (the call already ended).
    const step = await trx
      .selectFrom('task_steps')
      .select(['id', 'evidence'])
      .where('id', '=', row.step_id)
      .forUpdate()
      .executeTakeFirst();
    if (step) {
      const list = Array.isArray(step.evidence) ? step.evidence : [];
      list.push(
        evidence('record', 'Call recording', `${seconds} s, sha256 ${sha256}`, 'CALL_RECORDING', {
          artifactId: id,
          seconds,
          sha256,
        }),
      );
      await trx
        .updateTable('task_steps')
        .set({ evidence: JSON.stringify(list) })
        .where('id', '=', step.id)
        .execute();
    }
  });
  await deleteAtProvider(gw, recordingSid);
  return 'stored';
}

async function deleteAtProvider(gw: TelephonyGateway, recordingSid: string): Promise<void> {
  try {
    await gw.deleteRecording(recordingSid);
  } catch (err) {
    if (err instanceof TelephonyError && err.kind === 'not_found') return;
    throw err;
  }
}
