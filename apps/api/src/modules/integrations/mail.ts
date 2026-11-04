/**
 * Provider-neutral mail facade (Gmail / Microsoft Graph) used by the email
 * tools and the reply-watch job. Mail content is untrusted text: callers
 * frame it as data, run the injection detector and never take recipients,
 * links or instructions from it.
 */
import { EMAIL_LIMITS, type EmailAddress, type EmailThreadSummary } from '@jarvis/contracts';
import type { DbContext } from '../../db/pool';
import { truncate } from '../../lib/redact';
import { gmailClient } from './google/gmail';
import { graphMailClient } from './microsoft/graph-mail';
import { sameMailbox, type MailClient, type MailMessage, type MailThread } from './mail-types';
import type { ConnectionRef, IntegrationDeps } from './types';

export * from './mail-types';

export function mailClient(deps: IntegrationDeps, ctx: DbContext, conn: ConnectionRef): MailClient {
  return conn.provider === 'google'
    ? gmailClient(deps, ctx, conn)
    : graphMailClient(deps, ctx, conn);
}

/** The newest message in the thread not written by the account (null: only own messages). */
export function newestFromOthers(thread: MailThread, account: string): MailMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (!sameMailbox(m.from.address, account)) return m;
  }
  return null;
}

/**
 * EmailThreadSummary.needsReply, from headers only: the newest message is
 * from someone else, in the inbox, and not automated.
 */
export function needsReply(thread: MailThread, account: string): boolean {
  const newest = thread.messages.at(-1);
  if (!newest) return false;
  return !sameMailbox(newest.from.address, account) && newest.inInbox && !newest.automated;
}

/** Who a reply to the thread goes to: Reply-To, else the sender, of the newest message from someone else. */
export function replyTarget(thread: MailThread, account: string): EmailAddress | null {
  const m = newestFromOthers(thread, account);
  if (!m) return null;
  return m.replyTo[0] ?? m.from;
}

/** "Re: <subject>" unless it already is a reply (Re:, AW:, رد:). */
export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^(?:re|aw|sv|antw|رد)\s*:/i.test(s) ? s : `Re: ${s}`;
}

export function threadSummary(
  thread: MailThread,
  conn: ConnectionRef,
  account: string,
): EmailThreadSummary {
  const newest = thread.messages.at(-1)!;
  const participants: EmailAddress[] = [];
  const seen = new Set<string>();
  for (const m of thread.messages)
    for (const a of [m.from, ...m.to, ...m.cc]) {
      const key = a.address.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      participants.push(a);
    }
  return {
    id: thread.id,
    provider: conn.provider,
    connectionId: conn.id,
    subject: truncate(thread.subject, 300),
    participants: participants.slice(0, 20),
    lastMessageFrom: newest.from,
    lastMessageAt: newest.date,
    snippet: truncate(newest.snippet, EMAIL_LIMITS.snippetChars),
    messageCount: thread.messages.length,
    unread: thread.messages.some((m) => m.unread),
    needsReply: needsReply(thread, account),
    webLink: thread.webLink,
  };
}

export const displayAddress = (a: EmailAddress) =>
  a.name ? `${a.name} <${a.address}>` : a.address;
