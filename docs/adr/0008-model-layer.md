# ADR-0008: Model layer — provider adapters, deterministic router, offline planner

- Status: Accepted
- Date: 2026-11-03

## Context

Planning is the safety-critical step; answers and summaries are high-volume. Models change quickly,
providers fail, users may refuse to send data to external models, and spending must be capped. The
development environment has no `ANTHROPIC_API_KEY`.

## Decision

- **Provider-neutral interface** `ModelAdapter` (`apps/api/src/modules/agent/models/adapter.ts`):
  `generateObject(schema)` and `generateText(onDelta?)`, each returning metered `ModelUsage`
  (model actually served, input/output/cache tokens, cost in micro-USD). Adapters must raise
  `MODEL_ERROR` for failures and refusals and never return refused or truncated output as normal.
- **Anthropic first** (`models/anthropic.ts`, `@anthropic-ai/sdk` 1.4.0):
  - Structured outputs (`output_config.format` from the Zod plan schema) for plans; the text is parsed
    after checking `stop_reason`. Forced `tool_choice` is not used — it returns 400 on Opus 5.5 and
    Sonnet 5.5.
  - Thinking is not configured (adaptive by default on these models; Opus 5.5 rejects disabling it);
    depth is set with `output_config.effort`. No sampling parameters.
  - `stop_reason: refusal` → `MODEL_ERROR` (not retryable); `max_tokens` → truncated, rejected.
  - Server-side refusal fallback (`server-side-fallback-2026-07-01`, `fallbacks: "default"`) for
    Opus/Sonnet; the model that actually served is the one billed.
  - Byte-stable system prompts with top-level prompt caching; 120 s timeout, 2 SDK retries.
- **Router** (`models/router.ts`), deterministic and re-evaluated per user before model use:

  | Condition                                                | Mode                | `planner.reason`                |
  | -------------------------------------------------------- | ------------------- | ------------------------------- |
  | No `ANTHROPIC_API_KEY`                                   | offline             | `NO_API_KEY`                    |
  | `preferences.ai.allowExternalModels = false`             | offline             | `USER_DISABLED_EXTERNAL_MODELS` |
  | AI spend this month ≥ `monthlyAiBudgetUsd` (or budget 0) | offline             | `BUDGET_EXHAUSTED`              |
  | otherwise                                                | model (`anthropic`) | `null`                          |

  | Purpose                      | Config key                                      | Default model       | Effort |
  | ---------------------------- | ----------------------------------------------- | ------------------- | ------ |
  | Planning                     | `MODEL_DEEP`                                    | `claude-opus-5-5`   | medium |
  | Answers (`assistant.answer`) | `MODEL_BALANCED`                                | `claude-sonnet-5-5` | medium |
  | Summaries (`text.summarize`) | `MODEL_FAST` (`MODEL_BALANCED` above 60k chars) | `claude-haiku-5-5`  | low    |
  | One-line result summary      | `MODEL_FAST`                                    | `claude-haiku-5-5`  | low    |

- **Offline mode** — nothing leaves the server: a deterministic multilingual rules planner
  (`models/offline.ts`) understands "summarize <link> [and email it to me]", "remember that …" and
  "email me: …"; `text.summarize` becomes extractive; `assistant.answer` is unavailable. The mode and
  its reason are always returned to clients (`AssistantStatus.planner`, `TaskDetail.planner`) and must
  be disclosed in the UI.
- **Validation regardless of source:** every plan, model or offline, passes `validatePlan`
  ([ADR-0009](0009-plan-then-execute-policy-engine.md)); an invalid model plan gets one repair attempt
  with the validation errors, then fails with `MODEL_ERROR`.

## Alternatives considered

- **Single model for everything.** Simpler, but either too costly for summaries or too weak for plans.
- **Model-chosen routing.** Non-deterministic and untestable; routing is policy, so it is code.
- **Agent frameworks (LangChain, agent SDKs).** Hide the control flow we must audit; our loop is a
  plan-validate-execute pipeline, not a free-running agent.
- **Fail closed without a key.** Leaves the product unusable offline; the rules planner keeps core
  flows working and is honest about its limits.

## Consequences

- Swapping a model is a config change; prices for cost accounting live in `models/pricing.ts`
  (unknown models are billed at the most expensive known rate, never under-counted).
- Adding a provider = one adapter + price entries; routing and policy are unchanged.
- Model-mode behaviour is covered by tests with a scripted adapter (`test/fixtures/scripted-model.ts`);
  it has not been exercised against the live API in this environment
  ([known limitations](../known-limitations.md)).
