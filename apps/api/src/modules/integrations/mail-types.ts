/** Provider-neutral mail model shared by the Gmail and Graph clients and the mail facade. */
import type { EmailAddress } from '@jarvis/contracts';

export interface MailMessage {
  id: string;
  threadId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  /** ISO instant. */
  date: string;
  subject: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
  inInbox: boolean;
  /** List-Unsubscribe / List-Id / Auto-Submitted / Precedence bulk|list|junk headers. */
  automated: boolean;
  /** RFC 5322 Message-ID (threading, reconciliation). */
  internetMessageId: string | null;
  references: string | null;
  /** Plain text of the body (readThread only). */
  text?: string;
}

export interface MailThread {
  id: string;
  subject: string;
  /** Oldest first. */
  messages: MailMessage[];
  webLink: string | null;
}

export interface MailSearch {
  query?: string;
  from?: string;
  unreadOnly?: boolean;
  /** Only the inbox (needs-reply checks). */
  inboxOnly?: boolean;
  newerThanDays?: number;
  limit: number;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** RFC 5322 Message-ID derived from the idempotency key (Gmail reconciliation). */
  messageIdHeader: string;
  /** The idempotency key (Graph reconciliation tag). */
  key: string;
  /** Reply in this thread (provider thread id). */
  threadId?: string | null;
}

export interface SentMail {
  /** The provider's id of the sent message. */
  messageId: string;
  threadId: string | null;
  internetMessageId: string | null;
  /** Found already sent (an earlier, interrupted attempt): nothing was sent again. */
  reconciled: boolean;
}

export interface DraftReply {
  threadId: string;
  to: string[];
  subject: string;
  body: string;
}

export interface CreatedDraft {
  draftId: string;
  threadId: string;
  messageId: string | null;
}

export interface MailClient {
  search(q: MailSearch, signal?: AbortSignal): Promise<MailThread[]>;
  /** Messages with text (newest kept, at most `maxMessages`); null = no such thread. */
  readThread(
    threadId: string,
    maxMessages: number,
    signal?: AbortSignal,
  ): Promise<MailThread | null>;
  /** Messages without text (watches, drafts); null = no such thread. */
  threadMeta(threadId: string, signal?: AbortSignal): Promise<MailThread | null>;
  createDraftReply(d: DraftReply, signal?: AbortSignal): Promise<CreatedDraft>;
  /** Exactly once: looks for an earlier attempt first, then sends. */
  send(m: OutgoingMail, signal?: AbortSignal): Promise<SentMail>;
}

const AUTOMATED_SENDER =
  /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?|notifications?)@/i;

/** The deterministic "automated mail" rule of EmailThreadSummary.needsReply (headers only). */
export function isAutomated(headers: Record<string, string>, from: string): boolean {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (h['list-unsubscribe'] || h['list-id']) return true;
  if (h['auto-submitted'] && h['auto-submitted'].trim().toLowerCase() !== 'no') return true;
  if (/^(?:bulk|list|junk)$/i.test((h.precedence ?? '').trim())) return true;
  return AUTOMATED_SENDER.test(from.trim());
}

/** "Name <addr>, addr2" → EmailAddress[] (display names unquoted). */
export function parseAddressList(value: string | null | undefined): EmailAddress[] {
  if (!value) return [];
  const out: EmailAddress[] = [];
  // Split on commas outside quotes and angle brackets.
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') depth++;
    if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) {
      out.push(...parseOne(current));
      current = '';
    } else current += ch;
  }
  out.push(...parseOne(current));
  return out;
}

function parseOne(raw: string): EmailAddress[] {
  const s = raw.trim();
  if (!s) return [];
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(s);
  if (m) return [{ name: m[1]?.trim() || null, address: m[2]!.trim().toLowerCase() }];
  return [{ name: null, address: s.toLowerCase() }];
}

export const sameMailbox = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
