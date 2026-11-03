import type { Catalog } from '../../types';
import type source from '../en/home';

const home: Catalog<typeof source> = {
  title: 'Start',
  greeting: {
    morning: 'Guten Morgen, {name}',
    afternoon: 'Guten Tag, {name}',
    evening: 'Guten Abend, {name}',
  },
  greetingAnonymous: {
    morning: 'Guten Morgen',
    afternoon: 'Guten Tag',
    evening: 'Guten Abend',
  },
  status: {
    ready: 'Bereit',
    offlinePlanner: 'Bereit im Basismodus',
    approvals: '{count, plural, one {Wartet auf Freigabe} other {# Anfragen warten auf Freigabe}}',
    working: '{count, plural, one {Arbeitet an # Aufgabe} other {Arbeitet an # Aufgaben}}',
    queued:
      '{count, plural, one {# Aufgabe wartet auf den Start} other {# Aufgaben warten auf den Start}}',
  },
  sections: {
    approvals: 'Freigabe nötig',
    active: 'In Arbeit',
    recent: 'Letzte Ergebnisse',
  },
  sectionCount: '{count, plural, one {# Eintrag} other {# Einträge}}',
  viewAll: 'Alle anzeigen',
  approval: {
    review: 'Prüfen',
    reviewLabel: 'Prüfen: {title}',
    expires: 'Läuft ab {time}',
  },
  loading: 'Übersicht wird geladen …',
  loadError: 'Die Übersicht konnte nicht geladen werden.',
  firstRun: {
    title: 'Bitte JARVIS um etwas – in deinen eigenen Worten',
    body: 'JARVIS plant die Schritte, prüft sie anhand deiner Sicherheitseinstellungen und zeigt dir alles, was in deinem Namen handelt, bevor es passiert.',
    stepPlan: 'Du siehst den Plan, bevor etwas läuft',
    stepApprove: 'E-Mails und andere Aktionen warten auf deine Freigabe',
    stepEvidence: 'Jedes Ergebnis kommt mit Nachweisen',
    tryLabel: 'Probier zum Beispiel',
  },
  examples: {
    summarize: 'Fasse https://www.w3.org/TR/WCAG22/ zusammen',
    remember: 'Merk dir, dass ich auf Flügen Gangplätze bevorzuge',
    emailMe: 'Schick mir: Freitag den Zahnarzt anrufen',
  },
  suggestionsLabel: 'Vorschläge',
  suggestionFills: 'Setzt diese Anfrage in die Befehlszeile',
  suggest: {
    enableWeb: 'JARVIS das Lesen öffentlicher Webseiten erlauben',
    connectEmail: 'E-Mail verbinden, damit JARVIS Nachrichten senden kann',
    configureModel: 'JARVIS läuft ohne KI-Modell – ansehen, was es kann',
    summarizeAndEmail: 'Eine Webseite zusammenfassen und per E-Mail an dich selbst senden',
    remember: 'JARVIS etwas zum Merken sagen',
  },
  suggestCommands: {
    summarizeAndEmail: 'Fasse https:// zusammen und schick sie mir per E-Mail',
    remember: 'Merk dir, dass ',
  },
};

export default home;
