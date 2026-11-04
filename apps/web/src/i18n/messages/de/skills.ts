import type { Catalog } from '../../types';
import type source from '../en/skills';

const skills: Catalog<typeof source> = {
  description:
    'Was JARVIS kann – und was du davon erlaubst. Eine ausgeschaltete Fähigkeit plant und führt JARVIS nicht aus. Fähigkeiten gewähren nie Berechtigungen: Die Sicherheitsrichtlinie prüft weiterhin jeden Schritt, und alles Riskante fragt dich vorher.',
  loading: 'Fähigkeiten werden geladen …',
  loadError: 'Die Fähigkeiten konnten nicht geladen werden.',
  listLabel: 'Fähigkeiten',
  plannedTitle: 'Später geplant',
  plannedDescription:
    'Im Produktplan beschrieben, aber noch nicht gebaut. Sie können nicht laufen.',
  status: {
    on: 'An',
    off: 'Aus',
    needsConnection: 'Verbindung nötig',
    unavailable: 'Nicht verfügbar',
    planned: 'Geplant',
    core: 'Immer an',
  },
  reasons: {
    PLANNED: 'Noch nicht gebaut.',
    DISABLED_BY_USER: 'Ausgeschaltet. JARVIS plant und führt ihre Aktionen nicht aus.',
    CONNECTION_REQUIRED: 'Braucht {connections}.',
    MODEL_REQUIRED: 'Braucht ein KI-Modell, und gerade ist keines verfügbar.',
    MEMORY_DISABLED: 'Das Gedächtnis ist ausgeschaltet.',
    STORAGE_NOT_CONFIGURED: 'Auf diesem Server ist kein Dateispeicher eingerichtet.',
    PROVIDER_NOT_CONFIGURED:
      'Auf diesem Server ist keine Verbindung zu Google oder Microsoft eingerichtet.',
    BROWSER_UNAVAILABLE: 'Der Browser-Agent läuft auf diesem Server nicht.',
    TELEPHONY_NOT_CONFIGURED: 'Anrufe sind auf diesem Server nicht eingerichtet.',
  },
  connections: {
    web: 'Webzugriff',
    smtp: 'eine E-Mail-Verbindung',
    google: 'ein Google-Konto',
    microsoft: 'ein Microsoft-Konto',
  },
  connect: 'Verbindungen öffnen',
  risk: {
    LOW: 'Liest nur oder bereitet etwas für dich vor, daher läuft es ohne Nachfrage.',
    MEDIUM: 'Handelt in deinem Namen, daher fragt JARVIS dich vorher.',
    HIGH: 'Kann echte Folgen haben, daher fragt JARVIS dich immer vorher.',
    CRITICAL: 'Hätte schwerwiegende Folgen – das macht JARVIS nie.',
  },
  model: {
    required: 'Braucht ein KI-Modell.',
    optional: 'Nutzt ein KI-Modell, wenn eines verfügbar ist.',
    none: 'Funktioniert ohne KI-Modell.',
  },
  core: 'Gehört dazu, wie JARVIS plant und nachfragt, und lässt sich daher nicht ausschalten.',
  memoryNote: 'Derselbe Schalter wie „Gedächtnis verwenden“ auf der Gedächtnis-Seite.',
  turnedOn: '{name} eingeschaltet.',
  turnedOff: '{name} ausgeschaltet.',
  names: {
    'web-research': 'Webrecherche',
    'email-management': 'E-Mail',
    'calendar-management': 'Kalender',
    'appointment-booking': 'Terminbuchung',
    'phone-calling': 'Telefonate',
    'shopping-assistant': 'Einkaufen',
    'document-analysis': 'Dokumente',
    'task-scheduling': 'Zeitpläne',
    'personal-memory': 'Gedächtnis',
    'device-automation': 'Geräteautomatisierung',
    translation: 'Übersetzung',
    'workflow-planning': 'Planung und Rückfragen',
  },
  descriptions: {
    'web-research': 'Liest öffentliche Webseiten, die du verlinkst, und fasst sie zusammen.',
    'email-management':
      'Schreibt E-Mails und sendet sie über dein verbundenes Postfach – jede erst nach deiner Freigabe.',
    'calendar-management': 'Liest deinen Kalender und schlägt Änderungen vor oder nimmt sie vor.',
    'appointment-booking': 'Bucht Termine bei Unternehmen für dich.',
    'phone-calling': 'Telefoniert für dich und sagt dabei, dass es eine KI ist.',
    'shopping-assistant': 'Vergleicht Produkte und bereitet Käufe vor, die du bestätigst.',
    'document-analysis':
      'Liest Dateien, die du anhängst (PDF, Word, Text, CSV), und fasst sie zusammen.',
    'task-scheduling': 'Führt Anfragen täglich, wöchentlich oder monatlich für dich aus.',
    'personal-memory':
      'Merkt sich Fakten und Vorlieben, die du teilst, und berücksichtigt sie beim Planen.',
    'device-automation': 'Steuert Apps und Geräte für dich.',
    translation: 'Übersetzt Texte, Ergebnisse und Dokumente in andere Sprachen.',
    'workflow-planning':
      'Plant jede Anfrage, beantwortet Fragen, fragt nach, wenn etwas fehlt, und nutzt frühere Ergebnisse eines Gesprächs.',
  },
};

export default skills;
