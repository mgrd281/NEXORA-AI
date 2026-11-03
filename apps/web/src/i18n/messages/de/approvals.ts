import type { Catalog } from '../../types';
import type source from '../en/approvals';

const approvals: Catalog<typeof source> = {
  title: {
    email: 'E-Mail prüfen',
    generic: 'Aktion prüfen',
  },
  fields: {
    from: 'Von',
    to: 'An',
    subject: 'Betreff',
    body: 'Nachricht',
    noSubject: '(kein Betreff)',
  },
  recipients: '{count, plural, one {# Empfänger} other {# Empfänger}}',
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
      'Sie verwendet Inhalte einer Webseite, die Text enthält, der wie Anweisungen an eine KI aussieht.',
    AUTO_APPROVED_SELF:
      'Laut Einstellungen dürfen E-Mails an die eigene Adresse ohne Nachfrage gesendet werden.',
    unknown: 'Die Sicherheitsrichtlinie hat diese Aktion markiert ({code}).',
  },
  untrustedWarning:
    'In der Quelle wurden mutmaßliche Anweisungen an eine KI gefunden. Die Nachricht vor der Freigabe sorgfältig lesen.',
  expires: 'Läuft {time} ab',
  note: {
    add: 'Notiz hinzufügen',
    label: 'Notiz',
    hint: 'Wird mit der Entscheidung gespeichert und an niemanden gesendet.',
  },
  approve: {
    email: 'Freigeben und senden',
    generic: 'Freigeben',
  },
  approveLabel: {
    email: 'Diese E-Mail freigeben und senden',
    generic: 'Diese Aktion freigeben',
  },
  decline: 'Ablehnen',
  declineLabel: {
    email: 'Senden dieser E-Mail ablehnen',
    generic: 'Diese Aktion ablehnen',
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
  openTask: 'Aufgabe öffnen',
  task: 'Aufgabe',
};

export default approvals;
