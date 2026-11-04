import type { Catalog } from '../../types';
import type source from '../en/approvals';

const approvals: Catalog<typeof source> = {
  title: {
    email: 'E-Mail prüfen',
    generic: 'Aktion prüfen',
    schedule: 'Zeitplan prüfen',
    memory: 'Prüfen, was JARVIS sich merkt',
  },
  fields: {
    from: 'Von',
    to: 'An',
    subject: 'Betreff',
    body: 'Nachricht',
    noSubject: '(kein Betreff)',
    scheduleTitle: 'Name',
    request: 'Jede Ausführung fragt',
    repeats: 'Wiederholung',
    nextRuns: 'Nächste Ausführungen',
    timeZone: 'Zeitzone',
    rule: 'Regel (RFC 5545)',
    memoryContent: 'Wird gespeichert',
    memoryKind: 'Art',
    source: 'Stammt aus',
  },
  recipients: '{count, plural, one {# Empfänger} other {# Empfänger}}',
  summary: {
    email: '„{subject}“ an {recipients} senden',
  },
  why: 'Warum JARVIS nachfragt',
  reasons: {
    RISK_LOW: 'Diese Aktion hat ein geringes Risiko.',
    RISK_MEDIUM: 'Diese Aktion hat ein mittleres Risiko, deshalb fragt JARVIS vorher nach.',
    RISK_HIGH: 'Diese Aktion hat ein hohes Risiko. JARVIS fragt immer vorher nach.',
    RISK_CRITICAL: 'Diese Aktion ist als kritisches Risiko eingestuft.',
    RECIPIENT_SELF: 'Die E-Mail geht nur an die eigene Adresse.',
    RECIPIENT_EXTERNAL: 'Die E-Mail geht an andere Personen.',
    MANY_RECIPIENTS: 'Die E-Mail hat mehr als drei Empfänger.',
    BUDGET_NEAR_LIMIT:
      'Dieser Schritt kann mehr kosten, als vom monatlichen KI-Budget noch übrig ist.',
    UNTRUSTED_CONTENT:
      'Die Aktion nutzt Inhalte einer Webseite, die Text enthält, der wie Anweisungen an eine KI aussieht.',
    AUTO_APPROVED_SELF:
      'Laut Einstellungen dürfen E-Mails an die eigene Adresse ohne Nachfrage gesendet werden.',
    SKILL_DISABLED: 'Die nötige Fähigkeit ist in den Einstellungen ausgeschaltet.',
    SKILL_COST_LIMIT: 'Das könnte mehr kosten als das Limit dieser Fähigkeit.',
    MEMORY_FROM_CONTENT:
      'Der Text stammt aus einem früheren Ergebnis, daher entscheidest du genau, was JARVIS behält.',
    UNTRUSTED_MEMORY:
      'Der Text stammt aus Inhalten, die KI-Assistenten Anweisungen geben wollten, daher kann er nicht gespeichert werden.',
    FUTURE_RUNS:
      'Damit werden Anfragen eingerichtet, die später von selbst laufen. JARVIS fragt vor dem Anlegen.',
    unknown: 'Die Sicherheitsrichtlinie hat diese Aktion markiert ({code}).',
  },
  untrusted: {
    chip: 'Unsichere Quelle',
    title: 'Text auf {host} hat versucht, KI-Assistenten Anweisungen zu geben.',
    titleNoHost: 'Eine verwendete Quelle hat versucht, KI-Assistenten Anweisungen zu geben.',
    leftOut: 'JARVIS hat diesen Text nicht in die Zusammenfassung übernommen.',
    leftOutCount:
      '{count, plural, one {JARVIS hat diesen Satz nicht in die Zusammenfassung übernommen.} other {JARVIS hat diese # Sätze nicht in die Zusammenfassung übernommen.}}',
    mayInclude: 'Teile davon können in der Nachricht stehen.',
    check: 'Prüf die Nachricht, bevor du sie freigibst.',
  },
  expires: 'Läuft {time} ab',
  note: {
    add: 'Notiz hinzufügen',
    label: 'Notiz',
    hint: 'Wird mit der Entscheidung gespeichert und an niemanden gesendet.',
  },
  approve: {
    email: 'Freigeben und senden',
    generic: 'Freigeben',
    schedule: 'Freigeben und anlegen',
    memory: 'Freigeben und speichern',
  },
  approveLabel: {
    email: 'Diese E-Mail freigeben und senden',
    generic: 'Diese Aktion freigeben',
    schedule: 'Zeitplan freigeben und anlegen',
    memory: 'Erinnerung freigeben und speichern',
  },
  decline: 'Ablehnen',
  declineLabel: {
    email: 'Senden dieser E-Mail ablehnen',
    generic: 'Diese Aktion ablehnen',
    schedule: 'Anlegen dieses Zeitplans ablehnen',
    memory: 'Speichern im Gedächtnis ablehnen',
  },
  results: {
    approved: 'Freigegeben. JARVIS setzt die Aufgabe fort.',
    rejected: 'Abgelehnt. JARVIS führt diese Aktion nicht aus.',
  },
  errors: {
    mismatch: 'Die Aktion hat sich geändert – bitte erneut prüfen.',
    expired: 'Diese Anfrage ist abgelaufen. Die Aufgabe erneut starten, um eine neue zu erhalten.',
    alreadyDecided: 'Über diese Freigabe wurde bereits entschieden.',
  },
  decided: {
    APPROVED: 'Freigegeben {time}.',
    REJECTED: 'Abgelehnt {time}.',
    EXPIRED: 'Diese Anfrage ist {time} abgelaufen.',
    CANCELLED: 'Diese Anfrage wurde abgebrochen.',
    SUPERSEDED: 'Diese Anfrage wurde durch eine neuere ersetzt.',
  },
  scheduleNote:
    'Nichts wird im Voraus freigegeben: Jede Ausführung wird einzeln geplant und geprüft, und was eine Freigabe braucht, fragt dich dann.',
  memorySource: 'Das Ergebnis einer früheren Aufgabe',
  memoryNote:
    'JARVIS behält genau diesen Text. Du kannst ihn später unter „Gedächtnis“ ändern oder löschen.',
  openTask: 'Aufgabe öffnen',
  task: 'Aufgabe',
};

export default approvals;
