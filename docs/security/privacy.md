# Privacy and GDPR

Position: JARVIS is built for EU users first. During the private alpha the operator and the owner are
the same person; from closed beta on, the JARVIS operator is the **controller** for account and
service data, and handles content strictly on the user's instruction (pages read, emails sent on
their behalf); the exact controller/processor split for that content is part of the legal review. This document is an engineering baseline, not legal advice;
a DPIA and legal review are release gates for closed beta ([release checklist](../release-checklist.md)).

## Principles in the code

- **Minimisation:** only what a feature needs is stored; voice audio is never stored or received; audit
  and notification metadata never contain content; connection secrets are encrypted and never returned.
- **User control:** external models can be switched off (`ai.allowExternalModels`), memory can be
  switched off (`memory.enabled`), every memory can be viewed, corrected and deleted, sessions can be
  revoked, data can be exported and the account deleted — all self-service through the API.
- **No admin access to content:** platform admins see aggregates and account metadata only.
- **No training on user data** by JARVIS. Model provider terms must exclude training on API data.

## Data inventory

| Category                        | Tables / location                                                                                 | Examples                                                                                            | Purpose                              | Lawful basis (Art. 6 GDPR)                                              | Retention (current → proposed)                             | Recipients                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Account                         | `users`, `tenants`, `user_roles`, `subscriptions`                                                 | Email, display name, locale, time zone, theme, preferences, password hash                           | Provide the account                  | (1)(b) contract                                                         | Until deletion                                             | —                                                                |
| Sessions & devices              | `sessions`, `devices`                                                                             | Token hash, platform, device name, user agent, last use                                             | Sign-in, device management, security | (1)(b); (1)(f) security                                                 | Until deletion → purge revoked/expired after 30 days       | —                                                                |
| Requests & results              | `tasks`, `messages`, `conversations`, `task_steps`, `task_events`, `approvals`, `tool_executions` | Request text, plans, fetched page text, summaries, answers, email subject/body/recipients, evidence | Perform the user's tasks; history    | (1)(b)                                                                  | Until the user deletes the account → optional auto-delete  | Anthropic (model mode), user's SMTP provider (emails)            |
| Third-party data inside content | same                                                                                              | Recipient addresses, names in pages/emails                                                          | Perform the task the user requested  | (1)(f) legitimate interest of the user; user responsible for lawful use | Same as content                                            | Same                                                             |
| Memories                        | `memories`                                                                                        | Preferences, facts the user stated                                                                  | Personalisation                      | (1)(b); user-controlled, can be disabled                                | Until deleted                                              | Anthropic (as planner/answer notes, model mode, top 10 relevant) |
| Connections                     | `connections`                                                                                     | SMTP host, port, username, sender address; password encrypted                                       | Send email as the user               | (1)(b)                                                                  | Until disconnected (secrets wiped)                         | User's SMTP provider                                             |
| Notifications                   | `notifications`                                                                                   | Kind, task id, localisation params (task title)                                                     | In-app notifications                 | (1)(b)                                                                  | Until deletion → 90 days                                   | —                                                                |
| Voice metadata                  | `voice_sessions`                                                                                  | Engine, locale, outcome, transcript length                                                          | Reliability of voice input           | (1)(f)                                                                  | Until deletion → 90 days                                   | —                                                                |
| Usage & cost                    | `usage_events`, `cost_records`                                                                    | Model, token counts, micro-USD amounts                                                              | Budgets, billing, abuse prevention   | (1)(b); (1)(f)                                                          | Until deletion → 24 months                                 | —                                                                |
| Audit                           | `audit_events`                                                                                    | Actor id, action, target id, metadata without content                                               | Security, accountability             | (1)(f); (1)(c) where required                                           | Retained after account deletion (pseudonymous) → 13 months | —                                                                |
| Operational logs                | API/worker stdout                                                                                 | Request id, route, status, latency, errors (auth headers/cookies/passwords/tokens redacted)         | Operations, security                 | (1)(f)                                                                  | Hosting log retention → 30 days                            | Hosting provider                                                 |
| Backups                         | Managed database backups                                                                          | Everything above                                                                                    | Recovery                             | (1)(f)                                                                  | → 30 days rolling                                          | Hosting/database provider                                        |

Special-category data (Art. 9) is not requested, but users may write health or similar information
into requests or memories. It is protected like all content (RLS, encryption at rest, no admin
access); explicit handling (warning when saving such memories) is planned.

## What leaves the server, and when

| Destination          | When                                                                           | What is sent                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API        | Only in model mode (API key configured, external models allowed, budget left)  | Planner: display name, own email address, interface language, time zone, current date, up to 10 relevant memories, the request. Summaries: page title and text (≤ 20 000 chars) and an optional focus. Answers: display name, time zone, date, up to 10 memories, the question. Result line: request, step facts (summary text, page title/URL, email subject and recipients) |
| User's SMTP provider | When an approved (or auto-approved) `email.send` runs; when connecting/testing | Sender, recipients, subject, plain-text body, Message-ID; SMTP authentication                                                                                                                                                                                                                                                                                                 |
| Public websites      | When `web.fetch` runs                                                          | `GET` of the URL from the request, `User-Agent: JARVIS/<version> (personal assistant; fetches on behalf of one user)`, `Accept-Language`                                                                                                                                                                                                                                      |
| Speech engine        | When the user dictates                                                         | Audio goes to the browser's or OS's speech engine, never to JARVIS. Chrome's Web Speech API uses a Google server-side service; Safari and iOS may process on device or on Apple servers. The UI must say so in Voice mode                                                                                                                                                     |

Offline mode sends nothing to model providers.

## Processors and sub-processors

| Processor                                         | Role                       | Data                                               | Transfer basis                              | Notes                                                                                                                                             |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic PBC                                     | Model inference            | As above                                           | DPA + Standard Contractual Clauses (US)     | Commercial API terms: no training on API inputs/outputs. Confirm the current retention period and evaluate zero-data-retention before closed beta |
| SMTP provider (chosen by the user)                | Delivers the user's emails | Email envelope and content                         | The user's own contract with their provider | JARVIS acts on the user's instruction; the provider is not JARVIS's sub-processor                                                                 |
| Hosting + managed PostgreSQL (to be selected)     | Infrastructure             | All stored data                                    | EU region; DPA                              | Selection is a deployment task                                                                                                                    |
| Push notification services (APNs; FCM in Phase 6) | Deliver notifications      | Device token, notification payload without content | DPA                                         | Planned; payloads carry only ids and kinds                                                                                                        |

## Data subject rights

| Right                                 | How                                                                                                                                                                                                                                                                                                                                                                  | Status                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Access / portability (Art. 15, 20)    | `POST /v1/account/export` → one JSON document (`jarvis.account-export`, version 1): profile, preferences, tasks with steps/approvals/events, conversations and messages, memories, connections (metadata only), notifications, sessions, voice sessions, usage and costs. Never includes the password hash, token hashes, push tokens or connection secrets/settings | Implemented (API); Settings UI: Milestone 1 (in progress) |
| Rectification (Art. 16)               | `PATCH /v1/me`, `PATCH /v1/memories/:id`                                                                                                                                                                                                                                                                                                                             | Implemented                                               |
| Erasure (Art. 17)                     | `POST /v1/account/delete` with password and the literal confirmation `DELETE`: deletes the user row and everything that cascades from it (sessions, tasks, memories, connections, …), the user's queued jobs, and the tenant if it has no users left. Memories individually or all at once (`DELETE /v1/memories`)                                                   | Implemented                                               |
| Restriction / objection (Art. 18, 21) | Turn off external models, turn off memory, disconnect services                                                                                                                                                                                                                                                                                                       | Implemented                                               |
| Automated decisions (Art. 22)         | JARVIS takes no decisions with legal or similarly significant effect without the user; external actions need approval or an explicit, narrow autonomy setting                                                                                                                                                                                                        | By design                                                 |

After erasure: `audit_events` keeps pseudonymous rows (actor and target ids no longer linkable to a
user row; metadata never contains content). Backups age out within the backup retention (proposed
30 days) — this must be stated in the privacy notice.

## Minimisation checklist for new features

1. Does the feature need the data at all, or only a derived value (count, hash, length)?
2. Is content kept out of audit metadata, notifications, logs and analytics?
3. Is the data user-private (RLS user policy) and included in export and deletion?
4. Does any new destination receive data? Then update the tables above and the privacy notice.
5. Is there a retention period and a purge mechanism?
6. Can the user turn it off without losing the core product?

## Call recording and telephony (Phase 5 stance)

The schema already reserves `call_sessions` with `ai_disclosed`, `recording_consent` and an encrypted
callee number. The policy for Phase 5:

- **Disclosure first:** every outbound call starts with a clear statement that an AI assistant is
  calling on behalf of the named user. Calls without disclosure are not placed.
- **No recording by default.** Audio is processed in real time and not stored.
- **Recording or transcript storage only with explicit consent of every party**, asked at call start
  and stored per call (`recording_consent`); we apply the strictest rule across EU member states and
  US all-party-consent states. In Germany, recording the non-public spoken word without consent is a
  criminal offence (§ 201 StGB), so absent consent there is no recording at all.
- **Purpose-limited summaries:** without recording consent, only the outcome the user asked for is
  kept (e.g. "appointment booked for 14:00"), not a transcript.
- **Callee data minimised:** numbers encrypted at rest, shown masked, deleted with the task.
- Telephony is behind the `telephony` feature flag (seeded `false`) and requires a separate DPIA.

## Open items before closed beta

- DPIA covering agentic actions, model processing and memory.
- Privacy notice and record of processing activities (Art. 30) based on this inventory.
- Retention purge jobs ([data model](../architecture/data-model.md#3-retention-policy-proposal)).
- Confirm Anthropic retention terms; evaluate zero-data-retention.
- Age gate (16+ in the EU unless parental consent).
- Breach notification procedure (Art. 33: 72 hours) — see [operations](../runbooks/operations.md#incident-response).
