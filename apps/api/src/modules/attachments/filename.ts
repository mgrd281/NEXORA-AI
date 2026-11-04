/**
 * Upload file names are user content: kept for display only (never part of a
 * storage key or path), sanitised so they cannot carry a path, control
 * characters or bidirectional overrides that would make "report‮fdp.exe"
 * look like something else, and limited to what the database accepts
 * (1–255 characters, no control characters, no / or \).
 */
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';

const FALLBACK_STEM = 'document';

// C0 and C1 controls, DEL; bidi embeddings/overrides U+202A–202E and isolates U+2066–2069.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/** The lower-case extension including the dot (".pdf"), or '' when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** Truncates to `max` code points (not UTF-16 units: the database counts characters). */
function takeCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

export function sanitizeFilename(raw: string | undefined | null): string {
  const max = ATTACHMENT_LIMITS.maxFilenameChars;
  // Basename only: browsers and clients may send a full path (C:\Users\…\a.pdf).
  const base = (raw ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base.normalize('NFC').replace(UNSAFE, '').trim();
  const ext = fileExtension(cleaned);
  let stem = ext ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
  stem = stem.trim();
  // "..pdf", "   .pdf", "" → a readable fallback that keeps the extension.
  if (!stem || /^\.+$/.test(stem)) stem = FALLBACK_STEM;
  const extChars = Array.from(ext).length;
  return `${takeCodePoints(stem, max - extChars).trimEnd() || FALLBACK_STEM}${ext}`;
}

/** Printable ASCII fallback for Content-Disposition `filename=` (RFC 6266). */
export function asciiFilename(name: string): string {
  const ext = fileExtension(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  const ascii = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    // Quotes and backslashes would end the quoted string; % and ; confuse some parsers.
    .replace(/["\\%;]/g, '_')
    .trim();
  return `${/[A-Za-z0-9]/.test(ascii) ? ascii : FALLBACK_STEM}${ext}`;
}

/** RFC 5987 encoding for `filename*=UTF-8''…`. */
export function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `attachment; filename="…"; filename*=UTF-8''…` — never rendered inline. */
export function contentDisposition(name: string): string {
  return `attachment; filename="${asciiFilename(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
