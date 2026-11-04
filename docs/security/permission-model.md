# Permission model

Who decides what JARVIS may do: the **Policy Engine** (`apps/api/src/modules/agent/policy.ts`), a
pure, deterministic function. Models propose plans; tools declare their properties; skills describe
capabilities ([skills](../skills/README.md)). None of them can grant a permission. The policy runs
twice per step: at planning time on the planned input, and immediately before execution on the exact
resolved input.

## Risk levels

| Level      | Meaning                                                                       | Examples (Milestone 1)                                                      | Default decision                               |
| ---------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `LOW`      | Read-only, or changes only the user's own JARVIS data in a way they asked for | `web.fetch`, `text.summarize`, `assistant.answer`, `memory.save`            | Allow                                          |
| `MEDIUM`   | External side effect with limited reach and reversible consequences           | `email.send` to 1–3 recipients                                              | Require approval (one exception, see autonomy) |
| `HIGH`     | External side effect with broad reach or hard-to-reverse consequences         | `email.send` to more than 3 recipients                                      | Require approval, always                       |
| `CRITICAL` | Irreversible, financial, legal or safety-relevant                             | Payments, deleting external data, calls to emergency numbers (future tools) | **Deny** in this build                         |

Risk is computed by the tool from the concrete input (`riskLevel(input)`), not chosen by the model.
The task's risk is the maximum of its steps' risks.

## Evaluation order

First deny wins; approval requirements accumulate. Every decision records machine-readable reason
codes (stored on the step, shown with approvals).

| #   | Rule                                                                                                         | Decision                                      | Reason code                                                                                               | Task error code                                     |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Required connection missing or inactive                                                                      | deny                                          | `CONNECTION_MISSING`                                                                                      | `CONNECTION_REQUIRED`                               |
| 2   | `memory.save` while memory is disabled                                                                       | deny                                          | `MEMORY_DISABLED`                                                                                         | `POLICY_DENIED`                                     |
| 3   | Risk `CRITICAL`                                                                                              | deny                                          | `RISK_CRITICAL`                                                                                           | `POLICY_DENIED`                                     |
| 4a  | Model required, budget is 0                                                                                  | deny                                          | `BUDGET_ZERO`                                                                                             | `BUDGET_EXCEEDED`                                   |
| 4b  | Model required, budget used up                                                                               | deny                                          | `BUDGET_EXHAUSTED`                                                                                        | `BUDGET_EXCEEDED`                                   |
| 4c  | Model required, user disabled external models                                                                | deny                                          | `EXTERNAL_MODELS_DISABLED`                                                                                | `POLICY_DENIED`                                     |
| 4d  | Model required, no model configured                                                                          | deny                                          | `MODEL_UNAVAILABLE`                                                                                       | `MODEL_NOT_CONFIGURED`                              |
| 4e  | Model optional and available, but budget is 0 (defensive: the router already goes offline at budget 0)       | deny                                          | `BUDGET_ZERO`                                                                                             | `BUDGET_EXCEEDED`                                   |
| 5   | Risk `LOW`                                                                                                   | allow                                         | `RISK_LOW`                                                                                                | —                                                   |
| 5   | Risk `MEDIUM`                                                                                                | approval (or allow, see autonomy)             | `RISK_MEDIUM`                                                                                             | —                                                   |
| 5   | Risk `HIGH`                                                                                                  | approval                                      | `RISK_HIGH`                                                                                               | —                                                   |
| 5   | Email recipients                                                                                             | informational                                 | `RECIPIENT_SELF` or `RECIPIENT_EXTERNAL`; `MANY_RECIPIENTS` if > 3                                        | —                                                   |
| 6   | Paid model used and projected cost > remaining budget                                                        | approval                                      | `BUDGET_NEAR_LIMIT`                                                                                       | —                                                   |
| 7   | External side effect whose input derives from content flagged as suspected prompt injection                  | approval (overrides autonomy)                 | `UNTRUSTED_CONTENT`                                                                                       | —                                                   |
| —   | MEDIUM email auto-approved by autonomy setting                                                               | allow                                         | `AUTO_APPROVED_SELF`                                                                                      | —                                                   |
| 1b  | The tool's skill is switched off by the user (Phase B)                                                       | deny                                          | `SKILL_DISABLED`                                                                                          | `POLICY_DENIED` (reason `SKILL_DISABLED { skill }`) |
| 2b  | `memory.save` whose content comes from an earlier result flagged as prompt injection (Phase B)               | deny                                          | `UNTRUSTED_MEMORY`                                                                                        | `POLICY_DENIED`                                     |
| 6b  | Projected cost above the skill's per-run cost limit (Phase B)                                                | approval                                      | `SKILL_COST_LIMIT`                                                                                        | —                                                   |
| 7b  | `memory.save` from an earlier result ("remember that"): the exact text is approved (Phase B)                 | approval (kind `memory`)                      | `MEMORY_FROM_CONTENT`                                                                                     | —                                                   |
| 7c  | `schedule.create`: future side effects (Phase B)                                                             | approval, never auto-approved                 | `FUTURE_RUNS`                                                                                             | —                                                   |
| 1   | The exact connection of the bound input has expired (OAuth; Phase C)                                         | deny                                          | `CONNECTION_EXPIRED`                                                                                      | `CONNECTION_REQUIRED` (reason `CONNECTION_EXPIRED`) |
| 1   | The connection does not grant the capability, e.g. `mail.send` (Phase C)                                     | deny                                          | `CONNECTION_SCOPE_MISSING`                                                                                | `CONNECTION_REQUIRED`                               |
| 3b  | Purchase while `monthlyPurchaseLimitUsd` is 0, the default (Phase C)                                         | deny                                          | `PURCHASES_DISABLED`                                                                                      | `POLICY_DENIED`                                     |
| 3b  | Purchase not in USD / over the month's remaining limit (Phase C)                                             | deny                                          | `PURCHASE_CURRENCY` / `PURCHASE_LIMIT`                                                                    | `POLICY_DENIED`                                     |
| 5b  | Any purchase within the limit (Phase C)                                                                      | approval, never auto-approved                 | `PURCHASE`                                                                                                | —                                                   |
| 5b  | Binding commitment on a site; invitation to anyone but the owner (Phase C)                                   | approval                                      | `BINDING_COMMITMENT`; `RECIPIENT_EXTERNAL`                                                                | —                                                   |
| 3b  | Phone call: telephony not configured; blocked destination; do-not-call; outside hours; daily limit (Phase D) | deny                                          | `TELEPHONY_NOT_CONFIGURED`, `CALL_DESTINATION_BLOCKED`, `DO_NOT_CALL`, `CALL_OUTSIDE_HOURS`, `CALL_LIMIT` | `POLICY_DENIED`                                     |
| 5b  | Any phone call (MEDIUM; HIGH for an appointment) (Phase D)                                                   | approval, never auto-approved, never by voice | `PHONE_CALL` (+ `CALL_RECORDING`, `CALL_PERSONAL_INFO`, `BINDING_COMMITMENT`)                             | —                                                   |

Skills only ever deny, hide or add an approval: no skill setting can turn a deny into an allow,
lower a risk or remove an approval (`test/unit/agent/skills-policy.test.ts`). The policy inputs for
skills (`skillEnabled`, `skillCostLimitMicro`) are computed by `assessStep` from the static registry
and the user's preferences — never by a skill or a tool.

A denied step becomes `BLOCKED` and the task `FAILED` with a user-facing explanation
(`denyMessage`), e.g. "Connect it in Settings → Connections, then retry."

## Tool declarations

From the tool registry (`apps/api/src/modules/agent/tools/*.ts`), version `1.0.0` each:

| Tool               | Side effect | Risk                                | Connection | Declared permissions | Idempotency     | Timeout                  | Automatic retry                                            | Model use                     | Cost estimate                                   |
| ------------------ | ----------- | ----------------------------------- | ---------- | -------------------- | --------------- | ------------------------ | ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `web.fetch`        | none        | LOW                                 | `web`      | `web:read`           | `safe_to_retry` | 15 s (fetch itself 10 s) | up to 2 attempts on transient `TOOL_TIMEOUT`/`TOOL_FAILED` | none                          | 0                                               |
| `text.summarize`   | none        | LOW                                 | —          | —                    | `safe_to_retry` | 120 s                    | up to 2 attempts on transient `MODEL_ERROR`                | optional (extractive offline) | Haiku price × (chars ÷ 3.5 + 600 in, 1 500 out) |
| `email.send`       | external    | MEDIUM (≤ 3 recipients), HIGH (> 3) | `smtp`     | `email:send`         | `once_per_step` | 45 s                     | none                                                       | none                          | 0                                               |
| `memory.save`      | internal    | LOW                                 | —          | `memory:write`       | `safe_to_retry` | 10 s                     | up to 2 attempts on `INTERNAL`                             | none                          | 0                                               |
| `assistant.answer` | none        | LOW                                 | —          | —                    | `safe_to_retry` | 180 s                    | up to 2 attempts on transient `MODEL_ERROR`                | required                      | Sonnet price × (2 000 in, 2 500 out)            |

Additional hard limits enforced by the tools and the planner:

- `web.fetch`: http/https only, public addresses only, ≤ 5 redirects, ≤ 2 MB, HTML/XHTML/text/JSON,
  text ≤ 20 000 characters passed on.
- `email.send`: 1–10 recipients, literal addresses only (no references), each either the owner's
  address or written in the request; subject ≤ 250, body ≤ 50 000 characters, plain text; the sender is
  the connected mailbox.
- `memory.save`: literal text from the request (no references), ≤ 1000 characters.
- Plans: ≤ 8 steps, sequential.

The declared `permissions` strings are informational in Milestone 1; enforcement is by connection
presence, preferences and the rules above. Connection rows record their own scopes
(`web.fetch`, `email.send`).

## Approval rules

- An approval is requested when the policy returns `require_approval` for the resolved input of the
  next step and there is no `APPROVED` approval for that step with the same **action hash**
  (`SHA-256` of canonical JSON `{ toolId, resolvedInput }`).
- The approval shows exactly what will happen: for email `from`, every `to` address, `subject` and the
  full `body`; for other tools labelled fields. It carries risk, reason codes and expiry.
- To decide, the client sends `{ decision, actionHash }`; a different hash is rejected
  (`APPROVAL_MISMATCH`), an expired approval is rejected (`APPROVAL_EXPIRED`) and expires the task.
- Expiry: `APPROVAL_TTL_HOURS` (default 24, range 1–168). Expired tasks can be retried, which asks
  again.
- Rejecting cancels the task and states what was declined. Nothing runs.
- If the input changes (e.g. after a retry recomputed a referenced output), the old approval is
  `SUPERSEDED` and a new one is shown — an approval never carries over to different content.
- One pending approval per step; decisions are idempotent with `Idempotency-Key`.

## Autonomy settings

`preferences.autonomy` (`PATCH /v1/me`):

| Setting                  | Default | Effect                                                                                                           | Cannot override                                                 |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `autoApproveEmailToSelf` | `false` | `MEDIUM` emails whose recipients are **all** the account's own address run without asking (`AUTO_APPROVED_SELF`) | `HIGH` risk; `UNTRUSTED_CONTENT`; `BUDGET_NEAR_LIMIT`; any deny |

There is deliberately no "auto-approve everything" switch. Future autonomy settings follow the same
shape: a narrow, named class of actions, off by default, never applicable to tainted input or
`HIGH`/`CRITICAL` risk.

Related privacy settings that act as policy inputs:

| Setting                  | Default | Effect                                                                        |
| ------------------------ | ------- | ----------------------------------------------------------------------------- |
| `ai.allowExternalModels` | `true`  | `false` → offline mode; model-only steps denied                               |
| `memory.enabled`         | `true`  | `false` → `memory.save` denied and hidden from the planner; memories not read |

## Spending limits

- `preferences.spending.monthlyAiBudgetUsd` (default 20, range 0–10 000). `0` blocks paid model use.
- Spend = sum of `cost_records` with `category = model` since the start of the current calendar month
  (UTC) for the user.
- At or above the budget, the router switches to offline mode (`BUDGET_EXHAUSTED`); steps that require a
  model are denied; optional-model steps run without one.
- A step whose projected cost exceeds the remaining budget needs approval (`BUDGET_NEAR_LIMIT`).
- Planned: per-task cost ceiling, daily cap, telephony costs (`cost_records.category = telephony`) under
  the same budget, and alerts at 50 % / 80 % / 100 %.

## CRITICAL handling

> Phase C ([ADR-0018](../adr/0018-commerce-safety.md)): checkout on a supported shop whose recipe
> declares it (only the local fixture shop in this build) is `HIGH`, with a monthly purchase limit
> (default 0 = off) enforced by the Policy Engine (`agent/policy-domain.ts`), an approval of the
> exact items and total, a live re-check before submitting, and exactly-once orders. Money
> transfers remain `CRITICAL` and denied, and no real merchant's checkout may be enabled before
> step-up re-authentication exists. Domain rules, like skills, can only deny or add an approval.

- Milestone 1 contains no `CRITICAL` tool, and the policy denies `CRITICAL` unconditionally
  (`RISK_CRITICAL`).
- Before any `CRITICAL` tool ships (payments, purchases, deleting external data, legally binding
  actions), the following must exist and be reviewed: step-up re-authentication (password/passkey or
  device biometrics) at decision time, an approval that shows amount/currency/counterparty/
  irreversibility, a per-transaction and monthly limit set by the user, a cooling-off delay option,
  `once_per_step` idempotency with provider-side idempotency keys, and an audit entry with the action
  hash. Approvals from voice or App Intents alone will not be accepted for `CRITICAL`.
