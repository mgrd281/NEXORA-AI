/**
 * Phase C — offline intents of the integrations domain (owner: integrations
 * engineer): "summarize my unread emails", "what needs my reply", "draft a
 * reply to <sender> saying …", "what's on my calendar", "find a time to meet
 * <address> …", the follow-up "book <day> <time>" and "add <title> to my
 * calendar on <day> at <time>" (en/de/ar; email.ts, calendar.ts), plus the
 * answers to the questions they ask. See ../types.ts for the rules.
 */
import type { OfflineIntent } from '../types';
import {
  answerIntent,
  calendarAddEventIntent,
  calendarBookMeetingIntent,
  calendarFindTimeIntent,
  calendarUpcomingIntent,
} from './calendar';
import { emailDraftReplyIntent, emailNeedsReplyIntent, emailUnreadIntent } from './email';

/** Most specific first: a draft request mentions mail, a booking follow-up a time, and so on. */
const INTENTS: readonly OfflineIntent[] = [
  emailDraftReplyIntent,
  emailNeedsReplyIntent,
  emailUnreadIntent,
  calendarBookMeetingIntent,
  calendarFindTimeIntent,
  calendarAddEventIntent,
  calendarUpcomingIntent,
];

export const integrationIntents: readonly OfflineIntent[] = [answerIntent(INTENTS), ...INTENTS];
