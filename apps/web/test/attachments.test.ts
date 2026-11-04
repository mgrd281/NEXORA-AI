import { ATTACHMENT_LIMITS, ATTACHMENT_UPLOAD_FIELD, type Attachment } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ATTRIBUTE,
  checkFile,
  downloadUrl,
  fileKind,
  localRefusal,
  mediaTypeFor,
  uploadAttachment,
} from '@/features/attachments/files';
import { filesFromPaste } from '@/features/attachments/useAttachmentDraft';
import { LOCALES } from '@/i18n/config';
import { catalogs } from '@/i18n/messages';
import { createTranslator } from '@/i18n/translate';
import { describeError } from '@/lib/api/errors';
import { ApiError } from '@/lib/api/client';

const ID = 'cc000001-0000-4000-8000-00000000f001';

const attachment: Attachment = {
  id: ID,
  filename: 'Q3-board-report.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 1_284_312,
  sha256: 'a'.repeat(64),
  conversationId: null,
  pageCount: null,
  textChars: null,
  downloadPath: `/v1/attachments/${ID}/content`,
  expiresAt: '2026-11-05T09:00:00.000Z',
  createdAt: '2026-11-04T09:00:00.000Z',
};

describe('which files JARVIS accepts (checked before uploading)', () => {
  it('maps every accepted extension to its media type, case-insensitively', () => {
    expect(mediaTypeFor('report.PDF')).toBe('application/pdf');
    expect(mediaTypeFor('contract.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mediaTypeFor('notes.md')).toBe('text/markdown');
    expect(mediaTypeFor('notes.markdown')).toBe('text/markdown');
    expect(mediaTypeFor('data.csv')).toBe('text/csv');
    expect(mediaTypeFor('readme.txt')).toBe('text/plain');
    expect(fileKind(mediaTypeFor('data.csv'))).toBe('csv');
  });

  it('refuses other types, names without an extension, and dotfiles', () => {
    for (const name of ['slides.pptx', 'photo.png', 'report.pdf.exe', 'README', '.pdf', 'doc.']) {
      expect(mediaTypeFor(name), name).toBeNull();
    }
  });

  it('gives the server’s own reasons: type, empty, too large', () => {
    expect(checkFile({ name: 'a.png', size: 10 })).toBe('UNSUPPORTED_FILE_TYPE');
    expect(checkFile({ name: 'a.txt', size: 0 })).toBe('FILE_EMPTY');
    expect(checkFile({ name: 'a.pdf', size: ATTACHMENT_LIMITS.maxBytes + 1 })).toBe(
      'FILE_TOO_LARGE',
    );
    expect(checkFile({ name: 'a.pdf', size: ATTACHMENT_LIMITS.maxBytes })).toBeNull();
  });

  it('offers the accepted extensions and types to the file picker', () => {
    for (const part of ['.pdf', '.docx', '.txt', '.md', '.csv', 'application/pdf', 'text/csv']) {
      expect(ACCEPT_ATTRIBUTE.split(',')).toContain(part);
    }
  });

  it('a local refusal reads like the API’s, in every language', () => {
    const tooLarge = localRefusal('FILE_TOO_LARGE');
    expect(tooLarge).toBeInstanceOf(ApiError);
    expect(tooLarge.code).toBe('PAYLOAD_TOO_LARGE');
    expect(tooLarge.details).toMatchObject({
      reason: 'FILE_TOO_LARGE',
      limitBytes: ATTACHMENT_LIMITS.maxBytes,
    });
    expect(localRefusal('UNSUPPORTED_FILE_TYPE').code).toBe('UNSUPPORTED_MEDIA_TYPE');
    for (const locale of LOCALES) {
      const i18n = { t: createTranslator(locale, catalogs[locale]), messages: catalogs[locale] };
      for (const reason of ['FILE_TOO_LARGE', 'FILE_EMPTY', 'UNSUPPORTED_FILE_TYPE'] as const) {
        const { message } = describeError(localRefusal(reason), i18n);
        expect(message, `${locale} ${reason}`).toBeTruthy();
        expect(message).not.toMatch(/errors\.|FILE_/);
      }
    }
  });

  it('downloads through the same-origin API proxy', () => {
    expect(downloadUrl(ID)).toBe(`/api/v1/attachments/${ID}/content`);
  });
});

describe('filesFromPaste', () => {
  const file = (name: string) => new File(['x'], name);
  const data = (files: File[], text = '') => ({
    files: files as unknown as FileList,
    getData: () => text,
  });

  it('keeps a plain text paste as text', () => {
    expect(filesFromPaste(data([], 'hello'))).toEqual({ files: [], keepText: true });
  });

  it('attaches pasted files and swallows a paste that is only their names', () => {
    const pdf = file('report.pdf');
    expect(filesFromPaste(data([pdf]))).toEqual({ files: [pdf], keepText: false });
    expect(filesFromPaste(data([pdf], 'report.pdf'))).toEqual({ files: [pdf], keepText: false });
  });

  it('pastes text that is more than file names, and only the documents JARVIS reads', () => {
    const pdf = file('report.pdf');
    const png = file('photo.png');
    const result = filesFromPaste(data([pdf, png], 'Look at this'));
    expect(result).toEqual({ files: [pdf], keepText: true });
    expect(filesFromPaste(data([png], 'photo.png'))).toEqual({ files: [], keepText: true });
  });
});

/** A scripted XMLHttpRequest: records what was sent, answers when told to. */
class FakeXhr {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  responseType = '';
  aborted = false;
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

describe('uploadAttachment', () => {
  const pdf = new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' });

  it('posts one multipart file, reports progress and resolves with the validated attachment', async () => {
    const xhr = new FakeXhr();
    const progress: number[] = [];
    const pending = uploadAttachment(pdf, {
      xhr: () => xhr as unknown as XMLHttpRequest,
      onProgress: (p) => progress.push(p),
    });
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/v1/attachments');
    expect((xhr.body?.get(ATTACHMENT_UPLOAD_FIELD) as File).name).toBe('report.pdf');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
    xhr.respond(201, attachment);
    await expect(pending).resolves.toEqual(attachment);
    expect(progress).toEqual([0.5, 1]);
  });

  it('rejects with the API’s code, status and reason', async () => {
    const xhr = new FakeXhr();
    const pending = uploadAttachment(pdf, { xhr: () => xhr as unknown as XMLHttpRequest });
    xhr.respond(415, {
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'The content is not a PDF',
        requestId: 'r1',
        details: { reason: 'FILE_CONTENT_MISMATCH' },
      },
    });
    await expect(pending).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      details: { reason: 'FILE_CONTENT_MISMATCH' },
    });
  });

  it('a response that does not match the contract is a bad response, not an attachment', async () => {
    const xhr = new FakeXhr();
    const pending = uploadAttachment(pdf, { xhr: () => xhr as unknown as XMLHttpRequest });
    xhr.respond(201, { id: 'nope' });
    await expect(pending).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('a proxy 413 without a JSON body still says the file is too large', async () => {
    const xhr = new FakeXhr();
    const pending = uploadAttachment(pdf, { xhr: () => xhr as unknown as XMLHttpRequest });
    xhr.respond(413, '<html>Request Entity Too Large</html>');
    await expect(pending).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
  });

  it('aborting rejects with an AbortError (removing a file while it uploads)', async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    const pending = uploadAttachment(pdf, {
      xhr: () => xhr as unknown as XMLHttpRequest,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.aborted).toBe(true);
  });

  it('a network failure is retryable (NETWORK)', async () => {
    const xhr = new FakeXhr();
    const pending = uploadAttachment(pdf, { xhr: () => xhr as unknown as XMLHttpRequest });
    xhr.onerror?.();
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });
});
