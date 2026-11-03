# Skills

A **skill** is a packaged capability of JARVIS: which tools it uses, what input it understands, what
it produces, how it is verified, what it may cost and how it fails. Skills are how product,
engineering and security agree on a capability before it ships.

## Rules

1. **Skills never grant themselves permissions.** A skill lists the permissions and risk it _expects_;
   the deterministic [Policy Engine](../security/permission-model.md) decides on every step, from the
   tool's declared risk and the concrete resolved input. A skill cannot lower a risk level, skip an
   approval, add an autonomy rule or enable a `CRITICAL` action.
2. Skills use only tools from the backend registry (`apps/api/src/modules/agent/tools/registry.ts`).
   A new capability that needs a new tool ships the tool first, with its `ToolDefinition` (risk,
   idempotency, timeout, retry, verify, approval details) reviewed against the
   [threat model](../security/threat-model.md).
3. Content read by a skill (pages, emails, documents, call audio) is untrusted data. It may fill
   references in planned steps; it never adds steps, chooses recipients or changes amounts.
4. Every skill defines verification criteria; "done" without evidence is not done.
5. Every skill states its cost profile and stays within the user's monthly AI budget.

## How skills exist in Milestone 1

There is **no runtime skill registry** in Milestone 1: the planner receives the catalog of available
tools and composes them directly ([agent runtime](../architecture/agent-runtime.md#3-planning)).
These documents are the specification layer. A machine-readable skill manifest (planner guidance,
examples, allowed tools, evaluation set) is planned for Phase 2; it will be loaded by the planner,
and it will still have no influence on policy.

## Catalog

| Skill                                         | Status                                                                               | Tools                                                                       | Max risk                                                  | Phase |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- | ----- |
| [web-research](web-research.md)               | Partially implemented — Milestone 1 (in progress): read and summarise one page       | `web.fetch`, `text.summarize`                                               | LOW                                                       | 1 → 2 |
| [email-management](email-management.md)       | Partially implemented — Milestone 1 (in progress): send via SMTP                     | `email.send`                                                                | HIGH                                                      | 1 → 4 |
| [calendar-management](calendar-management.md) | Planned                                                                              | `calendar.*` (planned)                                                      | HIGH                                                      | 4     |
| [appointment-booking](appointment-booking.md) | Planned                                                                              | `browser.*`, `calendar.*`, `phone.call` (planned)                           | HIGH                                                      | 4–5   |
| [phone-calling](phone-calling.md)             | Planned                                                                              | `phone.call` (planned)                                                      | HIGH                                                      | 5     |
| [shopping-assistant](shopping-assistant.md)   | Planned                                                                              | `web.fetch`, `browser.*` (planned), `commerce.purchase` (planned, CRITICAL) | CRITICAL (purchase denied until CRITICAL handling exists) | 4+    |
| [document-analysis](document-analysis.md)     | Planned                                                                              | `document.extract` (planned), `text.summarize`                              | LOW                                                       | 2     |
| [task-scheduling](task-scheduling.md)         | Planned                                                                              | `schedule.create` (planned)                                                 | MEDIUM                                                    | 2     |
| [personal-memory](personal-memory.md)         | Implemented — Milestone 1 (in progress)                                              | `memory.save`; Memory API                                                   | LOW                                                       | 1     |
| [device-automation](device-automation.md)     | Planned                                                                              | App Intents / Shortcuts bridge (planned)                                    | MEDIUM                                                    | 3, 6  |
| [translation](translation.md)                 | Planned as a dedicated skill; questions answered by `assistant.answer` in model mode | `assistant.answer`; `text.translate` (planned)                              | LOW                                                       | 2     |
| [workflow-planning](workflow-planning.md)     | Implemented — Milestone 1 (in progress)                                              | Planner, `validatePlan`, Policy Engine                                      | — (meta)                                                  | 1     |

## Document template

Each skill page has: **id, version, status, description, tools, input/output schema sketch,
permissions, risk, cost limits, execution policy, verification criteria, error handling, test cases.**
Schema sketches are illustrative (Zod-like); the tool's `inputSchema` in code is authoritative once a
tool exists.

## Lifecycle

`draft` → `spec reviewed` (product + security) → `implemented` (tools + tests) → `verified`
(evaluation suite passes, [release checklist](../release-checklist.md) items done) → `GA`.
