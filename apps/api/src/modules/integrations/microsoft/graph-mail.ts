/**
 * Microsoft Graph mail client (Outlook): inbox / mailbox messages grouped by
 * conversationId, bodies as text (Prefer: outlook.body-content-type="text"),
 * reply drafts (createReply + PATCH, Mail.ReadWrite = mail.compose), and
 * exactly-once sending with Mail.Send alone (mail.send, least privilege):
 * POST /me/sendMail (or …/reply in a thread) with a single-value extended
 * property holding the idempotency key, saved to Sent Items; every attempt
 * first looks the tag up in Sent Items (already sent → reconciled, nothing is
 * sent again). The lookup needs Mail.Read; without it only an acknowledged
 * retry after OUTCOME_UNKNOWN is at risk of a duplicate.
 */
import type { EmailAddress } from '@jarvis/contracts';
import type { DbContext } from '../../../db/pool';
import { normalizeText } from '../../agent/tools/html';
import { providerCall } from '../http';
import { threadNotFound } from '../mail-errors';
import {
  isAutomated,
  type CreatedDraft,
  type MailClient,
  type MailMessage,
  type MailSearch,
  type MailThread,
  type OutgoingMail,
  type SentMail,
} from '../mail-types';
import type { ConnectionRef, IntegrationDeps } from '../types';

/** JARVIS's extended property (a fixed GUID namespace) carrying the idempotency key. */
export const GRAPH_KEY_PROPERTY =
  'String {5f2b9a4e-3c1d-4e8f-9a7b-6d0c1e2f3a4b} Name JarvisIdempotencyKey';

const SELECT = [
  'id',
  'conversationId',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'replyTo',
  'receivedDateTime',
  'bodyPreview',
  'isRead',
  'isDraft',
  'hasAttachments',
  'webLink',
  'internetMessageId',
  'internetMessageHeaders',
  'parentFolderId',
].join(',');

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  body?: { contentType?: string; content?: string };
}

const addr = (r: GraphRecipient | undefined): EmailAddress => ({
  name:
    r?.emailAddress?.name && r.emailAddress.name !== r.emailAddress.address
      ? r.emailAddress.name
      : null,
  address: (r?.emailAddress?.address ?? '').toLowerCase(),
});

/** OData string literal ('' escapes a quote). */
export const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function toMessage(m: GraphMessage, inInbox: boolean, withText: boolean): MailMessage {
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) headers[h.name] = h.value;
  const from = addr(m.from);
  return {
    id: m.id,
    threadId: m.conversationId ?? m.id,
    from,
    to: (m.toRecipients ?? []).map(addr),
    cc: (m.ccRecipients ?? []).map(addr),
    replyTo: (m.replyTo ?? []).map(addr),
    date: new Date(m.receivedDateTime ?? Date.now()).toISOString(),
    subject: m.subject ?? '',
    snippet: (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
    unread: m.isRead === false,
    hasAttachments: !!m.hasAttachments,
    inInbox,
    automated: isAutomated(headers, from.address),
    internetMessageId: m.internetMessageId ?? null,
    references: headers.References ?? null,
    ...(withText ? { text: normalizeText(m.body?.content ?? '') } : {}),
  };
}

function group(messages: MailMessage[], webLinks: Map<string, string>): MailThread[] {
  const byThread = new Map<string, MailMessage[]>();
  for (const m of messages) {
    const list = byThread.get(m.threadId) ?? [];
    list.push(m);
    byThread.set(m.threadId, list);
  }
  return [...byThread.entries()]
    .map(([id, list]) => {
      list.sort((a, b) => a.date.localeCompare(b.date));
      return { id, subject: list[0]!.subject, messages: list, webLink: webLinks.get(id) ?? null };
    })
    .sort((a, b) => b.messages.at(-1)!.date.localeCompare(a.messages.at(-1)!.date));
}

export function graphMailClient(
  deps: IntegrationDeps,
  ctx: DbContext,
  conn: ConnectionRef,
): MailClient {
  const graph = deps.config.oauth.microsoft?.endpoints.graph;
  if (!graph) throw new Error('Microsoft is not configured on this server');
  const ref = { id: conn.id, provider: 'microsoft' as const };

  async function conversation(threadId: string, withText: boolean, signal?: AbortSignal) {
    const res = await providerCall(
      deps,
      ctx,
      ref,
      {
        method: 'GET',
        url: `${graph}/me/messages`,
        query: {
          $filter: `conversationId eq ${odataString(threadId)}`,
          $select: withText ? `${SELECT},body` : SELECT,
          $top: 50,
        },
        headers: withText ? { prefer: 'outlook.body-content-type="text"' } : {},
        capability: 'mail.read',
      },
      signal,
    );
    const raw = ((res.json?.value ?? []) as GraphMessage[]).filter((m) => !m.isDraft);
    if (raw.length === 0) return null;
    const links = new Map<string, string>();
    for (const m of raw) if (m.webLink) links.set(m.conversationId ?? m.id, m.webLink);
    return group(
      raw.map((m) => toMessage(m, true, withText)),
      links,
    )[0]!;
  }

  async function byTag(folder: 'sentitems' | 'drafts', key: string, signal?: AbortSignal) {
    const res = await providerCall(
      deps,
      ctx,
      ref,
      {
        method: 'GET',
        url: `${graph}/me/mailFolders/${folder}/messages`,
        query: {
          $filter: `singleValueExtendedProperties/Any(ep: ep/id eq ${odataString(GRAPH_KEY_PROPERTY)} and ep/value eq ${odataString(key)})`,
          $select: 'id,conversationId,internetMessageId,isDraft',
          $top: 1,
        },
        capability: 'mail.read',
        accept: [403],
      },
      signal,
    );
    return res.status === 200 ? (((res.json?.value ?? []) as GraphMessage[])[0] ?? null) : null;
  }

  return {
    async search(q: MailSearch, signal) {
      const filters: string[] = [];
      if (q.unreadOnly) filters.push('isRead eq false');
      if (q.newerThanDays)
        filters.push(
          `receivedDateTime ge ${new Date(Date.now() - q.newerThanDays * 86_400_000).toISOString()}`,
        );
      let search: string | undefined;
      const fromIsAddress = !!q.from && /^[^\s@]+@[^\s@]+$/.test(q.from.trim());
      if (q.from && fromIsAddress)
        filters.push(`from/emailAddress/address eq ${odataString(q.from.trim())}`);
      else if (q.from) search = `"from:${q.from.replace(/["\\]/g, ' ').trim()}"`;
      if (q.query) search = `"${q.query.replace(/["\\]/g, ' ').trim()}"`;
      const folderPath =
        q.inboxOnly || q.unreadOnly ? '/me/mailFolders/inbox/messages' : '/me/messages';
      const res = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'GET',
          url: `${graph}${folderPath}`,
          query: {
            $select: SELECT,
            $top: Math.min(100, Math.max(1, q.limit * 3)),
            // $search cannot be combined with $filter / $orderby: filter those client-side.
            ...(search ? { $search: search } : {}),
            ...(!search && filters.length ? { $filter: filters.join(' and ') } : {}),
            ...(!search ? { $orderby: 'receivedDateTime desc' } : {}),
          },
          capability: 'mail.read',
        },
        signal,
      );
      let raw = ((res.json?.value ?? []) as GraphMessage[]).filter((m) => !m.isDraft);
      if (search && q.unreadOnly) raw = raw.filter((m) => m.isRead === false);
      const links = new Map<string, string>();
      for (const m of raw) if (m.webLink) links.set(m.conversationId ?? m.id, m.webLink);
      const inbox = folderPath.includes('inbox');
      return group(
        raw.map((m) => toMessage(m, inbox, false)),
        links,
      ).slice(0, q.limit);
    },
    async readThread(threadId, maxMessages, signal) {
      const t = await conversation(threadId, true, signal);
      return t ? { ...t, messages: t.messages.slice(-maxMessages) } : null;
    },
    threadMeta: (threadId, signal) => conversation(threadId, false, signal),
    async createDraftReply(d, signal): Promise<CreatedDraft> {
      const thread = await conversation(d.threadId, false, signal);
      if (!thread) throw threadNotFound();
      const target = thread.messages.at(-1)!;
      const created = await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'POST',
          url: `${graph}/me/messages/${encodeURIComponent(target.id)}/createReply`,
          json: {},
          accept: [404],
          capability: 'mail.compose',
          unsafe: true,
        },
        signal,
      );
      if (created.status === 404) throw threadNotFound();
      const draftId = String(created.json?.id ?? '');
      // Exactly the approved recipients, subject and body.
      await providerCall(
        deps,
        ctx,
        ref,
        {
          method: 'PATCH',
          url: `${graph}/me/messages/${encodeURIComponent(draftId)}`,
          json: {
            subject: d.subject,
            toRecipients: d.to.map((address) => ({ emailAddress: { address } })),
            body: { contentType: 'Text', content: d.body },
          },
          capability: 'mail.compose',
          unsafe: true,
        },
        signal,
      );
      return {
        draftId,
        threadId: String(created.json?.conversationId ?? d.threadId),
        messageId: draftId,
      };
    },
    async send(m: OutgoingMail, signal): Promise<SentMail> {
      // Exactly once: an earlier attempt carrying this key may have gone out.
      const sent = await byTag('sentitems', m.key, signal);
      if (sent)
        return {
          messageId: sent.id,
          threadId: sent.conversationId ?? null,
          internetMessageId: sent.internetMessageId ?? null,
          reconciled: true,
        };
      const message = {
        subject: m.subject,
        body: { contentType: 'Text', content: m.body },
        toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: m.cc.map((address) => ({ emailAddress: { address } })),
        singleValueExtendedProperties: [{ id: GRAPH_KEY_PROPERTY, value: m.key }],
      };
      let threadId: string | null = null;
      if (m.threadId) {
        // A reply in the conversation (POST …/reply needs only Mail.Send; reading it, Mail.Read).
        const thread = await conversation(m.threadId, false, signal);
        if (!thread) throw threadNotFound();
        threadId = thread.id;
        await providerCall(
          deps,
          ctx,
          ref,
          {
            method: 'POST',
            url: `${graph}/me/messages/${encodeURIComponent(thread.messages.at(-1)!.id)}/reply`,
            json: {
              message: {
                toRecipients: message.toRecipients,
                ccRecipients: message.ccRecipients,
                singleValueExtendedProperties: message.singleValueExtendedProperties,
              },
              comment: m.body,
            },
            capability: 'mail.send',
            unsafe: true,
          },
          signal,
        );
      } else {
        // POST /me/sendMail needs only Mail.Send (least privilege); the copy in Sent Items keeps the tag.
        await providerCall(
          deps,
          ctx,
          ref,
          {
            method: 'POST',
            url: `${graph}/me/sendMail`,
            json: { message, saveToSentItems: true },
            capability: 'mail.send',
            unsafe: true,
          },
          signal,
        );
      }
      // The provider's id of the sent copy, read back by the tag (needs Mail.Read; best effort).
      const after = await byTag('sentitems', m.key, signal).catch(() => null);
      return {
        messageId: after?.id ?? `sent:${m.key}`,
        threadId: after?.conversationId ?? threadId,
        internetMessageId: after?.internetMessageId ?? null,
        reconciled: false,
      };
    },
  };
}
