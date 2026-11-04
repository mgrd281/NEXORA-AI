/**
 * Attachments (docs/architecture/phase-b.md §3.3): upload, metadata,
 * owner-only download and deletion. Files are identified by their content,
 * stored under a per-tenant key (ids only) and described by an RLS-protected
 * row; deleting the row — here, by cascade or by retention — queues the
 * stored object for deletion (storage_deletions trigger, drained by the
 * worker). This module also deletes the object right away, best effort.
 */
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { sql } from 'kysely';
import { ATTACHMENT_LIMITS, ATTACHMENT_UPLOAD_FIELD, type ApiErrorReason } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { sha256Hex } from '../../lib/crypto';
import { AppError, notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import {
  attachmentStorageKey,
  StorageNotFoundError,
  StorageUnavailableError,
  type ObjectStorage,
} from '../storage/types';
import { contentDisposition, sanitizeFilename } from './filename';
import { ATTACHMENT_COLUMNS, toAttachment } from './mappers';
import { sniffAttachment } from './sniff';

/** Multipart framing allowed on top of the file itself before the request is refused unread. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const reasonError = (
  code: ConstructorParameters<typeof AppError>[0],
  reason: ApiErrorReason,
  message: string,
  extra: Record<string, unknown> = {},
) => new AppError(code, message, { reason, ...extra });

export const storageNotConfigured = () =>
  reasonError(
    'SERVICE_UNAVAILABLE',
    'STORAGE_NOT_CONFIGURED',
    'File uploads are not available on this server',
  );

export const storageUnavailable = () =>
  reasonError(
    'SERVICE_UNAVAILABLE',
    'STORAGE_UNAVAILABLE',
    'File storage is unavailable. Try again shortly.',
  );

const tooLarge = () =>
  reasonError('PAYLOAD_TOO_LARGE', 'FILE_TOO_LARGE', 'The file is larger than the limit', {
    limitBytes: ATTACHMENT_LIMITS.maxBytes,
  });

const oneFileOnly = () =>
  new AppError(
    'VALIDATION_FAILED',
    `Send exactly one file in the "${ATTACHMENT_UPLOAD_FIELD}" field`,
    {
      issues: [{ path: ATTACHMENT_UPLOAD_FIELD, message: 'Exactly one file is required' }],
    },
  );

function requireStorage(deps: AppDeps): ObjectStorage {
  if (!deps.storage) throw storageNotConfigured();
  return deps.storage;
}

/** Errors of @fastify/multipart / busboy → the API's error shape. */
function multipartError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'FST_REQ_FILE_TOO_LARGE':
      return tooLarge();
    case 'FST_PARTS_LIMIT':
    case 'FST_FILES_LIMIT':
    case 'FST_FIELDS_LIMIT':
    case 'FST_PROTO_VIOLATION':
      return oneFileOnly();
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
      return new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the file as multipart/form-data');
    default:
      return new AppError('VALIDATION_FAILED', 'Malformed multipart body');
  }
}

/** Reads the single file part into memory (bounded by the parser's fileSize limit). */
async function readUpload(req: FastifyRequest): Promise<{ buffer: Buffer; filename: string }> {
  let upload: { buffer: Buffer; filename: string } | null = null;
  try {
    for await (const part of req.parts()) {
      if (upload || part.type !== 'file' || part.fieldname !== ATTACHMENT_UPLOAD_FIELD) {
        if (part.type === 'file') part.file.resume();
        throw oneFileOnly();
      }
      upload = { buffer: await part.toBuffer(), filename: part.filename };
    }
  } catch (err) {
    throw multipartError(err);
  }
  if (!upload) throw oneFileOnly();
  return upload;
}

/** Deletes stored objects now, best effort (the storage_deletions outbox guarantees it later). */
export async function deleteObjectsNow(
  deps: Pick<AppDeps, 'storage'>,
  objects: readonly { storage_key: string; storage_driver: string }[],
  log: { warn(obj: object, msg: string): void },
): Promise<void> {
  const storage = deps.storage;
  if (!storage) return;
  for (const o of objects) {
    if (o.storage_driver !== storage.driver) continue;
    await storage
      .delete(o.storage_key)
      .catch((err: unknown) =>
        log.warn({ err }, 'immediate storage delete failed; queued for retry'),
      );
  }
}

export async function registerAttachmentRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  // Multipart parsing exists only in this encapsulated context: no other route accepts it.
  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fileSize: ATTACHMENT_LIMITS.maxBytes,
        files: 1,
        fields: 0,
        parts: 1,
        headerPairs: 50,
        fieldNameSize: 100,
      },
      // @fastify/busboy decodes raw UTF-8 file names (as browsers send them) as UTF-8.
      throwFileSizeLimit: true,
    });

    defineRoute(
      app,
      deps,
      'uploadAttachment',
      async ({ ctx, req, reply }) => {
        const storage = requireStorage(deps);
        const declared = Number(req.headers['content-length']);
        if (
          Number.isFinite(declared) &&
          declared > ATTACHMENT_LIMITS.maxBytes + MULTIPART_OVERHEAD_BYTES
        ) {
          // Refuse before reading; close so the client stops sending.
          reply.header('connection', 'close');
          throw tooLarge();
        }
        let upload: { buffer: Buffer; filename: string };
        try {
          upload = await readUpload(req);
        } catch (err) {
          if (err instanceof AppError && err.status === 413) reply.header('connection', 'close');
          throw err;
        }
        const { buffer } = upload;
        if (buffer.length === 0)
          throw reasonError('VALIDATION_FAILED', 'FILE_EMPTY', 'The file is empty');
        if (buffer.length > ATTACHMENT_LIMITS.maxBytes) throw tooLarge();

        const filename = sanitizeFilename(upload.filename);
        const sniffed = sniffAttachment(buffer, filename);
        if (!sniffed.ok) {
          throw reasonError(
            'UNSUPPORTED_MEDIA_TYPE',
            sniffed.reason,
            sniffed.reason === 'FILE_CONTENT_MISMATCH'
              ? 'The file content does not match its name'
              : 'Only PDF, DOCX, TXT, Markdown and CSV files are accepted',
          );
        }

        const id = randomUUID();
        const key = attachmentStorageKey({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          attachmentId: id,
        });
        const digest = sha256Hex(buffer);
        try {
          await storage.put(key, { body: buffer, contentType: sniffed.mediaType, sha256: digest });
        } catch (err) {
          req.log.error({ err }, 'attachment upload to storage failed');
          throw storageUnavailable();
        }

        try {
          const row = await withContext(db, ctx, async (trx) => {
            const inserted = await trx
              .insertInto('attachments')
              .values({
                id,
                tenant_id: ctx.tenantId,
                user_id: ctx.userId,
                conversation_id: null,
                filename,
                media_type: sniffed.mediaType,
                size_bytes: buffer.length,
                sha256: digest,
                storage_driver: storage.driver,
                storage_key: key,
                expires_at: sql<Date>`now() + make_interval(hours => ${ATTACHMENT_LIMITS.unattachedTtlHours})`,
              })
              .returning(ATTACHMENT_COLUMNS)
              .executeTakeFirstOrThrow();
            await audit(trx, {
              tenantId: ctx.tenantId,
              actorType: 'user',
              actorId: ctx.userId,
              action: 'attachment.uploaded',
              targetType: 'attachment',
              targetId: id,
              // Never the file name: it is user content.
              metadata: { mediaType: sniffed.mediaType, sizeBytes: buffer.length },
            });
            return inserted;
          });
          return toAttachment(row);
        } catch (err) {
          await storage.delete(key).catch(() => {});
          throw err;
        }
      },
      { scope, rateLimit: { max: 20, timeWindow: '1 minute' } },
    );
  });

  defineRoute(app, deps, 'getAttachment', async ({ ctx, params }) => {
    const row = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('attachments')
        .select(ATTACHMENT_COLUMNS)
        .where('id', '=', params.id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Attachment');
    return toAttachment(row);
  });

  defineRoute(app, deps, 'downloadAttachment', async ({ ctx, params, reply }) => {
    // Owner only by construction: session auth + an RLS-scoped lookup (404 for anyone else).
    const row = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('attachments')
        .select(['id', 'filename', 'media_type', 'size_bytes', 'storage_driver', 'storage_key'])
        .where('id', '=', params.id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Attachment');
    const storage = requireStorage(deps);
    if (row.storage_driver !== storage.driver) throw storageUnavailable();

    let body: Readable;
    try {
      body = await storage.get(row.storage_key);
    } catch (err) {
      if (err instanceof StorageNotFoundError)
        throw new AppError('NOT_FOUND', 'The file is no longer available');
      if (!(err instanceof StorageUnavailableError)) reply.log.error({ err }, 'storage get failed');
      throw storageUnavailable();
    }
    // Audited once the stored object is open (a failed download is not recorded as one).
    try {
      await withContext(db, ctx, (trx) =>
        audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'attachment.downloaded',
          targetType: 'attachment',
          targetId: row.id,
          metadata: { mediaType: row.media_type, sizeBytes: row.size_bytes },
        }),
      );
    } catch (err) {
      body.destroy();
      throw err;
    }

    const type = row.media_type.startsWith('text/')
      ? `${row.media_type}; charset=utf-8`
      : row.media_type;
    reply
      .code(200)
      .header('content-type', type)
      .header('content-length', String(row.size_bytes))
      .header('content-disposition', contentDisposition(row.filename))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'private, no-store')
      .send(body);
  });

  defineRoute(app, deps, 'deleteAttachment', async ({ ctx, params, req }) => {
    const deleted = await withContext(db, ctx, async (trx) => {
      const row = await trx
        .deleteFrom('attachments')
        .where('id', '=', params.id)
        .returning(['id', 'media_type', 'storage_key', 'storage_driver'])
        .executeTakeFirst();
      if (!row) throw notFound('Attachment');
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'attachment.deleted',
        targetType: 'attachment',
        targetId: row.id,
        metadata: { mediaType: row.media_type },
      });
      return row;
    });
    await deleteObjectsNow(deps, [deleted], req.log);
  });
}
