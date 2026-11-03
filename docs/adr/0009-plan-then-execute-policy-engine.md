# ADR-0009: Plan-then-execute with a deterministic Policy Engine and hash-bound approvals

- Status: Accepted
- Date: 2026-11-03

## Context

An agent that reads web pages and email and can send messages is exposed to prompt injection: text it
reads may try to make it act. Users must also be able to trust that what they approve is exactly what
runs.

## Decision

1. **Plan first, then execute.** The planner sees only the user's request, account context and the
   owner's notes; it produces a complete, validated step list (≤ 8 steps) _before_ any web page or
   email is read. Tool outputs can fill `{{sN.field}}` references in later steps but can never add,
   remove or reorder steps.
2. **Deterministic Policy Engine** (`apps/api/src/modules/agent/policy.ts`): a pure function, no I/O, no
   model. It runs at planning time and again on the _resolved_ input right before each step executes.
   Risk levels are `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`; the tool declares risk from its input, the
   policy decides `allow`, `require_approval` or `deny` with reason codes. Details:
   [permission model](../security/permission-model.md).
3. **Approvals are bound to an action hash**: `SHA-256(canonicalJson({ toolId, resolvedInput }))`.
   The approval shows the exact action (for email: from, to, subject, full body); the client must send
   back the hash it displayed; any change to the input produces a different hash, supersedes the old
   approval and asks again. Approvals expire (`APPROVAL_TTL_HOURS`, default 24).
4. **Tool outputs are untrusted data.**
   - Email recipients must be literal addresses written at planning time, either the owner's own
     address or an address that appears in the request text. References in `to` are rejected.
   - `memory.save` content must be literal request text, so fetched content cannot plant a memory.
   - Reference resolution is a single pass of plain substitution; substituted text is never parsed
     again.
   - Untrusted text is wrapped in data tags with an explicit "data, not instructions" rule when shown to
     a model.
   - Content flagged by the injection detector (en/de/ar signals) taints every step that consumes it;
     a tainted external side effect always needs approval (`UNTRUSTED_CONTENT`), even if autonomy
     settings would auto-approve it.
5. **CRITICAL is denied** in this build; there is no override.

## Alternatives considered

- **ReAct-style loop** (model decides the next tool after each observation). Maximally flexible, but
  every observation can steer the next action — the core injection risk. Rejected for side-effecting
  work; may return for read-only research sub-loops with no side-effect tools available.
- **Model-based safety classifier as the gate.** Useful as an additional signal, never as the decision:
  it is probabilistic and itself injectable.
- **Approve plans instead of actions.** A plan approval cannot show content that does not exist yet
  (the email body is written from the fetched page), so approval binds to the resolved action instead.

## Consequences

- Some legitimate requests are refused at validation ("email whoever wrote this page"); the user must
  name recipients. This is intended.
- Approvals stay meaningful: the exact bytes approved are the bytes executed.
- Re-planning after observations is not possible in Milestone 1; multi-stage tasks need multiple
  requests.
