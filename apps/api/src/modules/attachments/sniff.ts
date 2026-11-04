/**
 * Content sniffing for uploads (docs/architecture/phase-b.md §3.3). The type
 * a client declares is ignored: the server identifies the file from its bytes
 * and then requires the file name's extension to agree.
 *
 *   PDF        "%PDF-" within the first 1 024 bytes
 *   DOCX       a ZIP whose central directory (read from the end record;
 *              nothing is inflated) lists [Content_Types].xml and
 *              word/document.xml, no vbaProject.bin (macros), a total
 *              uncompressed size ≤ maxDocxUncompressedBytes and no entry
 *              inflating more than maxDocxCompressionRatio : 1
 *   TXT/MD/CSV valid UTF-8 (BOM allowed), no NUL, at most 0.5 % control
 *              characters other than tab/CR/LF; the extension picks the type
 *
 * Everything else is refused. The checks are cheap and bounded (no
 * decompression, no parsing beyond the ZIP directory); real extraction
 * happens later in the worker (document.analyze), never in the API process.
 */
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_LIMITS,
  type AttachmentMediaType,
} from '@jarvis/contracts';
import { fileExtension } from './filename';

export type SniffResult =
  | { ok: true; mediaType: AttachmentMediaType }
  | { ok: false; reason: 'UNSUPPORTED_FILE_TYPE' | 'FILE_CONTENT_MISMATCH' };

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PDF_SEARCH_BYTES = 1024;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Entries smaller than this are not ratio-checked: they cannot amplify meaningfully (as Apache POI). */
export const ZIP_RATIO_GRACE_BYTES = 100 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export type ZipInspection =
  | { ok: true; entries: ZipEntry[]; totalUncompressed: number }
  | { ok: false; problem: 'not_zip' | 'corrupt' | 'zip64' | 'too_large' | 'ratio' };

/**
 * Reads a ZIP's central directory (no decompression) and checks the
 * zip-bomb bounds. Exported for the worker's re-check before extraction.
 */
export function inspectZip(
  buf: Buffer,
  limits: { maxUncompressedBytes: number; maxRatio: number } = {
    maxUncompressedBytes: ATTACHMENT_LIMITS.maxDocxUncompressedBytes,
    maxRatio: ATTACHMENT_LIMITS.maxDocxCompressionRatio,
  },
): ZipInspection {
  if (buf.length < EOCD_MIN + 30 || buf.readUInt32LE(0) !== SIG_LOCAL)
    return { ok: false, problem: 'not_zip' };
  // The end-of-central-directory record is in the last 22 + 65 535 bytes.
  let eocd = -1;
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, problem: 'corrupt' };
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers: a ≤ 10 MiB document never needs them.
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    return { ok: false, problem: 'zip64' };
  if (diskEntries !== totalEntries || totalEntries === 0) return { ok: false, problem: 'corrupt' };
  if (cdOffset + cdSize > eocd) return { ok: false, problem: 'corrupt' };

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL)
      return { ok: false, problem: 'corrupt' };
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      return { ok: false, problem: 'zip64' };
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) return { ok: false, problem: 'corrupt' };
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    total += uncompressedSize;
    if (total > limits.maxUncompressedBytes) return { ok: false, problem: 'too_large' };
    if (
      uncompressedSize > ZIP_RATIO_GRACE_BYTES &&
      uncompressedSize > limits.maxRatio * Math.max(compressedSize, 1)
    )
      return { ok: false, problem: 'ratio' };
    entries.push({ name, compressedSize, uncompressedSize });
    p = next;
  }
  return { ok: true, entries, totalUncompressed: total };
}

/** A Word document (not macro-enabled) within the zip-bomb bounds. */
export function isDocx(buf: Buffer): boolean {
  const zip = inspectZip(buf);
  if (!zip.ok) return false;
  const names = new Set(zip.entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) return false;
  return !zip.entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name));
}

export function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, PDF_SEARCH_BYTES).indexOf(PDF_MAGIC) >= 0;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Valid UTF-8 text without NUL and with ≤ 0.5 % other control characters (tab, CR, LF allowed). */
export function isText(buf: Buffer): boolean {
  let text: string;
  try {
    text = UTF8.decode(buf); // strips a leading BOM
  } catch {
    return false;
  }
  if (text.length === 0) return false;
  let controls = 0;
  let chars = 0;
  for (const ch of text) {
    chars++;
    const c = ch.codePointAt(0)!;
    if (c === 0) return false;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f))
      controls++;
  }
  return controls <= chars * 0.005;
}

const TEXT_TYPES: AttachmentMediaType[] = ['text/plain', 'text/markdown', 'text/csv'];
const ALL_EXTENSIONS = new Set(Object.values(ATTACHMENT_EXTENSIONS).flat());

function byExtension(identified: AttachmentMediaType[], ext: string): SniffResult {
  const match = identified.find((t) => ATTACHMENT_EXTENSIONS[t].includes(ext));
  if (match) return { ok: true, mediaType: match };
  // Accepted content under the name of another accepted type ("report.pdf" holding HTML text)
  // is a mismatch; an extension JARVIS does not take at all is simply unsupported.
  return {
    ok: false,
    reason: ALL_EXTENSIONS.has(ext) ? 'FILE_CONTENT_MISMATCH' : 'UNSUPPORTED_FILE_TYPE',
  };
}

/** Identifies an upload from its bytes; the (sanitised) file name must agree. */
export function sniffAttachment(buf: Buffer, filename: string): SniffResult {
  const ext = fileExtension(filename);
  if (isPdf(buf)) return byExtension(['application/pdf'], ext);
  if (buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL) {
    return isDocx(buf) ? byExtension([DOCX], ext) : { ok: false, reason: 'UNSUPPORTED_FILE_TYPE' };
  }
  if (isText(buf)) return byExtension(TEXT_TYPES, ext);
  return { ok: false, reason: 'UNSUPPORTED_FILE_TYPE' };
}
