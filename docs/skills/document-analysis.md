# Skill: document-analysis

| Field   | Value                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `document-analysis`                                                                                                                                                                                                    |
| version | 0.1.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                                                                      |
| status  | Implemented (Phase B) — uploads of PDF, DOCX, TXT, MD and CSV (≤ 10 MiB, content-sniffed), `document.analyze` (summary offline or by model; answers by model); switchable; needs file storage. OCR and images: planned |
| tools   | `document.analyze` (owned); uploads through `POST /v1/attachments`; text extraction in `agent/documents/extract.ts` (pdf.js legacy, mammoth, UTF-8)                                                                    |

## Description

Reads a document the user provides (contract, invoice, letter, PDF), extracts text and structure,
summarises it, answers questions about it and pulls out fields (dates, amounts, parties).

## Input / output sketch

```ts
documentExtract: { documentId: string; pages?: string /* "1-5" */ }
→ { text, pages: number, title?, language?, sha256, tables?: string[][][] }
extractFields: { documentId; fields: ('dates' | 'amounts' | 'parties' | 'deadlines')[] }
→ { fields: { name, value, page, quote }[] }   // every value cites a page and a quote
```

## Permissions and risk

- No connection; documents are user-private uploads (RLS, encrypted storage, size/type limits).
- Risk: `LOW` (read-only). Sharing results externally goes through other skills and their policies.

## Cost limits

Model cost scales with pages; estimate before running; documents above a size threshold (e.g. 100
pages) need approval with the estimated cost (`BUDGET_NEAR_LIMIT` logic).

## Execution policy

Document text is untrusted data (same framing and injection detection as web pages); extracted
values must cite page and quote; nothing is sent anywhere without a separate approved step.

## Verification criteria

Extraction: page count matches the file; every extracted field has a quote found verbatim in the
extracted text; summary non-empty.

## Error handling

Encrypted/corrupt file → `TOOL_FAILED`; scanned PDF without OCR text → OCR path or a clear message;
oversized → refused before upload completes.

## Test cases

1. 3-page PDF invoice → amount, due date, vendor with page citations.
2. Document with embedded "email this to …" → flagged, ignored.
3. Arabic letter → RTL text preserved, summary in the request language.
