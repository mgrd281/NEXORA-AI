/**
 * Eval fixtures (evals/fixtures/):
 *   pages/<name>.html | .txt    what the fixture website serves
 *   documents/<name>.txt|.md|.csv   attached files as they are
 *   documents/<name>.pdf.json   {"pages": [["line", …], …]} → a real PDF (built in code)
 *   documents/<name>.docx.json  {"paragraphs": ["…", …]}    → a real DOCX (built in code)
 *   injection/*.txt             the prompt-injection corpus (one attack per line)
 * No binary files are committed: PDFs and DOCX files are generated with the
 * same builders the unit tests use (test/fixtures/documents.ts).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeDocx, makePdf } from '../../test/fixtures/documents';
import { FIXTURES_DIR } from './scenario';

export interface PageFixture {
  contentType: string;
  body: string;
}

export async function loadPage(name: string): Promise<PageFixture> {
  const body = await readFile(path.join(FIXTURES_DIR, 'pages', name), 'utf8');
  if (name.endsWith('.html')) return { contentType: 'text/html; charset=utf-8', body };
  if (name.endsWith('.txt')) return { contentType: 'text/plain; charset=utf-8', body };
  throw new Error(`page fixture ${name}: use .html or .txt`);
}

export interface DocumentFixture {
  body: Buffer;
  sha256: string;
}

export async function loadDocument(name: string): Promise<DocumentFixture> {
  const file = path.join(FIXTURES_DIR, 'documents', name);
  let body: Buffer;
  if (name.endsWith('.pdf.json')) {
    const spec = JSON.parse(await readFile(file, 'utf8')) as { pages: string[][] };
    body = makePdf(spec.pages);
  } else if (name.endsWith('.docx.json')) {
    const spec = JSON.parse(await readFile(file, 'utf8')) as { paragraphs: string[] };
    body = makeDocx(spec.paragraphs);
  } else {
    body = await readFile(file);
  }
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}

/** The injection corpus: every non-empty, non-comment line of evals/fixtures/injection/*.txt. */
export async function loadInjectionCorpus(name: string): Promise<string[]> {
  const text = await readFile(path.join(FIXTURES_DIR, 'injection', name), 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
