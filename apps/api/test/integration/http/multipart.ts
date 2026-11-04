/** Hand-built multipart/form-data bodies for upload tests (exact control over every part). */
import { randomBytes } from 'node:crypto';

export interface Part {
  field: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

export function multipartBody(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----jarvis${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition =
      p.filename !== undefined
        ? `form-data; name="${p.field}"; filename="${p.filename}"`
        : `form-data; name="${p.field}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${
          p.contentType ? `Content-Type: ${p.contentType}\r\n` : ''
        }\r\n`,
      ),
      Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const payload = Buffer.concat(chunks);
  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** One file in the `file` field. */
export function fileUpload(
  filename: string,
  data: Buffer | string,
  contentType = 'application/octet-stream',
) {
  return multipartBody([{ field: 'file', filename, contentType, data }]);
}
