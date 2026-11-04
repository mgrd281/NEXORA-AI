/**
 * Evidence files of the browser agent (docs/architecture/phase-c.md §3.8):
 * metadata and download. Owner only by construction — session auth plus an
 * RLS-scoped lookup (404 for anyone else). Files are served as attachments
 * that a browser never renders in the app's origin: nosniff, a sandboxing
 * CSP and no caching (screenshots can show personal data).
 */
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import type { EvidenceArtifactKind } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { storageUnavailable } from '../attachments/routes';
import { StorageNotFoundError, StorageUnavailableError } from '../storage/types';
import { EVIDENCE_COLUMNS, toEvidenceArtifact } from './mappers';

const EXTENSION: Record<EvidenceArtifactKind, string> = {
  screenshot: 'png',
  extract: 'json',
  ics: 'ics',
};

/** The file cannot be served by this server (no storage, or stored with another driver). */
export const evidenceNotAvailable = () =>
  new AppError('SERVICE_UNAVAILABLE', 'This evidence file is not available on this server.', {
    reason: 'EVIDENCE_NOT_AVAILABLE',
  });

/** A fixed, ASCII-only file name: nothing from the page or the site ends up in a header. */
export function evidenceFilename(id: string, kind: EvidenceArtifactKind): string {
  return `jarvis-evidence-${id}.${EXTENSION[kind]}`;
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'getEvidence', async ({ ctx, params }) => {
    const row = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('evidence_artifacts')
        .select(EVIDENCE_COLUMNS)
        .where('id', '=', params.id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Evidence');
    return toEvidenceArtifact(row);
  });

  defineRoute(app, deps, 'downloadEvidence', async ({ ctx, params, reply }) => {
    const row = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('evidence_artifacts')
        .select(['id', 'kind', 'media_type', 'size_bytes', 'storage_driver', 'storage_key'])
        .where('id', '=', params.id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Evidence');
    const storage = deps.storage;
    if (!storage || row.storage_driver !== storage.driver) throw evidenceNotAvailable();

    let body: Readable;
    try {
      body = await storage.get(row.storage_key);
    } catch (err) {
      if (err instanceof StorageNotFoundError)
        throw new AppError('NOT_FOUND', 'The file is no longer available');
      if (!(err instanceof StorageUnavailableError))
        reply.log.error({ err }, 'evidence storage get failed');
      throw storageUnavailable();
    }
    // Audited once the stored object is open (a failed download is not recorded as one).
    try {
      await withContext(db, ctx, (trx) =>
        audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'evidence.downloaded',
          targetType: 'evidence_artifact',
          targetId: row.id,
          metadata: { kind: row.kind, sizeBytes: row.size_bytes },
        }),
      );
    } catch (err) {
      body.destroy();
      throw err;
    }

    const type =
      row.media_type === 'text/calendar' ? 'text/calendar; charset=utf-8' : row.media_type;
    reply
      .code(200)
      .header('content-type', type)
      .header('content-length', String(row.size_bytes))
      .header('content-disposition', `attachment; filename="${evidenceFilename(row.id, row.kind)}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'private, no-store')
      .send(body);
  });
}
