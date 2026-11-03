import type { Catalog } from '../../types';
import type source from '../en/settings';

const settings: Catalog<typeof source> = {
  title: 'Einstellungen',
  description: 'So arbeitet JARVIS für dich. Änderungen werden sofort gespeichert.',
  navLabel: 'Bereiche der Einstellungen',
  loading: 'Einstellungen werden geladen …',
  sections: {
    profile: 'Profil',
    language: 'Sprache und Region',
    appearance: 'Darstellung',
    voice: 'Sprachsteuerung',
    assistant: 'Assistent und Selbstständigkeit',
    notifications: 'Mitteilungen',
    security: 'Sicherheit',
    privacy: 'Datenschutz und Daten',
  },
  save: {
    saving: 'Wird gespeichert …',
    saved: 'Gespeichert',
    failed: 'Nicht gespeichert. {reason}',
  },
  language: 'Sprache',
  profile: {
    displayName: 'Anzeigename',
    displayNameHint: 'Wird in JARVIS angezeigt und in Begrüßungen verwendet.',
    displayNameRequired: 'Gib einen Namen ein.',
    save: 'Namen speichern',
    email: 'E-Mail',
    emailHint: 'Mit dieser Adresse meldest du dich an. Sie lässt sich hier nicht ändern.',
    memberSince: 'Dabei seit {date}',
  },
  region: {
    languageHint: 'Gilt sofort, auf diesem und deinen anderen Geräten.',
    timeZone: 'Zeitzone',
    timeZoneHint:
      'Für Datums- und Zeitangaben und dafür, wann dein Monatsbudget zurückgesetzt wird.',
    useDevice: 'Zeitzone dieses Geräts verwenden ({zone})',
  },
  appearance: {
    theme: 'Farbschema',
    systemHint: '„System“ folgt der Hell- oder Dunkel-Einstellung deines Geräts.',
  },
  voice: {
    speak: 'Antworten vorlesen',
    speakDescription:
      'Nach einer gesprochenen Anfrage liest JARVIS das Ergebnis auf diesem Gerät vor. Getippte Anfragen werden nie vorgelesen.',
    recognition: 'Erkennungssprache',
    recognitionAuto: 'Wie die Oberfläche ({language})',
    recognitionHint: 'Die Sprache, auf die JARVIS beim Diktieren hört.',
  },
  assistant: {
    statusTitle: 'Status des Assistenten',
    planner: 'Planung',
    plannerModelNote:
      'Anfragen werden von einem externen KI-Modell geplant. Die Kosten zählen zu deinem Monatsbudget.',
    reasons: {
      NO_API_KEY:
        'Auf dem Server ist kein Schlüssel für ein KI-Modell hinterlegt, daher plant JARVIS offline. Das klappt für eine feste Auswahl an Befehlen, offene Fragen kann JARVIS so nicht beantworten.',
      USER_DISABLED_EXTERNAL_MODELS:
        'Du hast externe KI-Modelle ausgeschaltet. JARVIS plant daher offline und sendet nichts an einen KI-Anbieter.',
      BUDGET_EXHAUSTED:
        'Das KI-Budget für diesen Monat ist aufgebraucht. JARVIS plant offline, bis das Budget zurückgesetzt wird oder du es erhöhst.',
      BUDGET_ZERO:
        'Dein monatliches KI-Budget ist 0, daher plant JARVIS offline und nutzt nie ein kostenpflichtiges Modell.',
      unknown: 'Gerade ist kein KI-Modell verfügbar, daher plant JARVIS offline.',
    },
    worker: 'Worker',
    workerHealthy: 'Läuft',
    workerUnhealthy: 'Reagiert nicht',
    workerUnhealthyNote: 'Neue Anfragen warten in der Warteschlange, bis der Worker wieder läuft.',
    heartbeat: 'Letztes Lebenszeichen {time}',
    noHeartbeat: 'Noch kein Lebenszeichen empfangen',
    version: 'Version',
    capabilities: 'Was JARVIS gerade kann',
    capability: {
      webFetch: 'Webseiten lesen',
      email: 'E-Mails senden',
      memory: 'Gedächtnis nutzen',
      generalQuestions: 'Offene Fragen beantworten',
    },
    capabilityOn: 'Verfügbar',
    capabilityOff: 'Nicht verfügbar',
    capabilityFix: {
      webFetch: 'Webzugriff aktivieren',
      email: 'E-Mail verbinden',
      memory: 'Gedächtnis einschalten',
      generalQuestions: 'Braucht ein KI-Modell',
    },
    statusFailed: 'JARVIS konnte den Status des Assistenten nicht laden.',
    externalModels: 'Externe KI-Modelle erlauben',
    externalModelsDescription:
      'Wenn aktiv, können deine Anfrage und passende Erinnerungen an den auf diesem Server eingerichteten KI-Anbieter gesendet werden, um sie zu planen und zu beantworten. Wenn aus, geht nichts an ein externes Modell und JARVIS plant offline.',
    autoApprove: 'E-Mails an mich ohne Rückfrage senden',
    autoApproveDescription:
      'Wenn aktiv, wird eine E-Mail, deren Empfänger alle deine eigene Adresse ({email}) sind, ohne Rückfrage gesendet. Jede E-Mail an andere braucht weiterhin deine Freigabe – ebenso eine E-Mail, die JARVIS als ungewöhnlich einstuft, etwa weil sie auf verdächtigen Webinhalten beruht.',
    budget: 'Monatliches KI-Budget',
    budgetHint:
      'Die Kosten für KI-Modelle enden jeden Monat bei diesem Betrag; danach plant JARVIS offline. Gib 0 ein, um nie kostenpflichtige Modelle zu nutzen.',
    budgetUnit: 'USD',
    budgetSave: 'Budget speichern',
    budgetInvalid: 'Gib einen Betrag von 0 bis 10.000 ein.',
    usageTitle: 'Dieser Monat',
    usageSpent: '{spent} von {budget}',
    usageSpentNoBudget: '{spent} ausgegeben',
    usageMeter: 'Verbrauchtes KI-Budget',
    usageMeterText: '{spent} von {budget} verbraucht',
    usageNoPaid: 'Kostenpflichtige KI-Modelle sind aus, weil das Budget 0 ist.',
    usageBreakdown: 'KI-Modelle {ai} · Werkzeuge {tools}',
    usageResets: 'Wird am {date} zurückgesetzt',
    usageExhausted:
      'Das Budget für diesen Monat ist aufgebraucht. JARVIS plant offline, bis es zurückgesetzt wird.',
    usageFailed: 'JARVIS konnte den Verbrauch dieses Monats nicht laden.',
    tasksCompleted: 'Abgeschlossen',
    tasksFailed: 'Fehlgeschlagen oder abgebrochen',
    tasksTotal: 'Aufgaben in diesem Monat',
  },
  notifications: {
    description:
      'Das sind Mitteilungen in der App: Sie erscheinen unter der Glocke in JARVIS. Es wird nichts per E-Mail oder an dein Telefon gesendet.',
    approvalRequested: 'Freigabeanfragen',
    approvalRequestedDescription:
      'Wenn JARVIS deine Freigabe braucht, bevor es handelt. Freigaben warten auch dann unter „Aufgaben“ auf dich, wenn das aus ist.',
    taskCompleted: 'Abgeschlossene Aufgaben',
    taskCompletedDescription: 'Wenn eine Aufgabe erfolgreich beendet ist.',
    taskFailed: 'Fehlgeschlagene Aufgaben',
    taskFailedDescription: 'Wenn eine Aufgabe fehlschlägt oder nicht weitergehen kann.',
    connectionNote:
      'Bei Problemen mit einer Verbindung bekommst du immer eine Mitteilung, damit JARVIS weiterarbeiten kann.',
  },
  security: {
    sessionsTitle: 'Angemeldete Geräte',
    sessionsDescription: 'Melde ein Gerät ab, das du nicht kennst oder nicht mehr verwendest.',
    browserOn: '{browser} unter {os}',
    unknownBrowser: 'Unbekannter Browser',
    unknownDevice: 'Unbekanntes Gerät',
    platforms: {
      web: 'Web',
      ios: 'App für iPhone oder iPad',
      android: 'Android-App',
      macos: 'Mac-App',
    },
    thisDevice: 'Dieses Gerät',
    lastActive: 'Aktiv {time}',
    signedIn: 'Angemeldet am {date}',
    revoke: 'Abmelden',
    revokeLabel: '{device} abmelden',
    revoked: '{device} wurde abgemeldet.',
    signOut: 'Abmelden',
    signOutLabel: 'Auf diesem Gerät abmelden',
    signingOut: 'Abmeldung läuft …',
    loading: 'Geräte werden geladen …',
    failed: 'JARVIS konnte deine Geräte nicht laden.',
  },
  privacy: {
    memoryTitle: 'Gedächtnis',
    memoryDescription: 'Schalte das Gedächtnis ein oder aus und sieh, was sich JARVIS merkt.',
    memoryLink: 'Gedächtnis verwalten',
    exportTitle: 'Deine Daten exportieren',
    exportDescription:
      'Lade alles, was JARVIS über dich speichert, als eine JSON-Datei herunter: Profil, Einstellungen, Aufgaben, Freigaben, Erinnerungen, Mitteilungen und Verbindungen. Passwörter und Schlüssel sind nie enthalten.',
    exportButton: 'Meine Daten exportieren',
    exporting: 'Export wird vorbereitet …',
    exported: '{file} heruntergeladen',
    deleteTitle: 'Konto löschen',
    deleteDescription:
      'Löscht dein Konto und alles darin endgültig: Aufgaben, Erinnerungen, Verbindungen und gespeicherte Passwörter.',
    deleteButton: 'Konto löschen …',
    deleteDialog: {
      title: 'Dein Konto löschen?',
      body: 'Alles in deinem Konto wird sofort gelöscht und lässt sich nicht wiederherstellen. Du wirst auf allen Geräten abgemeldet.',
      exportFirst: 'Exportiere vorher deine Daten, wenn du eine Kopie behalten möchtest.',
      password: 'Dein Passwort',
      confirmLabel: 'Zur Bestätigung DELETE eingeben',
      confirmHint: 'Gib das Wort DELETE in Großbuchstaben ein.',
      wrongPassword: 'Das Passwort ist falsch.',
      confirm: 'Konto endgültig löschen',
      deleting: 'Wird gelöscht …',
    },
  },
};

export default settings;
