/**
 * documents/extract.ts against fixtures built in code: PDF text layers, page
 * caps, encrypted and broken PDFs, DOCX (mammoth) with zip-bomb and macro
 * guards, UTF-8 text. The parsers run for real (pdfjs-dist legacy, mammoth).
 */
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { extractText } from '../../../src/modules/agent/documents/extract';
import { docxBoundsViolation, readZipDirectory } from '../../../src/modules/agent/documents/zip';
import { AgentError } from '../../../src/modules/agent/errors';
import { makeDocx, makeEncryptedPdf, makePdf, makeZip } from '../../fixtures/documents';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

async function reason(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AgentError) return err.reason;
    throw err;
  }
  return 'resolved';
}

describe('extractText: PDF', () => {
  it('reads the text layer of every page and counts pages', async () => {
    const pdf = makePdf([
      ['Quarterly report for the board.', 'Revenue grew by 12 percent.'],
      ['Costs fell by 3 percent in the same period.'],
    ]);
    const out = await extractText(pdf, 'application/pdf');
    expect(out.pages).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.text).toContain('Quarterly report for the board.');
    expect(out.text).toContain('Revenue grew by 12 percent.');
    expect(out.text).toContain('Costs fell by 3 percent');
  });

  it('refuses PDFs without a text layer, with too many pages, encrypted or broken', async () => {
    expect(await reason(extractText(makePdf([], { emptyPages: 2 }), 'application/pdf'))).toBe(
      'DOCUMENT_NO_TEXT',
    );
    expect(
      await reason(
        extractText(
          makePdf([['x']], { emptyPages: ATTACHMENT_LIMITS.maxPdfPages }),
          'application/pdf',
        ),
      ),
    ).toBe('DOCUMENT_TOO_MANY_PAGES');
    expect(await reason(extractText(makeEncryptedPdf(), 'application/pdf'))).toBe(
      'ATTACHMENT_ENCRYPTED',
    );
    expect(
      await reason(extractText(Buffer.from('%PDF-1.4\nnot really a pdf'), 'application/pdf')),
    ).toBe('ATTACHMENT_UNREADABLE');
  });
});

describe('extractText: DOCX', () => {
  it('reads paragraphs with mammoth', async () => {
    const out = await extractText(makeDocx(['Meeting notes.', 'Decision: ship on Friday.']), DOCX);
    expect(out.pages).toBe(1);
    expect(out.text).toBe('Meeting notes.\n\nDecision: ship on Friday.');
  });

  it('re-checks zip-bomb bounds and macros before inflating', async () => {
    const bomb = makeDocx(
      ['x'],
      [
        {
          name: 'word/media/huge.bin',
          data: Buffer.alloc(10),
          method: 'store',
          declaredSize: ATTACHMENT_LIMITS.maxDocxUncompressedBytes + 1,
        },
      ],
    );
    expect(await reason(extractText(bomb, DOCX))).toBe('ATTACHMENT_UNREADABLE');
    const ratio = makeDocx(
      ['x'],
      [
        { name: 'word/big.xml', data: Buffer.alloc(2_000_000, 0x20) }, // deflates ~1000:1
      ],
    );
    expect(
      docxBoundsViolation(readZipDirectory(ratio), {
        maxUncompressedBytes: ATTACHMENT_LIMITS.maxDocxUncompressedBytes,
        maxCompressionRatio: ATTACHMENT_LIMITS.maxDocxCompressionRatio,
      }),
    ).toBe('compression ratio above the limit');
    const macro = makeDocx(['x'], [{ name: 'word/vbaProject.bin', data: 'macro' }]);
    expect(await reason(extractText(macro, DOCX))).toBe('ATTACHMENT_UNREADABLE');
    const notWord = makeZip([{ name: 'a.txt', data: 'hello' }]);
    expect(await reason(extractText(notWord, DOCX))).toBe('ATTACHMENT_UNREADABLE');
    expect(await reason(extractText(Buffer.from('PK nonsense'), DOCX))).toBe(
      'ATTACHMENT_UNREADABLE',
    );
  });
});

describe('extractText: text', () => {
  it('decodes UTF-8, strips the BOM and caps the length', async () => {
    const out = await extractText(
      Buffer.from('﻿Zeile eins\r\nZeile zwei — ü', 'utf8'),
      'text/plain',
    );
    expect(out.text).toBe('Zeile eins\nZeile zwei — ü');
    const long = await extractText(
      Buffer.from('a'.repeat(ATTACHMENT_LIMITS.maxExtractedChars + 10)),
      'text/csv',
    );
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(ATTACHMENT_LIMITS.maxExtractedChars);
    expect(await reason(extractText(Buffer.from([0xff, 0xfe, 0x00]), 'text/markdown'))).toBe(
      'ATTACHMENT_UNREADABLE',
    );
    expect(await reason(extractText(Buffer.from('   \n  '), 'text/plain'))).toBe(
      'DOCUMENT_NO_TEXT',
    );
  });
});
