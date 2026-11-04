# Skill: email-management

| Field   | Value                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `email-management`                                                                                                                                                                                                                                                                                          |
| version | 0.3.0 (registry: `apps/api/src/modules/agent/skills/registry.ts`)                                                                                                                                                                                                                                           |
| status  | Implemented — send plain-text email via SMTP **or the connected Google / Microsoft account** (`email.send` `via`); search and read Gmail / Outlook conversations, find what needs a reply, save reply drafts, watch a conversation for a reply (Phase C). Switchable. IMAP accounts: planned (no tool yet). |
| tools   | `email.send` (1.0.0), `email.search`, `email.read_thread`, `email.draft_reply`, `email.track_replies` (1.0.0) — code: `apps/api/src/modules/agent/tools/{email-send.ts,integrations/email-*.ts}`, provider clients `apps/api/src/modules/integrations/{google/gmail.ts,microsoft/graph-mail.ts}`            |

## Description

Reads the user's own mailbox and acts on it only with approval: "summarize my unread emails", "what
needs my reply", "draft a reply to Anna saying …", "email Bob … and tell me when he replies". Mail is
always **untrusted content**: it is data for later steps, scanned for injected instructions, never
followed, never a source of recipients, links, attendees, amounts or memories.

## Input / output sketch

```ts
email.search { provider?, query?, from?, unreadOnly?, needsReply?, newerThanDays?, limit ≤ 25, requireMatch? }
  → { text, threads: EmailThreadSummary[], threadIds, count, firstThreadId, firstSubject,
      firstReplySubject, firstReplyTo, suspectedInjection }
email.read_thread { provider?, threadId? | threadIds (list, JSON list or comma list) }
  → { text (≤ 50 000 chars, newest kept), digest (one line per conversation), subject, threadId,
      messageCount, truncated, suspectedInjection, injectionSignals }
email.draft_reply { provider?, threadId, to: [participant], subject, body } → { draftId, threadId }
email.track_replies { provider?, threadId, days ≤ 30 } → { watchId, expiresAt }
email.send { to[], subject, body, via?: 'smtp' | 'google' | 'microsoft', inReplyTo?: { threadId, subject } }
  → { messageId, threadId (providers), accepted, rejected, response, reconciled? }
```

`provider` / `via` are filled at planning (`bind`): SMTP when active, else the account granting the
capability (Google before Microsoft), else an expired one (so the Policy Engine says
`CONNECTION_EXPIRED`). An absent `via` means SMTP — stored plans keep their meaning.

## Permissions and risk

| Tool                  | Capability (least-privilege scopes, `OAUTH_SCOPES`)                            | Risk                                | Side effect / idempotency         |
| --------------------- | ------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------- |
| `email.search`        | `mail.read` — Gmail `gmail.readonly`, Graph `Mail.Read`                        | LOW                                 | none, `safe_to_retry`             |
| `email.read_thread`   | `mail.read`                                                                    | LOW                                 | none, `safe_to_retry`             |
| `email.draft_reply`   | `mail.compose` — `gmail.compose`, `Mail.ReadWrite` (+ `mail.read` for headers) | MEDIUM (asks)                       | external, `once_per_step`         |
| `email.track_replies` | `mail.read`                                                                    | LOW                                 | internal (a watch row), once/step |
| `email.send`          | SMTP, or `mail.send` — `gmail.send`, Graph `Mail.Send`                         | MEDIUM (≤ 3 recipients), HIGH (> 3) | external, `once_per_step`         |

Drafts are **MEDIUM** (decided, docs/architecture/phase-c.md §3.2): written to the mailbox (an
external system), reversible, reaching nobody — but the recipients come from the thread's headers
(written by others) and the body may be model-written, so the user sees both first. At execution
the draft gets exactly the approved recipients, each of whom must already be in the conversation.

## Cost limits

No model cost of its own; summaries are costed by `text.summarize`. Skill limit: 0.20 USD per step
(`SKILL_COST_LIMIT` approval above it). Gmail / Graph quotas: 429 → `PROVIDER_RATE_LIMITED`.

## Execution policy

- Recipients of `email.send` are literal from the user's requests or the owner; a draft's recipients
  must be participants of the thread and are shown in the approval.
- Plans are fixed before any mail is read; mail content can never add steps (offline and model).
- Sending is exactly once: Gmail messages carry a Message-ID derived from the step's idempotency key
  and Sent is searched (`rfc822msgid:`) before every send; Graph sends (`/me/sendMail`, or
  `…/reply` in a thread — `Mail.Send` only) carry the key as a single-value extended property and
  Sent Items is searched for it first. A send interrupted after the provider may have accepted it is
  `OUTCOME_UNKNOWN`; an acknowledged retry records the message already sent instead of sending again.
- Reply tracking: one `email_watches` row per step, polled every `EMAIL_LIMITS.watchPollMinutes`
  (worker tick `EMAIL_WATCH_TICK_MS` → job `email.watch_poll`); a message from someone else (not an
  auto-reply) → `replied` + notification `email_reply_received` (follows `taskCompleted`); only the
  subject and the sender are kept.

## Verification criteria

Search/read: conversations and messages counted (`threadsRead`), `injectionFlagged` when flagged.
Draft: provider draft id (`draftCreated`), evidence `MAIL_DRAFT`. Watch: `watchCreated`, evidence
`EMAIL_WATCH`. Send: SMTP `250` with every recipient accepted, or the provider's message id
(`providerAccepted`) with evidence `MAIL_SENT { provider, messageId, threadId }`.

## Error handling

| Condition                                                        | Code / reason                                       | Retryable | Notes                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| No connection granting the capability                            | `CONNECTION_REQUIRED` / `CONNECTION_MISSING`        | yes       | Connect, then retry                                                        |
| Grant refused on refresh (`invalid_grant`), or 401 after refresh | `CONNECTION_REQUIRED` / `CONNECTION_EXPIRED`        | yes       | Connection → expired, one notification; Reconnect, then Retry (scenario 9) |
| 403 insufficient scope                                           | `CONNECTION_REQUIRED` / `CONNECTION_SCOPE_MISSING`  | yes       | Capability removed; reconnect and allow it                                 |
| 429                                                              | `TOOL_FAILED` / `PROVIDER_RATE_LIMITED { seconds }` | yes       | Reads retried automatically                                                |
| 5xx / timeout on a read                                          | `TOOL_FAILED` / `PROVIDER_UNAVAILABLE`              | yes       | Reads retried automatically                                                |
| 5xx / timeout while sending or drafting                          | `OUTCOME_UNKNOWN`                                   | no        | Reconciled on an acknowledged retry                                        |
| Conversation gone / nothing matches a required search            | `TOOL_FAILED` / `EMAIL_THREAD_NOT_FOUND`            | no        |                                                                            |
| Too many watches                                                 | `TOOL_FAILED` / `WATCH_LIMIT_REACHED { max }`       | no        |                                                                            |

## Offline planner (en / de / ar)

"summarize my unread emails" / "fasse meine ungelesenen E-Mails zusammen" / "لخص رسائلي غير
المقروءة" → `email.search {unreadOnly}` → `email.read_thread` → `text.summarize` (of the digest);
"what needs my reply" / "worauf muss ich antworten" / "ما الذي يحتاج إلى ردي" → `email.search
{needsReply}`; "draft a reply to <sender> saying …" / "entwirf eine Antwort an …: …" / "اكتب مسودة
رد على …: …" → `email.search {from}` → `email.draft_reply` (approval). Without the reply text it asks
(`details` — the generic `email_content` answer would become an email to yourself).

## Test cases (apps/api/test/{unit,integration}/integrations)

1. Unread summary (Gmail mock): an instruction inside a mail is flagged, left out of the summary,
   never followed; no step added; tokens carry only `gmail.readonly` + identity.
2. "What needs my reply": newsletters (List-Unsubscribe) and answered threads excluded.
3. Draft (Graph mock): approval shows mode draft, account, recipients, subject, body; the draft
   exists afterwards; nothing sent.
4. Send via Gmail and via Graph with a crash after the provider accepted it: OUTCOME_UNKNOWN, the
   replayed job does not send; the acknowledged retry reconciles; exactly one message.
5. Reply tracking (scripted model): send + watch; an out-of-office is ignored; the reply notifies
   exactly once, also when the poll is replayed.
6. Expired grant mid-task → CONNECTION_EXPIRED, one notification, reconnect → resumable → Retry
   completes; planning-time deny for an already expired connection.
