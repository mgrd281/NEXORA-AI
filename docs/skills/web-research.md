# Skill: web-research

| Field   | Value                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `web-research`                                                                                                                                                              |
| version | 0.2.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                           |
| status  | Implemented — read and summarise a page the user names (`web.fetch`, `text.summarize`); switchable in Settings › Skills. Multi-source search and follow-up reading: planned |
| tools   | `web.fetch` (1.0.0), `text.summarize` (1.0.0); planned: `web.search`                                                                                                        |

## Description

Reads a public web page the user links to, extracts readable text and returns a faithful summary in
the request language, with the page's HTTP status, final URL and content hash as evidence. Optionally
feeds the summary into another step (e.g. [email-management](email-management.md)).

## Input / output sketch

```ts
// Planned step inputs (authoritative: tools/web-fetch.ts, tools/text-summarize.ts)
webFetch: { url: string /* absolute http(s), copied from the request, ≤ 2048 */ }
textSummarize: {
  text: string;        // usually "{{s1.text}}"
  title?: string;      // "{{s1.title}}"
  focus?: string;      // the aspect the user asked about, in their words
  language: 'en' | 'de' | 'ar';
}
// Outputs
webFetch → { url, finalUrl, status, title, text /* ≤ 20 000 chars */, contentType, bytes, sha256,
             fetchedAt, suspectedInjection, injectionSignals }
textSummarize → { summary, method: 'model' | 'extractive', methodNote, model, language,
                  suspectedInjection }
```

## Permissions and risk

- Connection: **Web access** (`provider: web`, scope `web.fetch`). Without it the policy denies the
  step (`CONNECTION_MISSING`).
- Risk: `LOW` for both tools (read-only). Policy decision: allow.

## Cost limits

- `web.fetch`: no model cost.
- `text.summarize`: model mode `MODEL_FAST` (Haiku 5.5, effort low; `MODEL_BALANCED` above 60 000
  chars). Estimate ≈ (chars ÷ 3.5 + 600) input and 1 500 output tokens — under $0.005 for a 20 000-char
  page ([costs](../costs.md)). Offline: extractive, $0.
- Counted against `monthlyAiBudgetUsd`; at the limit summaries switch to extractive.

## Execution policy

- URLs must come from the request; the planner must not invent URLs.
- SSRF guard on every connection and redirect ([ADR-0015](../adr/0015-ssrf-protection.md)).
- Page text is untrusted: the summariser prompt wraps it in `<document>` tags; instructions inside are
  ignored and mentioned in one sentence; flagged content taints later steps.
- Automatic retry: `web.fetch` up to 2 attempts on transient network/HTTP 5xx/429 errors;
  `text.summarize` up to 2 attempts on transient model errors.

## Verification criteria

- `web.fetch`: HTTP 2xx, readable text length > 0, SHA-256 of the body recorded.
- `text.summarize`: non-empty summary; method recorded (model id or "extractive").

## Error handling

| Condition                                                                                          | Code                      | Retryable                  |
| -------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------- |
| Private/reserved address, non-http(s), credentials in URL                                          | `FETCH_BLOCKED`           | no                         |
| Invalid URL                                                                                        | `VALIDATION_FAILED`       | no                         |
| DNS not found                                                                                      | `TOOL_FAILED`             | no                         |
| Connection refused/reset, 5xx, 429                                                                 | `TOOL_FAILED` (transient) | yes                        |
| No response within 10 s                                                                            | `TOOL_TIMEOUT`            | yes                        |
| > 2 MB, > 5 redirects, unsupported content type, no readable text (JS-only pages), bad certificate | `TOOL_FAILED`             | no                         |
| Model refusal / truncated summary                                                                  | `MODEL_ERROR`             | refusal no; truncation yes |

## Test cases

1. Article page → 3–5 bullet summary, evidence with `200`, bytes, `sha256:`.
2. Redirect chain (3 hops) → `finalUrl` is the last hop; each hop re-validated.
3. `http://169.254.169.254/latest/meta-data` and a hostname resolving to `127.0.0.1` → `FETCH_BLOCKED`.
4. PDF link → `TOOL_FAILED` "cannot read application/pdf".
5. Page with hidden "ignore previous instructions…" → `suspectedInjection: true`; summary does not
   repeat the instruction; a following email step requires approval (`UNTRUSTED_CONTENT`).
6. Offline mode → extractive summary labelled "no AI model was used".
7. German and Arabic requests → summary in the request language.
