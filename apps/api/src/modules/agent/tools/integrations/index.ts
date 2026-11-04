/**
 * Phase C — tools of the integrations domain (docs/architecture/phase-c.md §2):
 * email.search, email.read_thread, email.draft_reply, email.track_replies,
 * calendar.list, calendar.free_busy, calendar.create_event,
 * calendar.update_event, calendar.cancel_event.
 *
 * Owner: integrations engineer. The registry (tools/registry.ts) includes
 * every tool exported here; nothing else needs to change to register one. A
 * tool listed here must have a full ToolDefinition (risk, idempotency,
 * timeout, retry, preview, approval details, verify, audit) and use the Phase
 * C hooks for the facts the Policy Engine decides on (requires, bind,
 * attendees). Its id must be a contracts ToolId owned by a skill in
 * skills/registry.ts (both checked at load and by unit tests).
 *
 * email.send (tools/email-send.ts) is extended in place by the same owner
 * (`via`: smtp | google | microsoft).
 */
import type { AnyTool } from '../types';
import { calendarCreateEventTool } from './calendar-create-event';
import { calendarFreeBusyTool } from './calendar-free-busy';
import { calendarListTool } from './calendar-list';
import { calendarCancelEventTool, calendarUpdateEventTool } from './calendar-update-event';
import { emailDraftReplyTool } from './email-draft-reply';
import { emailReadThreadTool } from './email-read-thread';
import { emailSearchTool } from './email-search';
import { emailTrackRepliesTool } from './email-track-replies';

export const integrationTools: readonly AnyTool[] = [
  emailSearchTool,
  emailReadThreadTool,
  emailDraftReplyTool,
  emailTrackRepliesTool,
  calendarListTool,
  calendarFreeBusyTool,
  calendarCreateEventTool,
  calendarUpdateEventTool,
  calendarCancelEventTool,
];
