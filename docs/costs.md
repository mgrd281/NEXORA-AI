# Running costs (estimates)

**Everything on this page is an estimate.** No task has been run against the live Anthropic API in this
environment (there is no API key), and nothing is deployed yet. Token counts below come from the
prompt sizes in the code and the code's own budgeting heuristics (`estimateTokens`: 3.5 characters per
token), not from measured usage. Replace them with measured numbers from `usage_events` /
`cost_records` (`GET /v1/usage`, `GET /v1/admin/overview`) as soon as model mode runs.

## Model prices

Anthropic first-party API list prices, USD per million tokens, as encoded in
`apps/api/src/modules/agent/models/pricing.ts` (Claude 5.5 generation, checked 2026-11-03):

| Model (config key)                                                     | Input                                      | Output                   | Cache write (5-min TTL, 1.25× input) | Cache read                                 |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------ | ------------------------------------ | ------------------------------------------ |
| `claude-opus-5-5` (`MODEL_DEEP`, planning)                             | $4.00                                      | $20.00                   | $5.00                                | $0.20                                      |
| `claude-sonnet-5-5` (`MODEL_BALANCED`, answers; summaries > 60k chars) | $2.00                                      | $10.00                   | $2.50                                | $0.20                                      |
| `claude-haiku-5-5` (`MODEL_FAST`, summaries, result line)              | $0.10 (prompts ≤ 100k tokens; $0.50 above) | $0.50 ($2.50 above 100k) | $0.125                               | $0.01 (0.1× input, as configured — verify) |

Notes:

- Thinking tokens (adaptive thinking is always on for Opus 5.5) are billed as output tokens; effort
  (`medium` for planning and answers, `low` for summaries) is the main lever on output volume.
- When a server-side refusal fallback serves a request, the model that actually served it is billed
  (`usageFrom` prices each iteration by its model).
- Model ids missing from the price table are billed at the most expensive known rate, so costs are
  never under-counted.
- Haiku 5.5 uses a newer tokenizer that counts the same text as roughly 30 % more tokens than older
  Haiku models; the 3.5-chars-per-token heuristic may undercount for it.

## Per-call estimates

| Call                                            | Model / effort      | Input tokens (est.)                                                                                   | Output tokens incl. thinking (est.) | Cost per call                                                 |
| ----------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Plan                                            | Opus 5.5 / medium   | 2 500–4 500 (system prompt ≈ 5 500 chars ≈ 1 600 tokens, output schema, account, ≤ 10 notes, request) | 800–4 000                           | $0.026–0.098 (typical ≈ $0.04)                                |
| Plan repair (only if the first plan is invalid) | Opus 5.5 / medium   | same + previous plan + errors                                                                         | same                                | + $0.03–0.10                                                  |
| Summarize a page (≤ 20 000 chars)               | Haiku 5.5 / low     | 2 000–6 000                                                                                           | 300–1 500                           | $0.0004–0.002                                                 |
| Answer a question                               | Sonnet 5.5 / medium | 1 000–3 000                                                                                           | 500–8 000                           | $0.007–0.086 (code's estimate: 2 000 in / 2 500 out = $0.029) |
| Result line                                     | Haiku 5.5 / low     | ≈ 1 500                                                                                               | ≈ 400                               | ≈ $0.0004                                                     |
| `web.fetch`, `email.send`, `memory.save`        | —                   | —                                                                                                     | —                                   | $0                                                            |

## Per-task estimates (vertical slice)

| Task                                  | Calls                                           | Estimated cost | Typical  |
| ------------------------------------- | ----------------------------------------------- | -------------- | -------- |
| "Summarize <link> and email it to me" | plan + summarize + result line                  | $0.03–0.10     | ≈ $0.045 |
| "Summarize <link>"                    | plan + summarize + result line                  | $0.03–0.10     | ≈ $0.045 |
| Question ("What is …?")               | plan + answer (no result-line call for answers) | $0.03–0.18     | ≈ $0.07  |
| "Remember that …" / "Email me: …"     | plan + result line                              | $0.03–0.10     | ≈ $0.04  |
| Any task in offline mode              | none                                            | $0             | $0       |

Planning dominates. Prompt caching of the planner's system prompt is enabled, but at ≈ 1 600 tokens
the prefix may be below the model's minimum cacheable length (model-dependent, 512–4 096 tokens), in
which case nothing is cached; even when cached it saves only ≈ $0.006 per plan. Verify with
`cache_read_input_tokens` in `usage_events` once live.

## Monthly model spend (owner, private alpha)

| Usage                   | Tasks / month | Estimated model cost |
| ----------------------- | ------------- | -------------------- |
| Light (5 tasks/day)     | 150           | ≈ $7                 |
| Moderate (20 tasks/day) | 600           | ≈ $30                |
| Heavy (50 tasks/day)    | 1 500         | ≈ $75                |

The default budget (`preferences.spending.monthlyAiBudgetUsd = 20`) covers roughly 200–450 typical
tasks; above it JARVIS switches to offline mode and says so. Raise it in Settings if needed.

## Infrastructure (private alpha, one EU region)

Typical price ranges for mainstream providers; to be replaced with the chosen provider's quote.

| Item                                                       | Sizing                                                          | Estimated monthly cost |
| ---------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| Application host (web + API + worker containers)           | 1 VM, 2 vCPU, 4 GB RAM                                          | $20–40                 |
| Managed PostgreSQL 16                                      | 2 vCPU, 4 GB, 50 GB storage, PITR, daily snapshots              | $30–80                 |
| Backup storage (logical dumps, off-site)                   | < 10 GB                                                         | $1–5                   |
| TLS / load balancer                                        | Reverse proxy on the VM with free certificates, or a managed LB | $0–20                  |
| Secret manager                                             | A handful of secrets                                            | $0–5                   |
| Logs and metrics                                           | Free tier or small plan                                         | $0–30                  |
| Domain and DNS                                             | 1 domain                                                        | $1–2                   |
| Outgoing email                                             | The owner's existing mailbox via SMTP                           | $0 incremental         |
| Apple Developer Program (TestFlight / device distribution) | $99 per year                                                    | ≈ $8                   |
| **Total infrastructure**                                   |                                                                 | **≈ $60–190**          |

Private alpha all-in (infrastructure + moderate model use): **≈ $90–220 per month**.

## Scaling notes (for pricing work, Phase 8–9)

- Model cost per active user is driven by plans per day; a heavy user at $75/month model cost needs
  either a higher plan price or cheaper planning (lower effort, smaller planning model for simple
  requests, measured with the evaluation suites before changing defaults).
- Infrastructure scales sub-linearly until the queue migration criteria in
  [ADR-0004](adr/0004-postgres-job-queue.md) are reached; the database is the main cost driver.
- Telephony (Phase 5) adds per-minute provider and realtime-model costs, recorded as
  `cost_records.category = telephony` under the same budget.
