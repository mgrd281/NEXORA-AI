import type { Suggestion } from '@jarvis/contracts';

/**
 * Home suggestions are derived only from the user's real state — never
 * canned or random. Clients own the copy; these are the i18n keys the web and
 * native apps must define (listed in priority order; at most three are shown):
 *
 *   suggest.enableWeb          kind 'connect', href '/connections'
 *       Web access is not active, so JARVIS cannot read public web pages yet.
 *   suggest.connectEmail       kind 'connect', href '/connections'
 *       No way to send email yet: no working SMTP mailbox (none connected, or
 *       its last verification failed) and no active Google / Microsoft
 *       account granting mail.send (Phase C).
 *   suggest.configureModel     kind 'review', href '/settings#assistant'
 *       The planner runs offline (deterministic rules engine). The client may
 *       explain why using AssistantStatus.planner.reason.
 *   suggest.summarizeAndEmail  kind 'command', command null
 *       Web access and email both work — e.g. "Summarize <page> and email it
 *       to me". The client puts its localized example into the command bar.
 *   suggest.remember           kind 'command', command null
 *       Memory is enabled but empty — e.g. "Remember that …". The client puts
 *       its localized example into the command bar.
 *
 * `command` is always null: the server does not author user-facing text.
 */
export interface SuggestionState {
  /** A non-revoked web connection with status 'active' exists. */
  webActive: boolean;
  /**
   * A non-revoked SMTP connection with status 'active' exists, or (Phase C) an
   * active Google / Microsoft connection granting mail.send.
   */
  emailActive: boolean;
  /** AssistantStatus.planner.mode === 'offline'. */
  plannerOffline: boolean;
  /** preferences.memory.enabled. */
  memoryEnabled: boolean;
  /** Whether the user has at least one stored memory. */
  hasMemories: boolean;
}

export const MAX_SUGGESTIONS = 3;

export function deriveSuggestions(s: SuggestionState): Suggestion[] {
  const out: Suggestion[] = [];
  if (!s.webActive) {
    out.push({
      id: 'connect-web',
      kind: 'connect',
      messageKey: 'suggest.enableWeb',
      command: null,
      href: '/connections',
    });
  }
  if (!s.emailActive) {
    out.push({
      id: 'connect-email',
      kind: 'connect',
      messageKey: 'suggest.connectEmail',
      command: null,
      href: '/connections',
    });
  }
  if (s.plannerOffline) {
    out.push({
      id: 'configure-model',
      kind: 'review',
      messageKey: 'suggest.configureModel',
      command: null,
      href: '/settings#assistant',
    });
  }
  if (s.webActive && s.emailActive) {
    out.push({
      id: 'summarize-and-email',
      kind: 'command',
      messageKey: 'suggest.summarizeAndEmail',
      command: null,
      href: null,
    });
  }
  if (s.memoryEnabled && !s.hasMemories) {
    out.push({
      id: 'remember',
      kind: 'command',
      messageKey: 'suggest.remember',
      command: null,
      href: null,
    });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}
