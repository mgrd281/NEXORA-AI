/**
 * Reads a ZIP's central directory (from the end-of-central-directory record)
 * without inflating anything: entry names, compressed and uncompressed sizes.
 * Used to re-check DOCX zip-bomb bounds in the worker before mammoth inflates
 * the file (the upload path checks the same bounds; this is defence in depth
 * for files stored before a limit changed, or by another code path).
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

/** The central directory entries; throws ZipFormatError for anything malformed or ZIP64. */
export function readZipDirectory(buf: Buffer): ZipEntry[] {
  // The EOCD is 22 bytes plus a comment of at most 65 535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('no end of central directory record');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG)
    throw new ZipFormatError('ZIP64 archives are not accepted');
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (offset + size > eocd) throw new ZipFormatError('central directory out of range');
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CDH_SIG)
      throw new ZipFormatError('bad central directory header');
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new ZipFormatError('ZIP64 entries are not accepted');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, compressedSize, uncompressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export interface ZipBounds {
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

/** Why a DOCX may not be inflated, or null when it is within bounds. */
export function docxBoundsViolation(entries: ZipEntry[], bounds: ZipBounds): string | null {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml'))
    return 'not a Word document';
  if (entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name))) return 'contains macros';
  let total = 0;
  for (const e of entries) {
    total += e.uncompressedSize;
    if (total > bounds.maxUncompressedBytes) return 'uncompressed size above the limit';
    const ratio = e.uncompressedSize / Math.max(1, e.compressedSize);
    if (e.uncompressedSize > 1024 && ratio > bounds.maxCompressionRatio)
      return 'compression ratio above the limit';
  }
  return null;
}
