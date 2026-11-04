/**
 * Gmail API v1 client (users.threads.list/get, users.messages.list/send,
 * users.drafts.create). Search queries are built from fields — user text is
 * only ever a quoted phrase or a sanitised address, never concatenated into
 * operators. Sending is exactly once: the Message-ID is derived from the
 * idempotency key and Sent is searched (rfc822msgid:) before every send.
 */
import type { EmailAddress } from '@jarvis/contracts';
import type { DbContext } from '../../../db/pool';
import { extractHtml, normalizeText } from '../../agent/tools/html';
import { providerCall } from '../http';
import { threadNotFound } from '../mail-errors';
import {
  isAutomated,
  parseAddressList,
  type CreatedDraft,
  type DraftReply,
  type MailClient,
  type MailMessage,
  type MailSearch,
  type MailThread,
  type OutgoingMail,
  type SentMail,
} from '../mail-types';
import type { ConnectionRef, IntegrationDeps } from '../types';

const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Reply-To',
  'Subject',
  'Date',
  'Message-ID',
  'References',
  'List-Unsubscribe',
  'List-Id',
  'Auto-Submitted',
  'Precedence',
];

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
  filename?: string;
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Only characters an address can have; anything else is dropped (no operators smuggled in). */
export function gmailOperand(value: string): string {
  const v = value.trim();
  if (/^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+$/.test(v)) return v;
  const phrase = v
    .replace(/["\\(){}:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return phrase ? `"${phrase}"` : '';
}

/** The Gmail `q` for a search, built from fields. */
export function gmailQuery(q: MailSearch): string {
  const parts: string[] = [];
  if (q.inboxOnly) parts.push('in:inbox');
  if (q.unreadOnly) parts.push('is:unread');
  if (q.from) {
    const from = gmailOperand(q.from);
    if (from) parts.push(`from:${from}`);
  }
  if (q.newerThanDays) parts.push(`newer_than:${Math.max(1, Math.floor(q.newerThanDays))}d`);
  if (q.query) {
    const phrase = q.query
      .replace(/["\\(){}:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (phrase) parts.push(`"${phrase}"`);
  }
  return parts.join(' ');
}

const header = (p: GmailPart | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

/** text/plain preferred; HTML through the shared extractor. */
export function bodyText(p: GmailPart | undefined): string {
  if (!p) return '';
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.filename) return; // attachments are not read
    if (type === 'text/plain' && part.body?.data) plain.push(decode(part.body.data));
    else if (type === 'text/html' && part.body?.data) html.push(decode(part.body.data));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(p);
  if (plain.length) return normalizeText(plain.join('\n\n'));
  if (html.length) return extractHtml(html.join('\n')).text;
  return '';
}

function hasAttachments(p: GmailPart | undefined): boolean {
  if (!p) return false;
  if (p.filename && (p.body?.attachmentId || (p.body?.size ?? 0) > 0)) return true;
  return (p.parts ?? []).some(hasAttachments);
}

function toMessage(m: GmailMessage, withText: boolean): MailMessage {
  const p = m.payload;
  const headers: Record<string, string> = {};
  for (const h of p?.headers ?? []) headers[h.name] = h.value;
  const from: EmailAddress = parseAddressList(header(p, 'From'))[0] ?? { name: null, address: '' };
  const labels = new Set(m.labelIds ?? []);
  const date = m.internalDate
    ? new Date(Number(m.internalDate))
    : new Date(Date.parse(header(p, 'Date') ?? '') || Date.now());
  return {
    id: m.id,
    threadId: m.threadId,
    from,
    to: parseAddressList(header(p, 'To')),
    cc: parseAddressList(header(p, 'Cc')),
    replyTo: parseAddressList(header(p, 'Reply-To')),
    date: date.toISOString(),
    subject: header(p, 'Subject') ?? '',
    snippet: (m.snippet ?? '').replace(/\s+/g, ' ').trim(),
    unread: labels.has('UNREAD'),
    hasAttachments: hasAttachments(p),
    inInbox: labels.has('INBOX'),
    automated: isAutomated(headers, from.address),
    internetMessageId: header(p, 'Message-ID'),
    references: header(p, 'References'),
    ...(withText ? { text: bodyText(p) } : {}),
  };
}

/** RFC 2047 for non-ASCII header text; CR/LF can never reach a header. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** A plain-text RFC 5322 message (base64 body), as Gmail's `raw` expects (base64url). */
export function buildRawMessage(m: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  messageIdHeader: string;
  inReplyTo?: string | null;
  references?: string | null;
  date?: Date;
}): string {
  const lines = [
    `From: ${m.from.replace(/[\r\n<>]/g, '')}`,
    `To: ${m.to.map((a) => a.replace(/[\r\n,<>]/g, '')).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map((a) => a.replace(/[\r\n,<>]/g, '')).join(', ')}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${m.messageIdHeader.replace(/[\r\n]/g, '')}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo.replace(/[\r\n]/g, '')}`] : []),
    ...(m.references || m.inReplyTo
      ? [
          `References: ${[m.references, m.inReplyTo]
            .filter(Boolean)
            .join(' ')
            .replace(/[\r\n]/g, ' ')}`,
        ]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (
      Buffer.from(m.body, 'utf8')
        .toString('base64')
        .match(/.{1,76}/g) ?? []
    ).join('\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export function gmailClient(
  deps: IntegrationDeps,
  ctx: DbContext,
  conn: ConnectionRef,
): MailClient {
  const base = deps.config.oauth.google?.endpoints.gmail;
  if (!base) throw new Error('Google is not configured on this server');
  const ref = { id: conn.id, provider: 'google' as const };
  const webLink = (threadId: string) =>
    `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;

  async function getThread(threadId: string, format: 'metadata' | 'full', signal?: AbortSignal) {
    const res = await providerCall(
      deps,
      ctx,
      ref,
      {
        method: 'GET',
        url: `${base}/users/me/threads/${encodeURIComponent(threadId)}`,
        query: { format, ...(format === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {}) },
        accept: [404],
        capability: 'mail.read',
      },
      signal,
    );
    if (res.status === 404) return null;
    const messages = ((res.json?.messages ?? []) as GmailMessage[])
      .filter((m) => !(m.labelIds ?? []).includes('DRAFT'))
      .map((m) => toMessage(m, format === 'full'))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (messages.length === 0) return null;
    return {
      id: threadId,
      subject: messages[0]!.subject,
      messages,
      webLink: webLink(threadId),
    } satisfies MailThread;
  }

  return {
    async search(q, signal) {
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'GET',
          url: `${base}/users/me/threads`,
          query: { q: gmailQuery(q), maxResults: Math.min(100, Math.max(1, q.limit)) },
          capability: 'mail.read',
        },
        signal,
      );
      const ids = ((res.json?.threads ?? []) as { id: string }[])
        .map((t) => t.id)
        .slice(0, q.limit);
      const threads: MailThread[] = [];
      for (const id of ids) {
        const t = await getThread(id, 'metadata', signal);
        if (t) threads.push(t);
      }
      return threads;
    },
    async readThread(threadId, maxMessages, signal) {
      const t = await getThread(threadId, 'full', signal);
      if (!t) return null;
      return { ...t, messages: t.messages.slice(-maxMessages) };
    },
    threadMeta: (threadId, signal) => getThread(threadId, 'metadata', signal),
    async createDraftReply(d: DraftReply, signal): Promise<CreatedDraft> {
      const thread = await getThread(d.threadId, 'metadata', signal);
      if (!thread) throw threadNotFound();
      const last = thread.messages.at(-1)!;
      const raw = buildRawMessage({
        from: conn.accountIdentifier ?? '',
        to: d.to,
        cc: [],
        subject: d.subject,
        body: d.body,
        messageIdHeader: `<jarvis.draft.${Date.now().toString(36)}@${(conn.accountIdentifier ?? 'jarvis.local').split('@')[1] ?? 'jarvis.local'}>`,
        inReplyTo: last.internetMessageId,
        references: last.references,
      });
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: `${base}/users/me/drafts`,
          json: { message: { raw, threadId: d.threadId } },
          accept: [404],
          capability: 'mail.compose',
          unsafe: true,
        },
        signal,
      );
      if (res.status === 404) throw threadNotFound();
      return {
        draftId: String(res.json?.id ?? ''),
        threadId: String(res.json?.message?.threadId ?? d.threadId),
        messageId: res.json?.message?.id ? String(res.json.message.id) : null,
      };
    },
    async send(m: OutgoingMail, signal): Promise<SentMail> {
      // Exactly once: an earlier attempt with this Message-ID may have gone out.
      const found = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'GET',
          url: `${base}/users/me/messages`,
          query: { q: `rfc822msgid:${m.messageIdHeader.replace(/[<>\s]/g, '')}`, maxResults: 1 },
          capability: 'mail.read',
          // Without mail.read the lookup is not allowed: only an acknowledged retry is at risk.
          accept: [403],
        },
        signal,
      );
      const prior = (found.status === 200 ? (found.json?.messages ?? []) : []) as {
        id: string;
        threadId: string;
      }[];
      if (prior[0])
        return {
          messageId: prior[0].id,
          threadId: prior[0].threadId,
          internetMessageId: m.messageIdHeader,
          reconciled: true,
        };
      let inReplyTo: string | null = null;
      let references: string | null = null;
      if (m.threadId) {
        const thread = await getThread(m.threadId, 'metadata', signal);
        if (!thread) throw threadNotFound();
        inReplyTo = thread.messages.at(-1)!.internetMessageId;
        references = thread.messages.at(-1)!.references;
      }
      const raw = buildRawMessage({ ...m, inReplyTo, references });
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: `${base}/users/me/messages/send`,
          json: { raw, ...(m.threadId ? { threadId: m.threadId } : {}) },
          capability: 'mail.send',
          unsafe: true,
        },
        signal,
      );
      return {
        messageId: String(res.json?.id ?? ''),
        threadId: res.json?.threadId ? String(res.json.threadId) : null,
        internetMessageId: m.messageIdHeader,
        reconciled: false,
      };
    },
  };
}
