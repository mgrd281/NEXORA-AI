# Skill: email-management

| Field   | Value                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `email-management`                                                                                                                                                                                |
| version | 0.1.0                                                                                                                                                                                             |
| status  | Partially implemented — Milestone 1 (in progress): **send** plain-text email via the user's SMTP account. Reading, triage, drafting replies, threads: planned (Phase 4, Gmail/Microsoft 365/IMAP) |
| tools   | `email.send` (1.0.0); planned: `email.search`, `email.read`, `email.draft`, `email.reply`                                                                                                         |

## Description

Sends an email from the user's own mailbox to recipients the user named, showing the exact message
for approval first. Typical uses: "email me this summary", "send Anna (anna@example.com) a note
that …".

## Input / output sketch

```ts
emailSend: {
  to: string[];     // 1..10 literal addresses; owner's own address or written in the request; no {{refs}}
  subject: string;  // 1..250, may contain {{refs}}
  body: string;     // 1..50 000, plain text, may contain {{refs}}
}
→ { messageId, accepted: string[], rejected: string[], response /* SMTP reply */, from, to, subject }
```

## Permissions and risk

- Connection: **SMTP** (`provider: smtp`, scope `email.send`), verified when connected; TLS (465) or
  STARTTLS (587) required outside development; ports 25/465/587/2525.
- Risk: `MEDIUM` for 1–3 recipients; `HIGH` for more than 3 (`MANY_RECIPIENTS`).

## Cost limits

No model cost for sending. Body text produced by earlier steps is costed there. Planned: per-user
daily send cap (abuse prevention) before closed beta.

## Execution policy

- Always requires approval, showing from, every recipient, subject and the full body — except one
  autonomy rule: `autoApproveEmailToSelf` lets `MEDIUM` emails whose recipients are all the owner's
  own address run without asking. Never for `HIGH`, never when the body derives from flagged content
  (`UNTRUSTED_CONTENT`).
- Recipients are fixed at planning time; fetched content can never add or change recipients.
- Idempotency `once_per_step`: one execution per step; Message-ID derived from the step's idempotency
  key; no automatic retries.

## Verification criteria

Every recipient in `accepted`, none in `rejected`, SMTP reply starts with `250`. Evidence:
`smtp_receipt` with reply text, accepted count and Message-ID.

## Error handling

| Condition                                                | Code                  | Retryable | Notes                                                            |
| -------------------------------------------------------- | --------------------- | --------- | ---------------------------------------------------------------- |
| No active SMTP connection                                | `CONNECTION_REQUIRED` | yes       | Connect, then retry                                              |
| Authentication rejected                                  | `CONNECTION_FAILED`   | yes       | Update the connection                                            |
| Cannot connect / TLS failure before sending              | `CONNECTION_FAILED`   | yes       | Nothing was sent                                                 |
| Server refused the message (4xx/5xx reply)               | `TOOL_FAILED`         | yes       | Nothing was sent                                                 |
| Connection lost during `DATA`, timeout, unexpected error | `OUTCOME_UNKNOWN`     | no        | User checks Sent folder; retry needs `acknowledgeUnknownOutcome` |
| Recipient not accepted                                   | `VERIFICATION_FAILED` | no        | External side effect may have happened for others                |

## Test cases

1. "Email me: buy milk" (offline) → one step to the owner, approval shows full text, `250` receipt.
2. Recipient not in the request → plan rejected by validation.
3. `to: ["{{s1.author}}"]` → rejected at planning.
4. 4 recipients written in the request → `HIGH`, `MANY_RECIPIENTS`, approval required.
5. Crash after the server accepted the message → `OUTCOME_UNKNOWN`; no second send; acknowledged
   retry sends with the same Message-ID.
6. SMTP down → `CONNECTION_FAILED`; after recovery a retry sends exactly once.
7. Autonomy on, email to self → runs without approval (`AUTO_APPROVED_SELF`); same with an injected
   page → approval required.
