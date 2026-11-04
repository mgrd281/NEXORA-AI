import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';
import {
  asciiFilename,
  contentDisposition,
  fileExtension,
  sanitizeFilename,
} from '../../../src/modules/attachments/filename';
import { inspectZip, isText, sniffAttachment } from '../../../src/modules/attachments/sniff';
import { makeDocx, makePdf, makeZip } from './zip-fixture';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('content sniffing', () => {
  it('identifies each accepted type from its bytes', () => {
    expect(sniffAttachment(makePdf(), 'report.pdf')).toEqual({
      ok: true,
      mediaType: 'application/pdf',
    });
    expect(sniffAttachment(makeDocx(), 'letter.docx')).toEqual({ ok: true, mediaType: DOCX });
    const text = Buffer.from('Hello, world\nSecond line\n');
    expect(sniffAttachment(text, 'notes.txt')).toEqual({ ok: true, mediaType: 'text/plain' });
    expect(sniffAttachment(Buffer.from('# Title\n\n- item\n'), 'README.md')).toEqual({
      ok: true,
      mediaType: 'text/markdown',
    });
    expect(sniffAttachment(Buffer.from('# x'), 'a.markdown')).toMatchObject({
      mediaType: 'text/markdown',
    });
    expect(sniffAttachment(Buffer.from('a,b\n1,2\n'), 'data.CSV')).toEqual({
      ok: true,
      mediaType: 'text/csv',
    });
  });

  it('accepts %PDF- anywhere in the first 1 024 bytes, not later', () => {
    const late = Buffer.concat([Buffer.alloc(1100, 0x20), makePdf()]);
    const early = Buffer.concat([Buffer.alloc(500, 0x20), makePdf()]);
    expect(sniffAttachment(early, 'a.pdf')).toMatchObject({
      ok: true,
      mediaType: 'application/pdf',
    });
    // Late magic: the bytes are text, and the name says PDF.
    expect(sniffAttachment(late, 'a.pdf')).toEqual({ ok: false, reason: 'FILE_CONTENT_MISMATCH' });
  });

  it('refuses a .pdf that is really HTML (content mismatch), and HTML by name', () => {
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    expect(sniffAttachment(html, 'invoice.pdf')).toEqual({
      ok: false,
      reason: 'FILE_CONTENT_MISMATCH',
    });
    expect(sniffAttachment(html, 'page.html')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
    // A PDF named like text, and a Word file named like a PDF.
    expect(sniffAttachment(makePdf(), 'notes.txt')).toEqual({
      ok: false,
      reason: 'FILE_CONTENT_MISMATCH',
    });
    expect(sniffAttachment(makeDocx(), 'x.pdf')).toEqual({
      ok: false,
      reason: 'FILE_CONTENT_MISMATCH',
    });
    expect(sniffAttachment(makePdf(), 'noextension')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('refuses binary content, other ZIPs and OLE documents', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect(sniffAttachment(png, 'image.txt')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
    const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]);
    expect(sniffAttachment(ole, 'old.docx')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
    const xlsx = makeZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
    ]);
    expect(sniffAttachment(xlsx, 'sheet.docx')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('refuses macro-enabled Word files', () => {
    const docm = makeDocx('x', [{ name: 'word/vbaProject.bin', data: Buffer.alloc(64, 1) }]);
    expect(sniffAttachment(docm, 'macro.docx')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('refuses zip bombs without inflating anything', () => {
    // 4 MiB of zeros deflate to a few KiB: a ratio far above 100:1.
    const bomb = makeDocx('x', [
      { name: 'word/media/zeros.bin', data: Buffer.alloc(4 * 1024 * 1024), deflate: true },
    ]);
    expect(inspectZip(bomb)).toEqual({ ok: false, problem: 'ratio' });
    expect(sniffAttachment(bomb, 'bomb.docx')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
    // A central directory that claims more than the total bound.
    const huge = makeDocx('x', [
      { name: 'word/a.bin', data: 'a', declaredSize: ATTACHMENT_LIMITS.maxDocxUncompressedBytes },
    ]);
    expect(inspectZip(huge)).toMatchObject({ ok: false });
    expect(sniffAttachment(huge, 'huge.docx')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_FILE_TYPE',
    });
    // ZIP64 markers are never needed for ≤ 10 MiB documents.
    const z64 = makeDocx('x', [{ name: 'word/b.bin', data: 'b', declaredSize: 0xffffffff }]);
    expect(inspectZip(z64)).toEqual({ ok: false, problem: 'zip64' });
  });

  it('accepts ordinary compression ratios and small highly compressible parts', () => {
    const doc = makeDocx('Lorem ipsum dolor sit amet. '.repeat(200));
    const inspected = inspectZip(doc);
    expect(inspected.ok).toBe(true);
    // 50 KiB of zeros: ratio > 100, but under the grace size (cannot amplify meaningfully).
    const small = makeDocx('x', [
      { name: 'word/z.bin', data: Buffer.alloc(50 * 1024), deflate: true },
    ]);
    expect(sniffAttachment(small, 'ok.docx')).toEqual({ ok: true, mediaType: DOCX });
  });

  it('refuses corrupt archives', () => {
    const doc = makeDocx();
    expect(inspectZip(doc.subarray(0, doc.length - 10))).toMatchObject({ ok: false });
    const lying = Buffer.from(doc);
    lying.writeUInt32LE(0x7fffffff, lying.length - 6); // central directory offset beyond the end
    expect(inspectZip(lying)).toEqual({ ok: false, problem: 'corrupt' });
  });

  it('checks text: UTF-8, BOM, NUL and control characters', () => {
    expect(isText(Buffer.from('\ufeffmit BOM: grüße, مرحبا'))).toBe(true);
    expect(isText(Buffer.from([0xc3, 0x28]))).toBe(false); // invalid UTF-8
    expect(isText(Buffer.from('a\u0000b'))).toBe(false);
    expect(isText(Buffer.from(`${'x'.repeat(1000)}\u0001`))).toBe(true); // 0.1 %
    expect(isText(Buffer.from(`${'x'.repeat(100)}\u0001\u0002`))).toBe(false); // 2 %
    expect(isText(Buffer.from('\t\r\n'))).toBe(true);
    expect(isText(Buffer.alloc(0))).toBe(false);
  });
});

describe('file names', () => {
  it('keeps the base name only, NFC, without controls or bidi overrides', () => {
    expect(sanitizeFilename('C:\\Users\\me\\Desktop\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('inv\u202eoice\u2066.pdf')).toBe('invoice.pdf');
    expect(sanitizeFilename('a\u0000b\u0007c.txt')).toBe('abc.txt');
    expect(sanitizeFilename('Cafe\u0301.md')).toBe('Café.md'); // NFC
    expect(sanitizeFilename('')).toBe('document');
    expect(sanitizeFilename('.pdf')).toBe('document.pdf');
    expect(sanitizeFilename(' \u202e .pdf')).toBe('document.pdf');
    expect(sanitizeFilename('تقرير.pdf')).toBe('تقرير.pdf');
  });

  it('limits names to 255 characters and keeps the extension', () => {
    const name = sanitizeFilename(`${'ü'.repeat(400)}.docx`);
    expect(Array.from(name)).toHaveLength(ATTACHMENT_LIMITS.maxFilenameChars);
    expect(name.endsWith('.docx')).toBe(true);
    expect(fileExtension(name)).toBe('.docx');
  });

  it('builds a safe attachment Content-Disposition with a UTF-8 name', () => {
    expect(contentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    const ar = contentDisposition('تقرير "q1".pdf');
    expect(ar.startsWith('attachment; filename="')).toBe(true);
    expect(ar).toContain(`filename*=UTF-8''${encodeURIComponent('تقرير "q1".pdf')}`);
    expect(asciiFilename('تقرير.pdf')).toBe('document.pdf');
    expect(asciiFilename('Grüße "x";%.txt')).toBe('Gru_e _x___.txt');
    expect(contentDisposition('a\r\nb.txt')).not.toMatch(/[\r\n]/);
  });
});
