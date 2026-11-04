# JARVIS documentation

JARVIS is a secure, multi-tenant personal AI agent platform: it plans requests, asks before acting
on the world, executes with durable checkpoints, and proves results with evidence. This folder is the
documentation set for **Milestone 1** (foundation + vertical slice). Statuses are consistent
across documents: **Built** / **Implemented** = in the code now (with file references),
**Milestone 1 (in progress)** = being built in this milestone, **Planned** = a later phase.

## Start here

| If you want to…                      | Read                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Understand the product and its scope | [PRD](product/PRD.md), [Milestone 1 vertical slice](product/vertical-slice.md)                                               |
| Run it locally                       | [Local development](runbooks/local-development.md)                                                                           |
| Understand the system                | [Architecture overview](architecture/overview.md)                                                                            |
| Work on the agent                    | [Agent runtime](architecture/agent-runtime.md), [permission model](security/permission-model.md), [skills](skills/README.md) |
| Call the API                         | [API conventions](architecture/api.md), [OpenAPI 3.1 spec](api/openapi.json)                                                 |
| Change the schema                    | [Data model](architecture/data-model.md)                                                                                     |
| Build Phase B (ownership, contracts) | [Phase B architecture](architecture/phase-b.md)                                                                              |
| Build Phase C (ownership, contracts) | [Phase C architecture](architecture/phase-c.md)                                                                              |
| Review security or privacy           | [Threat model](security/threat-model.md), [privacy](security/privacy.md)                                                     |
| Build UI                             | [Design system](design/design-system.md), [screens](design/screens.md), [review process](design/review-process.md)           |
| Operate it                           | [Operations runbook](runbooks/operations.md), [release checklist](release-checklist.md)                                      |
| Know the limits                      | [Known limitations](known-limitations.md), [costs](costs.md)                                                                 |

## Contents

### Product

- [PRD](product/PRD.md) — vision, personas, principles, phases 1–9, requirements, metrics, risks
- [Vertical slice](product/vertical-slice.md) — Milestone 1 definition and acceptance checklist

### Architecture

- [Overview](architecture/overview.md) — context, containers, components, request and task lifecycle,
  approval data flow, deployment topology
- [Agent runtime](architecture/agent-runtime.md) — intake, context, planning, routing, tool contract,
  policy, approval, execution, verification, recovery, memory, cost control, evaluation plan
- [Data model](architecture/data-model.md) — ER diagram, RLS model, retention proposal, backup/restore
- [API conventions](architecture/api.md) — versioning, auth, errors, idempotency, pagination, rate
  limits, SSE, endpoint list
- [Phase B](architecture/phase-b.md) — frozen contracts and schema (0004), data flows, security notes
  and the file ownership map for follow-ups, questions, attachments, skills, schedules, retention,
  translation, webhooks, time zones, observability and evals
- [Phase C](architecture/phase-c.md) — frozen contracts and schema (0005), extension points, data
  flows, security notes and the file ownership map for OAuth connections (Google, Microsoft), the
  email agent, calendars and Home "Upcoming", booking, the isolated browser agent and shopping

### Architecture decision records

| ADR                                                 | Decision                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| [0001](adr/0001-monorepo.md)                        | pnpm monorepo; TypeScript 6.0.3; ESLint 9 pinned                            |
| [0002](adr/0002-modular-monolith-fastify.md)        | Modular monolith on Fastify 5 + Zod (not NestJS); separate worker process   |
| [0003](adr/0003-multi-tenancy-rls.md)               | Multi-tenancy via PostgreSQL Row-Level Security                             |
| [0004](adr/0004-postgres-job-queue.md)              | Durable execution on a PostgreSQL job queue; Temporal migration criteria    |
| [0005](adr/0005-realtime-sse.md)                    | Realtime via SSE + LISTEN/NOTIFY with Last-Event-ID replay                  |
| [0006](adr/0006-memory-retrieval.md)                | Memory retrieval: full-text + trigram now, pgvector later                   |
| [0007](adr/0007-authentication.md)                  | argon2id + opaque sessions; cookie (web) / bearer (native); invitation only |
| [0008](adr/0008-model-layer.md)                     | Model adapters + deterministic router; Anthropic first; offline planner     |
| [0009](adr/0009-plan-then-execute-policy-engine.md) | Plan-then-execute, deterministic Policy Engine, hash-bound approvals        |
| [0010](adr/0010-exactly-once-side-effects.md)       | Exactly-once side effects with idempotency keys; `OUTCOME_UNKNOWN`          |
| [0011](adr/0011-meridian-design-system.md)          | Meridian design system; tokens as single source; WCAG 2.2 AA                |
| [0012](adr/0012-web-nextjs.md)                      | Next.js 16 App Router, React Query, same-origin proxy, CSS Modules          |
| [0013](adr/0013-ios-swiftui.md)                     | iOS in SwiftUI; Android and macOS in Phase 6                                |
| [0014](adr/0014-secrets-encryption.md)              | AES-256-GCM secret envelopes with owner-bound AAD; rotation                 |
| [0015](adr/0015-ssrf-protection.md)                 | SSRF protection validated at connect time                                   |
| [0016](adr/0016-oauth-connections.md)               | OAuth 2.0 connections: code + PKCE, session-bound state, sealed tokens      |
| [0017](adr/0017-browser-agent-isolation.md)         | Browser agent in a separate, secret-free worker; ephemeral contexts         |
| [0018](adr/0018-commerce-safety.md)                 | Purchases: limit (off by default), exact approval, exactly-once orders      |

### Security and privacy

- [Threat model](security/threat-model.md) — STRIDE per component; prompt injection, SSRF, CSRF,
  session theft, cross-tenant, secrets, supply chain
- [Permission model](security/permission-model.md) — risk levels, tool declarations, approvals,
  autonomy, spending limits, CRITICAL handling
- [Privacy](security/privacy.md) — GDPR data inventory, lawful bases, processors, rights, call
  recording stance

### Skills

- [Skills overview](skills/README.md) and 12 skill specifications:
  [web-research](skills/web-research.md), [email-management](skills/email-management.md),
  [calendar-management](skills/calendar-management.md),
  [appointment-booking](skills/appointment-booking.md), [phone-calling](skills/phone-calling.md),
  [shopping-assistant](skills/shopping-assistant.md),
  [document-analysis](skills/document-analysis.md), [task-scheduling](skills/task-scheduling.md),
  [personal-memory](skills/personal-memory.md), [device-automation](skills/device-automation.md),
  [translation](skills/translation.md), [workflow-planning](skills/workflow-planning.md)

### Design

- [Design system](design/design-system.md) — Meridian principles, tokens, contrast, type, spacing,
  motion, Presence, icons, RTL, components
- [Screens](design/screens.md) — Sign-in, Home, Voice mode, Task Center, Task detail, Approval sheet,
  Memory, Connections, Settings, Admin
- [Review process](design/review-process.md) — screenshot matrix and the 12-step checklist

### Operations

- [Local development](runbooks/local-development.md)
- [Operations](runbooks/operations.md) — deploy, migrate, key rotation, sessions, jobs, incidents,
  backups, SLOs
- [Release checklist](release-checklist.md) — Milestone 1 → private alpha → closed beta → public
- [Costs](costs.md) — model prices, per-task and infrastructure estimates
- [Observability](runbooks/observability.md) — tracing (OTLP), error reporting (Sentry), Prometheus
  metrics for the API and the worker, alerts, privacy guarantees, overhead
- [Agent evaluations](evals.md) — scenario suites, offline / model / pipeline runners, reports,
  baseline and the CI gate
- [Known limitations](known-limitations.md)

## Conventions for these docs

- Code is the source of truth; docs cite files (`apps/api/src/...`) so claims can be checked.
- Diagrams are Mermaid (rendered by GitHub).
- `docs/api/openapi.json` is generated (`pnpm openapi`); do not edit it by hand.
- Estimates and proposals are labelled as such.
