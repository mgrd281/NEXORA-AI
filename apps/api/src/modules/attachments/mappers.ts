/** Attachment rows → contract (shared by attachments, task detail, conversations and export). */
import { buildPath, routes, type Attachment } from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import type { AttachmentRow } from '../../db/types';

/** The columns toAttachment reads (storage key and driver stay server-side). */
export const ATTACHMENT_COLUMNS = [
  'id',
  'filename',
  'media_type',
  'size_bytes',
  'sha256',
  'conversation_id',
  'page_count',
  'text_chars',
  'expires_at',
  'created_at',
] as const;

export type AttachmentView = Pick<AttachmentRow, (typeof ATTACHMENT_COLUMNS)[number]>;

export function attachmentDownloadPath(id: string): string {
  return buildPath(routes.downloadAttachment.path, { id });
}

export function toAttachment(row: AttachmentView): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    conversationId: row.conversation_id,
    pageCount: row.page_count,
    textChars: row.text_chars,
    downloadPath: attachmentDownloadPath(row.id),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Attachments named by each task's request, in request order (RLS-scoped). */
export async function loadTaskAttachments(
  trx: Trx,
  taskIds: readonly string[],
): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>();
  if (taskIds.length === 0) return out;
  const rows = await trx
    .selectFrom('task_attachments as ta')
    .innerJoin('attachments as a', 'a.id', 'ta.attachment_id')
    .select(['ta.task_id', ...ATTACHMENT_COLUMNS.map((c) => `a.${c}` as const)])
    .where('ta.task_id', 'in', [...taskIds])
    .orderBy('ta.task_id')
    .orderBy('ta.position')
    .execute();
  for (const r of rows) {
    const list = out.get(r.task_id) ?? [];
    list.push(toAttachment(r));
    out.set(r.task_id, list);
  }
  return out;
}
