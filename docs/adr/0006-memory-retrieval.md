# ADR-0006: Memory retrieval with PostgreSQL full-text + trigram now, pgvector later

- Status: Accepted
- Date: 2026-11-03

## Context

Long-term memory (`memories`: preferences and facts, ≤ 1000 characters each) gives the planner and
the answer tool the owner's context. Requests come in English, German and Arabic. pgvector is not
available in the development environment, and the alpha has at most a few hundred memories per user.

## Decision

- `memories.search` is a stored generated column `to_tsvector('simple', content)` with a GIN index;
  `memories_trgm_idx` is a `gin_trgm_ops` index on `content`.
- The `'simple'` configuration lowercases and splits on non-word characters with no stemming and no
  stop words, so it behaves the same for en/de/ar.
- **Planner / answer retrieval** (`relevantMemories`, `apps/api/src/modules/agent/context.ts`): OR
  across the request's terms, ranked by `ts_rank`, then recency; top 10. Used only when memory is
  enabled and an external model is in use.
- **Memory screen search** (`GET /v1/memories?q=`): `plainto_tsquery('simple', q)` OR a literal
  `ILIKE` substring match (wildcards escaped).

## Alternatives considered

- **pgvector embeddings now.** Better recall for paraphrases ("I'm vegetarian" vs. "meat-free
  recipes"), but unavailable in dev, adds an embedding provider (another processor of personal data)
  and cost. Deferred.
- **Language-specific text search configurations** (`english`, `german`). Better stemming, but needs a
  per-memory language and has no Arabic configuration in core Postgres. Rejected for now.
- **External vector database.** Another datastore holding the most personal data; RLS would not apply.
  Rejected.

## Consequences

- No semantic matching: German compounds and Arabic morphology reduce recall (no stemming).
- Zero extra infrastructure; RLS covers memory retrieval like every other table.
- **Planned migration:** add `embedding vector(…)` with an HNSW index in a new migration once pgvector
  is available in every environment; keep lexical search as a fallback and combine scores
  (hybrid). Embeddings are personal data and will be listed in [privacy](../security/privacy.md)
  before they ship.
