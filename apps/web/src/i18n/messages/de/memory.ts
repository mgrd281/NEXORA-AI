import type { Catalog } from '../../types';
import type source from '../en/memory';

const memory: Catalog<typeof source> = {
  title: 'Gedächtnis',
  description: 'Was sich JARVIS über dich merkt und wie es das nutzt. Nur du kannst das sehen.',
  kinds: {
    preference: 'Vorliebe',
    fact: 'Fakt',
  },
  sources: {
    user: 'Du',
    assistant: 'JARVIS',
  },
  empty: 'JARVIS hat sich noch nichts gemerkt.',
  disabled: 'Das Gedächtnis ist ausgeschaltet. JARVIS liest und speichert keine Erinnerungen.',
  toggle: {
    label: 'Gedächtnis verwenden',
    description:
      'JARVIS bezieht passende Erinnerungen ein, wenn es eine Anfrage plant – auch wenn die Anfrage an ein externes KI-Modell geht – und speichert neue, wenn du es bittest, sich etwas zu merken.',
  },
  retentionRule:
    'Erinnerungen, die {period} lang nicht geändert wurden, werden einmal täglich automatisch gelöscht.',
  retentionKept:
    'Erinnerungen bleiben, bis du sie löschst. Wähle einen Zeitraum, damit alte automatisch gelöscht werden.',
  disabledBanner:
    'Solange das Gedächtnis aus ist, wird nichts davon verwendet oder ergänzt. Deine Erinnerungen bleiben erhalten, bis du sie löschst.',
  search: {
    label: 'Erinnerungen durchsuchen',
    placeholder: 'Erinnerungen durchsuchen',
    results:
      '{count, plural, =0 {Keine Erinnerung passt.} one {# Erinnerung passt.} other {# Erinnerungen passen.}}',
    resultsMore: 'Mehr als {count} Erinnerungen passen.',
  },
  add: {
    title: 'Erinnerung hinzufügen',
    label: 'Neue Erinnerung',
    placeholder: 'Etwas, das JARVIS wissen oder berücksichtigen soll',
    kindLegend: 'Art der Erinnerung',
    kindHint: {
      fact: 'Etwas, das auf dich zutrifft, etwa wo du arbeitest.',
      preference: 'Wie du Dinge gern hast, etwa einen Gangplatz im Flugzeug.',
    },
    save: 'Erinnerung speichern',
    saved: 'Erinnerung gespeichert',
    count: '{count} / {max}',
    required: 'Schreib zuerst die Erinnerung.',
    tooLong: 'Höchstens {max} Zeichen.',
  },
  list: {
    title: 'Deine Erinnerungen',
    addedByYou: 'Von dir hinzugefügt',
    savedByJarvis: 'Von JARVIS gespeichert',
    viewTask: 'Zur Aufgabe',
    added: 'Hinzugefügt {time}',
    edited: 'Bearbeitet {time}',
    loading: 'Erinnerungen werden geladen …',
    loadMore: 'Mehr anzeigen',
    emptyFull:
      'JARVIS hat sich noch nichts gemerkt. Füge oben einen Fakt oder eine Vorliebe hinzu oder bitte JARVIS, sich etwas zu merken.',
    noResults: 'Keine Erinnerung passt zu „{query}“.',
    clearSearch: 'Suche zurücksetzen',
  },
  item: {
    editLabel: 'Erinnerung bearbeiten: {preview}',
    deleteLabel: 'Erinnerung löschen: {preview}',
    editField: 'Erinnerung',
    save: 'Änderungen speichern',
    updated: 'Erinnerung aktualisiert',
    deleted: 'Erinnerung gelöscht',
  },
  deleteDialog: {
    title: 'Diese Erinnerung löschen?',
    body: 'JARVIS vergisst sie. Das lässt sich nicht rückgängig machen.',
    confirm: 'Erinnerung löschen',
  },
  deleteAll: {
    title: 'Alle Erinnerungen löschen',
    description:
      'JARVIS vergisst alles auf dieser Seite. Deine Aufgaben, Verbindungen und Einstellungen bleiben unverändert.',
    button: 'Alle Erinnerungen löschen …',
    dialogTitle: 'Alle Erinnerungen löschen?',
    counting: 'Deine Erinnerungen werden gezählt …',
    countFailed: 'JARVIS konnte deine Erinnerungen nicht zählen.',
    body: '{count, plural, =0 {Es gibt keine Erinnerungen zum Löschen.} one {Damit wird deine einzige Erinnerung endgültig gelöscht.} other {Damit werden alle # Erinnerungen endgültig gelöscht.}}',
    consequence: 'JARVIS verwendet sie danach nicht mehr. Das lässt sich nicht rückgängig machen.',
    confirm: '{count, plural, one {# Erinnerung löschen} other {# Erinnerungen löschen}}',
    done: '{count, plural, =0 {Es wurden keine Erinnerungen gelöscht.} one {# Erinnerung gelöscht.} other {# Erinnerungen gelöscht.}}',
  },
};

export default memory;
