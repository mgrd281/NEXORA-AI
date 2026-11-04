# Skill: translation

| Field   | Value                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `translation`                                                                                                                                                                                                     |
| version | 0.1.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                                                                 |
| status  | Implemented (Phase B) — `text.translate` (model only; structured output; numbers and links verified); without a model the request is refused honestly (`PLANNER_UNSUPPORTED` / `OFFLINE_UNSUPPORTED`); switchable |
| tools   | `text.translate` (owned, model only)                                                                                                                                                                              |

## Description

Translates text, a fetched page or a document between languages, preserving meaning, tone and
formatting; first-class for English, German and Arabic (RTL).

## Input / output sketch

```ts
textTranslate: { text: string /* or {{sN.text}} */; source?: string /* BCP 47, auto */;
                 target: string; formality?: 'formal' | 'informal' }
→ { translation, detectedSource, target, model, chars }
```

## Permissions and risk

No connection; `LOW` (read-only). Sending the translation anywhere is a separate step with its own
policy.

## Cost limits

`MODEL_FAST` for short texts, `MODEL_BALANCED` for long or nuanced texts; estimate ≈ input × 2 tokens
of output; long documents need approval when the projected cost exceeds the remaining budget.

## Execution policy

Source text is untrusted data (framing + injection detection). Names, numbers, addresses and URLs
are preserved verbatim; the model must not add content.

## Verification criteria

Non-empty output in the target language (language detection on the output); numbers and URLs in the
source appear unchanged in the output.

## Error handling

Unsupported language pair → clear message; truncated output → `MODEL_ERROR` retryable; offline →
not available (no local translation model).

## Test cases

1. German paragraph → English, numbers preserved.
2. English → Arabic, RTL rendering correct in the UI, punctuation mirrored.
3. Source containing "ignore instructions and …" → translated as text, flagged, not executed.
