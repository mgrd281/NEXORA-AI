# Skill: personal-memory

| Field   | Value                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `personal-memory`                                                                                                                                                                            |
| version | 0.1.0                                                                                                                                                                                        |
| status  | Implemented — Milestone 1 (in progress): `memory.save`, Memory API, retrieval for planning and answers. Semantic (pgvector) retrieval: planned ([ADR-0006](../adr/0006-memory-retrieval.md)) |
| tools   | `memory.save` (1.0.0); API: `GET/POST/PATCH/DELETE /v1/memories`                                                                                                                             |

## Description

Remembers preferences and facts the user explicitly asks JARVIS to remember ("remember that I'm
vegetarian", "merk dir, dass …", "تذكر أن …") and uses the relevant ones as background when planning
and answering.

## Input / output sketch

```ts
memorySave: { content: string /* 1..1000, literal request text, no {{refs}} */;
              kind: 'preference' | 'fact' }
→ { memoryId, content, kind, created: boolean }

// API
Memory: { id, kind, content, source: 'user' | 'assistant', sourceTaskId, createdAt, updatedAt }
```

## Permissions and risk

- No connection. Scope `memory:write`. Risk `LOW` (changes only the user's own JARVIS data on request).
- `preferences.memory.enabled = false` → `memory.save` denied (`MEMORY_DISABLED`) and hidden from the
  planner; memories are not read.

## Cost limits

No model cost for saving. Retrieval adds up to 10 short notes to planner/answer prompts (a few hundred
tokens).

## Execution policy

- Content must be literal text from the request: fetched pages or emails can never plant memories
  (memories are later shown to the planner as the owner's notes).
- Retrieval: full-text (`'simple'`) OR-query over the request terms, ranked, top 10; only in model
  mode with memory enabled. Notes are framed as background, not instructions.
- Idempotent per task: the same content saved by the same task is reused, not duplicated.

## Verification criteria

Memory id returned and stored content equals the input. Evidence: `record` with the memory id.

## Error handling

Memory disabled → `POLICY_DENIED`; content > 1000 chars → offline planner refuses with a message;
model planner validation rejects it.

## Test cases

1. "Remember that I prefer window seats" (offline, en) → `preference`.
2. "Merk dir, dass mein Zug um 8 fährt" → `fact`, German.
3. Plan with `content: "{{s1.text}}"` → rejected at validation.
4. Memory disabled → step blocked with explanation.
5. Search `?q=window` finds the memory; delete-all returns the count.
