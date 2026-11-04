import type { Catalog } from '../../types';
import type source from '../en/schedules';

const schedules: Catalog<typeof source> = {
  description:
    'Anfragen, die JARVIS nach Zeitplan für dich ausführt. Jede Ausführung wird wie eine neue Anfrage geplant und geprüft, und was deine Freigabe braucht, fragt dich weiterhin.',
  new: 'Neuer Zeitplan',
  listLabel: 'Zeitpläne',
  empty:
    'Noch nichts geplant. Plane eine Anfrage, damit JARVIS sie täglich, wöchentlich oder monatlich ausführt.',
  loading: 'Zeitpläne werden geladen …',
  loadError: 'Die Zeitpläne konnten nicht geladen werden.',
  limit: '{count} von {max} Zeitplänen',
  status: {
    active: 'Aktiv',
    paused: 'Pausiert',
    completed: 'Beendet',
  },
  pausedReason: {
    user: 'Von dir pausiert.',
    failures: 'Nach {count} fehlgeschlagenen Ausführungen in Folge pausiert.',
    budget: 'Pausiert, weil das KI-Budget für diesen Monat aufgebraucht ist.',
  },
  completedNote: 'Alle Ausführungen sind erledigt.',
  next: 'Nächste Ausführung',
  lastRun: 'Letzte Ausführung',
  noRunsYet: 'Noch keine Ausführung',
  runCount: '{count, plural, one {# Ausführung} other {# Ausführungen}}',
  inZone: '{time} ({zone})',
  request: 'Jede Ausführung fragt',
  createdByAgent: 'JARVIS hat diesen Zeitplan aus einer Anfrage angelegt, die du freigegeben hast.',
  actions: {
    pause: 'Pausieren',
    resume: 'Fortsetzen',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    history: 'Ausführungen anzeigen',
    hideHistory: 'Ausführungen ausblenden',
    openConversation: 'Gespräch öffnen',
  },
  actionFor: '{action}: {title}',
  toasts: {
    created: 'Zeitplan angelegt.',
    saved: 'Zeitplan gespeichert.',
    paused: 'Zeitplan pausiert. Er läuft erst wieder, wenn du ihn fortsetzt.',
    resumed: 'Zeitplan fortgesetzt.',
    deleted: 'Zeitplan gelöscht.',
  },
  deleteDialog: {
    title: 'Diesen Zeitplan löschen?',
    body: 'JARVIS führt „{title}“ nicht mehr aus. Bereits erstellte Aufgaben bleiben im Verlauf.',
    confirm: 'Zeitplan löschen',
  },
  history: {
    upcoming: 'Als Nächstes',
    upcomingNone: 'Keine anstehenden Ausführungen.',
    recent: 'Letzte Ausführungen',
    recentNone: 'Noch keine Ausführungen.',
    loading: 'Ausführungen werden geladen …',
    loadError: 'Die Ausführungen konnten nicht geladen werden.',
    run: {
      created: 'Ausgeführt',
      skipped: 'Übersprungen',
      failed: 'Nicht gestartet',
    },
    reasons: {
      BUDGET_EXHAUSTED: 'Das KI-Budget war aufgebraucht.',
      SCHEDULE_PAUSED: 'Der Zeitplan war pausiert.',
      CREATE_FAILED: 'Die Aufgabe konnte nicht erstellt werden.',
    },
    taskGone: 'Die Aufgabe wurde gelöscht.',
  },
  editor: {
    createTitle: 'Neuer Zeitplan',
    editTitle: 'Zeitplan bearbeiten',
    name: 'Name',
    namePlaceholder: 'Zum Beispiel: Wöchentliche Zusammenfassung zum AI Act',
    nameRequired: 'Gib dem Zeitplan einen Namen.',
    request: 'Was soll JARVIS jedes Mal tun?',
    requestPlaceholder:
      'Zum Beispiel: Fasse https://example.com/news zusammen und schick es mir per E-Mail',
    requestHint:
      'Wie eine normale Anfrage formuliert. Jede Ausführung wird beim Start geplant und geprüft; was eine Freigabe braucht, fragt dich dann.',
    requestRequired: 'Schreib, was JARVIS tun soll.',
    frequencyLegend: 'Wiederholung',
    frequency: {
      daily: 'Täglich',
      weekly: 'Wöchentlich',
      monthly: 'Monatlich',
    },
    interval: 'Wie oft',
    intervalOption: {
      daily: '{count, plural, one {Jeden Tag} other {Alle # Tage}}',
      weekly: '{count, plural, one {Jede Woche} other {Alle # Wochen}}',
      monthly: '{count, plural, one {Jeden Monat} other {Alle # Monate}}',
    },
    daysLegend: 'An diesen Tagen',
    daysRequired: 'Wähle mindestens einen Tag.',
    dayOfMonth: 'Tag des Monats',
    dayOfMonthHint: 'Monate ohne diesen Tag werden übersprungen.',
    lastDay: 'Letzter Tag des Monats',
    time: 'Uhrzeit',
    timeZone: 'Zeitzone',
    preview: 'Nächste Ausführungen',
    previewLoading: 'Nächste Ausführungen werden berechnet …',
    previewNone: 'Dieser Zeitplan würde nie ausgeführt.',
    ends: 'Endet',
    create: 'Zeitplan anlegen',
    save: 'Änderungen speichern',
  },
  recurrence: {
    daily: '{count, plural, one {Täglich um {time}} other {Alle # Tage um {time}}}',
    weekly: '{count, plural, one {Jeden {days} um {time}} other {Alle # Wochen am {days} um {time}}}',
    workdays:
      '{count, plural, one {Montag bis Freitag um {time}} other {Alle # Wochen, Montag bis Freitag, um {time}}}',
    monthly:
      '{count, plural, one {Monatlich am {days} um {time}} other {Alle # Monate am {days} um {time}}}',
    ordinal: {
      one: '{n}.',
      two: '{n}.',
      few: '{n}.',
      other: '{n}.',
    },
    lastDay: 'letzten Tag',
    until: '{phrase}, bis {date}',
    count: '{phrase}, {count, plural, one {einmal} other {# Mal}} insgesamt',
  },
};

export default schedules;
