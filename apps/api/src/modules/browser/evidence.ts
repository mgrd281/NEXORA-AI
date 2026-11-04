/**
 * Evidence files of the browser agent (docs/adr/0017): screenshots of the live
 * page, the data a recipe extracted (JSON) and ICS files a site sent. Stored in
 * object storage under the owner's prefix
 *   tenants/<tenant id>/users/<user id>/evidence/<artifact id>
 * (the key format evidence_artifacts' CHECK enforces), then recorded in
 * evidence_artifacts in the owner's RLS context. Deleting the row (directly,
 * or by the task / session cascade) queues the object for deletion (trigger).
 */
import { createHash, randomUUID } from 'node:crypto';
import { EVIDENCE_MEDIA_TYPE, type EvidenceArtifactKind } from '@jarvis/contracts';
import { withContext, type Db, type DbContext } from '../../db/pool';
import type { EvidenceArtifactRow } from '../../db/types';
import type { ObjectStorage } from '../storage/types';

export function evidenceStorageKey(ctx: DbContext, artifactId: string): string {
  return `tenants/${ctx.tenantId}/users/${ctx.userId}/evidence/${artifactId}`;
}

export async function storeEvidence(
  deps: { db: Db; storage: ObjectStorage },
  ctx: DbContext,
  a: {
    taskId: string;
    sessionId: string;
    kind: EvidenceArtifactKind;
    body: Buffer;
    pageUrl: string | null;
  },
): Promise<EvidenceArtifactRow> {
  const id = randomUUID();
  const key = evidenceStorageKey(ctx, id);
  const sha256 = createHash('sha256').update(a.body).digest('hex');
  const mediaType = EVIDENCE_MEDIA_TYPE[a.kind];
  await deps.storage.put(key, { body: a.body, contentType: mediaType, sha256 });
  return withContext(deps.db, ctx, (trx) =>
    trx
      .insertInto('evidence_artifacts')
      .values({
        id,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: a.taskId,
        browser_session_id: a.sessionId,
        kind: a.kind,
        media_type: mediaType,
        size_bytes: a.body.length,
        sha256,
        storage_driver: deps.storage.driver,
        storage_key: key,
        page_url: a.pageUrl ? a.pageUrl.slice(0, 2048) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}
