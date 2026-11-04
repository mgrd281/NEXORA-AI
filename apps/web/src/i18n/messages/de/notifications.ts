import type { Catalog } from '../../types';
import type source from '../en/notifications';

const notifications: Catalog<typeof source> = {
  title: 'Mitteilungen',
  button:
    '{count, plural, =0 {Mitteilungen} one {Mitteilungen, # ungelesen} other {Mitteilungen, # ungelesen}}',
  unreadSuffix: '{count, plural, one {, # ungelesen} other {, # ungelesen}}',
  markAllRead: 'Alle als gelesen markieren',
  empty: 'Alles gelesen.',
  loadError: 'Mitteilungen konnten nicht geladen werden.',
  unread: 'Ungelesen',
  kinds: {
    approval_requested: '„{taskTitle}“ wartet auf Freigabe',
    task_completed: '„{taskTitle}“ ist erledigt',
    task_failed: '„{taskTitle}“ ist fehlgeschlagen',
    connection_error: 'Eine Verbindung braucht Aufmerksamkeit',
    schedule_failed: 'Eine geplante Ausführung von „{scheduleTitle}“ ist fehlgeschlagen',
    schedule_paused:
      '{reason, select, budget {„{scheduleTitle}“ pausiert: Das KI-Budget für diesen Monat ist aufgebraucht} other {„{scheduleTitle}“ nach wiederholten Fehlern pausiert}}',
    webhook_disabled: 'Webhook an {endpointHost} nach wiederholten Zustellfehlern ausgeschaltet',
    connection_expired: 'Deine Verbindung zu {provider} ist abgelaufen: Verbinde sie neu',
    email_reply_received: '{fromAddress} hat auf „{subject}“ geantwortet',
  },
  kindsUntitled: {
    approval_requested: 'Eine Aufgabe wartet auf Freigabe',
    task_completed: 'Eine Aufgabe ist erledigt',
    task_failed: 'Eine Aufgabe ist fehlgeschlagen',
    connection_error: 'Eine Verbindung braucht Aufmerksamkeit',
    schedule_failed: 'Eine geplante Ausführung ist fehlgeschlagen',
    schedule_paused: 'Ein Zeitplan wurde pausiert',
    webhook_disabled: 'Ein Webhook-Endpunkt wurde nach wiederholten Zustellfehlern ausgeschaltet',
    connection_expired: 'Eine Verbindung ist abgelaufen: Verbinde sie neu',
    email_reply_received: 'In einer beobachteten Unterhaltung ist eine Antwort eingegangen',
  },
};

export default notifications;
