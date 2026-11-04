/**
 * Text extraction for document.analyze (docs/architecture/phase-b.md §3.3).
 * Runs only in the worker (tools execute there), never in the API process:
 * the parsers are imported lazily.
 *
 *   PDF   pdfjs-dist legacy build (Node). pdf.js 6 has no eval/new Function
 *         code path left (the old isEvalSupported switch is gone); XFA off, no
 *         font faces, no system fonts, no auto-fetch, no streaming; at most
 *         ATTACHMENT_LIMITS.maxPdfPages pages.
 *         Password → ATTACHMENT_ENCRYPTED; parse error → ATTACHMENT_UNREADABLE;
 *         no text layer → DOCUMENT_NO_TEXT (no OCR in Phase B).
 *   DOCX  zip-bomb bounds re-checked from the central directory (nothing
 *         inflated), macros refused, then mammoth.extractRawText (no images,
 *         no external resources).
 *   Text  UTF-8 (BOM stripped).
 * All text is capped at ATTACHMENT_LIMITS.maxExtractedChars (`truncated`).
 */
import { ATTACHMENT_LIMITS, type AttachmentMediaType } from '@jarvis/contracts';
import { AgentError } from '../errors';
import { docxBoundsViolation, readZipDirectory, ZipFormatError } from './zip';

export interface Extracted {
  text: string;
  /** PDF pages; 1 for other types. */
  pages: number;
  /** The text was cut at maxExtractedChars. */
  truncated: boolean;
}

const unreadable = (detail: string) =>
  new AgentError('TOOL_FAILED', `JARVIS could not read this file (${detail}).`, {
    retryable: false,
    reason: 'ATTACHMENT_UNREADABLE',
  });

const noText = () =>
  new AgentError(
    'TOOL_FAILED',
    'This document has no text layer (for example a scanned PDF). JARVIS cannot read images of text yet.',
    { retryable: false, reason: 'DOCUMENT_NO_TEXT' },
  );

function finish(raw: string, pages: number): Extracted {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw noText();
  const max = ATTACHMENT_LIMITS.maxExtractedChars;
  return text.length > max
    ? { text: text.slice(0, max), pages, truncated: true }
    : { text, pages, truncated: false };
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

async function extractPdf(buffer: Buffer, signal?: AbortSignal): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js may transfer (detach) the array it is given: hand it a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  const onAbort = () => void task.destroy();
  signal?.addEventListener('abort', onAbort, { once: true });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    signal?.removeEventListener('abort', onAbort);
    await task.destroy().catch(() => undefined);
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException')
      throw new AgentError(
        'TOOL_FAILED',
        'This PDF is protected with a password, so JARVIS cannot read it.',
        { retryable: false, reason: 'ATTACHMENT_ENCRYPTED' },
      );
    throw unreadable(name === 'InvalidPDFException' ? 'not a valid PDF' : 'PDF parse error');
  }
  try {
    if (doc.numPages > ATTACHMENT_LIMITS.maxPdfPages) {
      throw new AgentError(
        'TOOL_FAILED',
        `This PDF has ${doc.numPages} pages; JARVIS reads at most ${ATTACHMENT_LIMITS.maxPdfPages}.`,
        {
          retryable: false,
          reason: 'DOCUMENT_TOO_MANY_PAGES',
          params: { max: ATTACHMENT_LIMITS.maxPdfPages },
        },
      );
    }
    const parts: string[] = [];
    let chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      if (signal?.aborted) throw unreadable('cancelled');
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items as PdfTextItem[]) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        line += item.hasEOL ? '\n' : item.str && !/\s$/.test(item.str) ? ' ' : '';
      }
      page.cleanup();
      parts.push(line);
      chars += line.length;
      // Enough text for the cap: stop reading pages.
      if (chars > ATTACHMENT_LIMITS.maxExtractedChars) break;
    }
    return finish(parts.join('\n\n'), doc.numPages);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    throw unreadable('PDF content error');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Destroying the loading task tears down the document and its (fake) worker.
    await task.destroy().catch(() => undefined);
  }
}

async function extractDocx(buffer: Buffer): Promise<Extracted> {
  let violation: string | null;
  try {
    violation = docxBoundsViolation(readZipDirectory(buffer), {
      maxUncompressedBytes: ATTACHMENT_LIMITS.maxDocxUncompressedBytes,
      maxCompressionRatio: ATTACHMENT_LIMITS.maxDocxCompressionRatio,
    });
  } catch (err) {
    if (err instanceof ZipFormatError) throw unreadable('not a valid Word document');
    throw err;
  }
  if (violation) throw unreadable(violation);
  const mammoth = (await import('mammoth')).default;
  let value: string;
  try {
    ({ value } = await mammoth.extractRawText({ buffer }));
  } catch {
    throw unreadable('Word document parse error');
  }
  return finish(value, 1);
}

function extractUtf8(buffer: Buffer): Extracted {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    throw unreadable('not UTF-8 text');
  }
  if (text.includes('\u0000')) throw unreadable('binary content');
  return finish(text, 1);
}

/** Extracted text of a stored attachment. Throws AgentError with a TaskErrorReason. */
export async function extractText(
  buffer: Buffer,
  mediaType: AttachmentMediaType,
  signal?: AbortSignal,
): Promise<Extracted> {
  switch (mediaType) {
    case 'application/pdf':
      return extractPdf(buffer, signal);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer);
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
      return extractUtf8(buffer);
  }
}
