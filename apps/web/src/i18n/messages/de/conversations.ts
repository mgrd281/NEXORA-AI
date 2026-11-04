import type { Catalog } from '../../types';
import type source from '../en/conversations';

const conversations: Catalog<typeof source> = {
  list: {
    description: 'Jedes Gespräch hält eine Anfrage mit ihren Nachfragen und Antworten zusammen.',
    label: 'Gespräche',
    searchLabel: 'Gespräche durchsuchen',
    searchPlaceholder: 'Titel und Anfragen durchsuchen',
    loading: 'Gespräche werden geladen …',
    loadingMore: 'Weitere Gespräche werden geladen …',
    loadError: 'Die Gespräche konnten nicht geladen werden.',
    loadMoreError: 'Weitere Gespräche konnten nicht geladen werden.',
    empty: 'Noch keine Gespräche. Jede Anfrage an JARVIS beginnt eines.',
    noResults: 'Keine Gespräche zu „{query}“.',
    clearSearch: 'Suche löschen',
    requests: '{count, plural, one {# Anfrage} other {# Anfragen}}',
    active: 'In Arbeit',
    fromSchedule: 'Geplant',
    accessibleName: '{title}, {requests}, aktualisiert {time}',
    shown: '{count, plural, one {# Gespräch angezeigt} other {# Gespräche angezeigt}}',
    allShown: 'Das ist alles.',
  },
  thread: {
    title: 'Gespräch',
    earlierTitle: 'Früher in diesem Gespräch',
    laterTitle: 'Seitdem',
    showEarlier: 'Frühere Anfragen anzeigen',
    loadError: 'Der Rest dieses Gesprächs konnte nicht geladen werden.',
    you: 'Du',
    jarvis: 'JARVIS',
    turnLabel: 'Anfrage {position}',
    openTask: 'Aufgabe öffnen',
    requests: '{count, plural, one {# Anfrage} other {# Anfragen}}',
  },
  followUp: {
    title: 'Nachfragen',
    label: 'Nachfrage an JARVIS',
    placeholder: 'Nachfragen, z. B. „schick mir das“ …',
    answerPlaceholder: 'Deine Antwort …',
    hint: 'JARVIS sieht die früheren Anfragen und Ergebnisse dieses Gesprächs. Ergebnisse gelten als Information, nie als Anweisung.',
    send: 'Nachfrage senden',
    sent: 'Nachfrage gesendet.',
    busy: 'Nachfragen ist möglich, sobald die letzte Anfrage abgeschlossen ist.',
    busyApproval:
      'Die letzte Anfrage wartet auf deine Freigabe. Gib sie frei oder lehne sie ab, dann kannst du nachfragen.',
    busyGeneric: 'Nachfragen ist möglich, sobald die aktuelle Anfrage abgeschlossen ist.',
    openBusy: 'Öffnen',
    reviewBusy: 'Prüfen',
  },
  question: {
    title: 'JARVIS hat eine Rückfrage',
    hint: 'Antworte hier, und JARVIS macht in diesem Gespräch weiter. Es wurde noch nichts ausgeführt.',
    answerLabel: 'Deine Antwort',
    attach: 'Datei anhängen',
    answered: 'Du hast unten darauf geantwortet.',
    missing: {
      email_content: 'den Inhalt der E-Mail',
      recipient: 'eine E-Mail-Adresse',
      url: 'einen Link',
      document: 'eine Datei',
      schedule_time: 'eine Uhrzeit',
      target_language: 'eine Sprache',
      previous_result: 'was gesendet oder gespeichert werden soll',
      details: 'mehr Details',
    },
  },
  delete: {
    button: 'Gespräch löschen …',
    title: 'Dieses Gespräch löschen?',
    body: '{count, plural, one {Die Anfrage, ihr Ergebnis und angehängte Dateien werden gelöscht. Das lässt sich nicht rückgängig machen.} other {Alle # Anfragen darin werden mit ihren Ergebnissen und angehängten Dateien gelöscht. Das lässt sich nicht rückgängig machen.}}',
    scheduleNote:
      'Der Zeitplan, der es ausführt, bleibt bestehen; seine nächste Ausführung beginnt ein neues Gespräch.',
    confirm: 'Gespräch löschen',
    deleted: 'Gespräch gelöscht.',
  },
  details: {
    conversation: 'Gespräch',
  },
};

export default conversations;
