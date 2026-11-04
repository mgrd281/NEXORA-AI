/**
 * Tiny, valid document fixtures built in code (no binary files in the repo):
 *   makePdf   — a PDF 1.4 with one Helvetica text layer per page and a correct xref
 *   makeDocx  — a minimal WordprocessingML package (stored ZIP, correct CRCs)
 *   makeZip   — a ZIP of arbitrary entries (for zip-bomb / macro cases)
 */
import { crc32, deflateRawSync } from 'node:zlib';

function pdfString(s: string): string {
  return `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

/**
 * A PDF whose pages carry the given lines as real text (WinAnsi Helvetica, so
 * ASCII/Latin-1 only). `pages: []` gives a PDF without any text layer.
 */
export function makePdf(pages: string[][], opts: { emptyPages?: number } = {}): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length + (opts.emptyPages ?? 0);
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const kids: number[] = [];
  for (let i = 0; i < pageCount; i++) kids.push(4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  for (let i = 0; i < pageCount; i++) {
    const lines = pages[i] ?? [];
    const ops = lines.length
      ? [
          'BT',
          '/F1 12 Tf',
          '14 TL',
          '72 720 Td',
          ...lines.map((l) => `${pdfString(l)} Tj T*`),
          'ET',
        ]
      : [];
    const stream = ops.join('\n');
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  }
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PDF that declares encryption (pdf.js asks for a password). */
export function makeEncryptedPdf(): Buffer {
  const base = makePdf([['secret']]).toString('latin1');
  return Buffer.from(
    base.replace(
      '/Root 1 0 R >>',
      '/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >> /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>',
    ),
    'latin1',
  );
}

export interface ZipInput {
  name: string;
  data: Buffer | string;
  /** Deflate (default) or store. */
  method?: 'deflate' | 'store';
  /** Override the uncompressed size written to the directory (zip-bomb fixtures). */
  declaredSize?: number;
}

export function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 'deflate';
    const body = method === 'deflate' ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method === 'deflate' ? 8 : 0, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method === 'deflate' ? 8 : 0, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal .docx with one paragraph per string. */
export function makeDocx(paragraphs: string[], extra: ZipInput[] = []): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('');
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
    ...extra,
  ]);
}
