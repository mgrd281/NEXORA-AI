/**
 * Attachments on the client: which files JARVIS accepts (checked before anything is uploaded,
 * with the server's own limits and reasons), the multipart upload with progress, and the
 * download URL. The server still sniffs every file's content; these checks only save the user
 * an upload that would be refused. Pure helpers are unit-tested in test/attachments.test.ts.
 */
import '@/lib/zod-config';
import {
  ApiErrorBody,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_LIMITS,
  ATTACHMENT_UPLOAD_FIELD,
  Attachment,
  AttachmentMediaType,
  buildPath,
  routes,
  type ApiErrorReason,
} from '@jarvis/contracts';
import { ApiError, redirectToSignIn } from '@/lib/api/client';

export type FileKind = 'pdf' | 'docx' | 'txt' | 'md' | 'csv';

const KIND_OF_TYPE: Record<AttachmentMediaType, FileKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

/** Extensions the server accepts (lower case, with the dot). */
export const ACCEPTED_EXTENSIONS: readonly string[] = Object.values(ATTACHMENT_EXTENSIONS).flat();

/** For <input type="file" accept>: extensions and their media types. */
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_EXTENSIONS, ...AttachmentMediaType.options].join(',');

export const LIMIT_MB = Math.round(ATTACHMENT_LIMITS.maxBytes / (1024 * 1024));

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** The media type a file name's extension stands for (the server confirms it from the bytes). */
export function mediaTypeFor(name: string): AttachmentMediaType | null {
  const ext = extensionOf(name);
  for (const type of AttachmentMediaType.options) {
    if (ATTACHMENT_EXTENSIONS[type].includes(ext)) return type;
  }
  return null;
}

export function fileKind(mediaType: AttachmentMediaType | null): FileKind | null {
  return mediaType ? KIND_OF_TYPE[mediaType] : null;
}

/**
 * Why a file can't be attached, before uploading it (the same reasons the server would give),
 * or null when it may be uploaded.
 */
export function checkFile(file: Pick<File, 'name' | 'size'>): ApiErrorReason | null {
  if (!mediaTypeFor(file.name)) return 'UNSUPPORTED_FILE_TYPE';
  if (file.size === 0) return 'FILE_EMPTY';
  if (file.size > ATTACHMENT_LIMITS.maxBytes) return 'FILE_TOO_LARGE';
  return null;
}

/** A refusal made on this device, shaped like the API's (so it reads the same everywhere). */
export function localRefusal(reason: ApiErrorReason): ApiError {
  const details: Record<string, unknown> = { reason };
  if (reason === 'FILE_TOO_LARGE') details.limitBytes = ATTACHMENT_LIMITS.maxBytes;
  if (reason === 'TOO_MANY_ATTACHMENTS') details.max = ATTACHMENT_LIMITS.maxPerRequest;
  const code =
    reason === 'FILE_TOO_LARGE'
      ? 'PAYLOAD_TOO_LARGE'
      : reason === 'UNSUPPORTED_FILE_TYPE'
        ? 'UNSUPPORTED_MEDIA_TYPE'
        : 'VALIDATION_FAILED';
  return new ApiError(code, reason, 0, undefined, details);
}

/** Same-origin URL that streams the file to its owner (session cookie + RLS on the API). */
export function downloadUrl(attachmentId: string): string {
  return `/api${buildPath(routes.downloadAttachment.path, { id: attachmentId })}`;
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Test seam. */
  xhr?: () => XMLHttpRequest;
}

/**
 * POST /v1/attachments as multipart/form-data with upload progress (fetch has none). Resolves
 * with the contract-validated Attachment; rejects with ApiError (the API's code, message and
 * details.reason) or an AbortError.
 */
export function uploadAttachment(file: File, options: UploadOptions = {}): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = options.xhr?.() ?? new XMLHttpRequest();
    const abort = () => xhr.abort();
    if (options.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    const done = () => options.signal?.removeEventListener('abort', abort);

    xhr.open('POST', `/api${routes.uploadAttachment.path}`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) options.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      done();
      let json: unknown = null;
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // handled below
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = Attachment.safeParse(json);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError('BAD_RESPONSE', 'The response did not match the contract', 0));
        return;
      }
      const body = ApiErrorBody.safeParse(json);
      if (xhr.status === 401) redirectToSignIn();
      if (body.success) {
        const e = body.data.error;
        reject(new ApiError(e.code, e.message, xhr.status, e.requestId, e.details));
      } else {
        reject(
          new ApiError(
            xhr.status === 413 ? 'PAYLOAD_TOO_LARGE' : xhr.status >= 500 ? 'NETWORK' : 'INTERNAL',
            xhr.statusText || 'Upload failed',
            xhr.status,
          ),
        );
      }
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError('NETWORK', 'Network request failed', 0));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const form = new FormData();
    form.append(ATTACHMENT_UPLOAD_FIELD, file, file.name);
    xhr.send(form);
  });
}
