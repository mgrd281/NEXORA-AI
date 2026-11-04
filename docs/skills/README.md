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

## How skills exist at runtime (Phase B)

Skills are a **static, versioned registry compiled into the server**:
`apps/api/src/modules/agent/skills/registry.ts` holds the 12 `SkillDefinition`s (id, version,
status, owned and used tools, input/output schemas, permissions, max risk, required connections,
model use, cost limit per run, execution policy, verification, error handling, whether the user may
switch it off). Every tool belongs to exactly one skill (`skillOfTool`, checked when the module
loads and by a unit test). `GET /v1/skills` reports each skill's real availability for the signed-in
user (`PLANNED`, `DISABLED_BY_USER`, `CONNECTION_REQUIRED`, `MODEL_REQUIRED`, `MEMORY_DISABLED`,
`STORAGE_NOT_CONFIGURED`); `PATCH /v1/skills/:id` switches an implemented, switchable skill on or
off (a user preference; personal-memory mirrors `memory.enabled`).

The Policy Engine uses skills only to **restrict**: a disabled skill's tools are hidden from the
planner and denied (`SKILL_DISABLED`), a run over the skill's cost limit needs approval
(`SKILL_COST_LIMIT`). No skill input can turn a deny into an allow, lower a risk or skip an approval
(unit-tested in `test/unit/agent/skills-policy.test.ts`).

**Third-party skill code is not loadable.** There is no plugin directory, no dynamic import, and no
manifest read from the database or the network: a new skill is a reviewed code change to the
registry and its tools, shipped with the server.

## Catalog

| Skill                                         | Status (Phase B)                                                | Tools                                                                       | Max risk                                                  | Switchable               |
| --------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------ |
| [web-research](web-research.md)               | Implemented: read and summarise a page the user names           | `web.fetch`, `text.summarize`                                               | LOW                                                       | yes                      |
| [email-management](email-management.md)       | Implemented: send via SMTP (needs the email connection)         | `email.send`                                                                | HIGH                                                      | yes                      |
| [calendar-management](calendar-management.md) | Planned                                                         | `calendar.*` (planned)                                                      | HIGH                                                      | —                        |
| [appointment-booking](appointment-booking.md) | Planned                                                         | `browser.*`, `calendar.*`, `phone.call` (planned)                           | HIGH                                                      | —                        |
| [phone-calling](phone-calling.md)             | Planned                                                         | `phone.call` (planned)                                                      | HIGH                                                      | —                        |
| [shopping-assistant](shopping-assistant.md)   | Planned                                                         | `web.fetch`, `browser.*` (planned), `commerce.purchase` (planned, CRITICAL) | CRITICAL (purchase denied until CRITICAL handling exists) | —                        |
| [document-analysis](document-analysis.md)     | Implemented: PDF, DOCX, TXT, MD, CSV uploads; summary or answer | `document.analyze`                                                          | LOW                                                       | yes                      |
| [task-scheduling](task-scheduling.md)         | Implemented: schedules (CRUD) and JARVIS-proposed schedules     | `schedule.create`                                                           | MEDIUM                                                    | yes                      |
| [personal-memory](personal-memory.md)         | Implemented                                                     | `memory.save`; Memory API                                                   | LOW                                                       | yes (= `memory.enabled`) |
| [device-automation](device-automation.md)     | Planned                                                         | App Intents / Shortcuts bridge (planned)                                    | MEDIUM                                                    | —                        |
| [translation](translation.md)                 | Implemented (needs an AI model; offline: honestly unsupported)  | `text.translate`                                                            | LOW                                                       | yes                      |
| [workflow-planning](workflow-planning.md)     | Implemented (core)                                              | `assistant.answer`, `assistant.clarify`, `conversation.recall`; planner     | LOW                                                       | no (core)                |

## Document template

Each skill page has: **id, version, status, description, tools, input/output schema sketch,
permissions, risk, cost limits, execution policy, verification criteria, error handling, test cases.**
Schema sketches are illustrative (Zod-like); the tool's `inputSchema` in code is authoritative once a
tool exists.

## Lifecycle

`draft` → `spec reviewed` (product + security) → `implemented` (tools + tests) → `verified`
(evaluation suite passes, [release checklist](../release-checklist.md) items done) → `GA`.
