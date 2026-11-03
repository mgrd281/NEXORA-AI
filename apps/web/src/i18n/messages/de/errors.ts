import type { Catalog } from '../../types';
import type source from '../en/errors';

const errors: Catalog<typeof source> = {
  codes: {
    UNAUTHENTICATED: 'Die Sitzung ist beendet. Bitte erneut anmelden.',
    FORBIDDEN: 'Kein Zugriff auf diesen Bereich.',
    NOT_FOUND: 'Nicht vorhanden oder bereits gelöscht.',
    VALIDATION_FAILED: 'Einige Angaben fehlen oder sind ungültig.',
    CONFLICT: 'Das wurde inzwischen geändert. Aktualisieren und erneut versuchen.',
    RATE_LIMITED: 'Zu viele Anfragen. Kurz warten und erneut versuchen.',
    IDEMPOTENCY_MISMATCH:
      'Diese Anfrage wurde bereits mit anderen Angaben gesendet. Bitte neu beginnen.',
    INVALID_STATE: 'Das ist im aktuellen Zustand nicht möglich.',
    APPROVAL_EXPIRED: 'Diese Freigabeanfrage ist abgelaufen.',
    APPROVAL_MISMATCH: 'Die Aktion hat sich nach der Anzeige geändert. Bitte erneut prüfen.',
    CONNECTION_REQUIRED: 'Dafür ist eine Verbindung nötig, die noch nicht eingerichtet ist.',
    CONNECTION_FAILED: 'Mit diesen Einstellungen konnte JARVIS keine Verbindung herstellen.',
    MODEL_NOT_CONFIGURED: 'Dafür ist ein KI-Modell nötig, und es ist keines eingerichtet.',
    MODEL_ERROR: 'Das KI-Modell hat einen Fehler gemeldet. Später erneut versuchen.',
    PLANNER_UNSUPPORTED: 'Ohne KI-Modell kann JARVIS diese Anfrage nicht planen.',
    POLICY_DENIED: 'Die Einstellungen oder die Sicherheitsrichtlinie erlauben das nicht.',
    BUDGET_EXCEEDED: 'Das KI-Budget für diesen Monat reicht dafür nicht aus.',
    TOOL_FAILED: 'Ein Schritt ist bei der Ausführung fehlgeschlagen.',
    TOOL_TIMEOUT: 'Ein Schritt hat zu lange gedauert und wurde gestoppt.',
    OUTCOME_UNKNOWN:
      'JARVIS kann nicht bestätigen, ob das passiert ist. Vor einem erneuten Versuch prüfen.',
    VERIFICATION_FAILED: 'JARVIS konnte das Ergebnis nicht überprüfen.',
    FETCH_BLOCKED: 'Diese Webadresse ist nicht erlaubt.',
    INTERNAL: 'Bei uns ist etwas schiefgelaufen.',
  },
  network: 'JARVIS ist nicht erreichbar. Internetverbindung prüfen.',
  badResponse: 'JARVIS hat eine unerwartete Antwort gesendet. Seite neu laden.',
  generic: 'Etwas ist schiefgelaufen.',
  details: 'Details',
  requestId: 'Anfrage-ID',
};

export default errors;
