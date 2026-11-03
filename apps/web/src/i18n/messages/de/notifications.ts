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
  },
  kindsUntitled: {
    approval_requested: 'Eine Aufgabe wartet auf Freigabe',
    task_completed: 'Eine Aufgabe ist erledigt',
    task_failed: 'Eine Aufgabe ist fehlgeschlagen',
    connection_error: 'Eine Verbindung braucht Aufmerksamkeit',
  },
};

export default notifications;
