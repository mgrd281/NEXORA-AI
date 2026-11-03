import type { Catalog } from '../../types';
import type source from '../en/shell';

const shell: Catalog<typeof source> = {
  brand: 'JARVIS – Start',
  nav: {
    label: 'Hauptnavigation',
    home: 'Start',
    tasks: 'Aufgaben',
    memory: 'Gedächtnis',
    connections: 'Verbindungen',
    settings: 'Einstellungen',
    admin: 'Administration',
  },
  tasksBadge: '{count, plural, one {# Freigabe ausstehend} other {# Freigaben ausstehend}}',
  account: {
    menu: 'Konto',
    signOut: 'Abmelden',
    signingOut: 'Abmeldung läuft …',
    signOutFailed: 'Abmelden nicht möglich. Bitte erneut versuchen.',
    settings: 'Einstellungen',
    admin: 'Administration',
    shortcuts: 'Tastenkürzel',
  },
  assistantStatus: {
    label: 'Assistentenstatus',
    open: 'Assistentenstatus: {status}. Assistenteneinstellungen öffnen.',
  },
  banners: {
    offline: 'Keine Internetverbindung – Änderungen werden nicht gesendet.',
    unavailable: 'JARVIS ist nicht erreichbar – Aufgaben warten in der Warteschlange.',
    reconnecting: 'Live-Aktualisierungen pausiert. Verbindung wird wiederhergestellt …',
  },
  shortcuts: {
    title: 'Tastenkürzel',
    focusComposer: 'JARVIS von jeder Seite aus fragen',
    focusComposerHere: 'Zum Anfragefeld dieser Seite springen',
    showShortcuts: 'Tastenkürzel anzeigen',
    send: 'Anfrage senden',
    newLine: 'Neue Zeile in einer Anfrage',
    closeOverlay: 'Dialog oder Bereich schließen',
    singleKey: 'Kürzel mit einer Taste',
    singleKeyHint:
      '/ und ? ohne Zusatztaste nutzen. Schalte das aus, wenn du Spracheingabe oder andere Eingabehilfen verwendest.',
  },
  placeholder: {
    building: 'Diese Ansicht wird gerade gebaut.',
  },
  pageTitles: {
    task: 'Aufgabe',
    signIn: 'Anmelden',
    components: 'Komponenten',
    notFound: 'Seite nicht gefunden',
  },
  notFound: {
    title: 'Diese Seite gibt es nicht',
    body: 'Der Link ist möglicherweise fehlerhaft, oder die Seite wurde verschoben.',
    home: 'Zur Startseite',
  },
  loading: 'Arbeitsbereich wird geladen …',
};

export default shell;
