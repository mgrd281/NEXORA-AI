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
    PAYLOAD_TOO_LARGE: 'Die Datei ist zu groß.',
    UNSUPPORTED_MEDIA_TYPE: 'Mit dieser Art von Datei kann JARVIS nichts anfangen.',
    SERVICE_UNAVAILABLE: 'Das ist auf diesem Server gerade nicht verfügbar.',
    INTERNAL: 'Bei uns ist etwas schiefgelaufen.',
  },
  reasons: {
    INVALID_URL: 'Das ist keine gültige Webadresse.',
    UNSUPPORTED_SCHEME: 'JARVIS öffnet nur Adressen, die mit http oder https beginnen.',
    EMBEDDED_CREDENTIALS:
      'Die Adresse enthält einen Benutzernamen oder ein Passwort, daher öffnet JARVIS sie nicht.',
    MISSING_HOST: 'In der Adresse fehlt der Hostname.',
    PRIVATE_ADDRESS:
      '{host} liegt in einem privaten oder lokalen Netzwerk, daher öffnet JARVIS es nicht.',
    FETCH_TIMEOUT:
      '{host} hat nicht innerhalb von {seconds, plural, one {# Sekunde} other {# Sekunden}} geantwortet.',
    HOST_NOT_FOUND: 'Für {host} wurde kein Server gefunden.',
    CONNECT_FAILED: 'JARVIS konnte keine Verbindung zu {host} herstellen.',
    TLS_CERTIFICATE: 'Das Sicherheitszertifikat von {host} ist ungültig.',
    FETCH_FAILED: '{host} konnte nicht gelesen werden.',
    UNSUPPORTED_ENCODING:
      'Die Seite verwendet eine Zeichenkodierung, die JARVIS nicht lesen kann ({encoding}).',
    PAGE_TOO_LARGE: 'Die Seite ist größer als {limitMb} MB.',
    TOO_MANY_REDIRECTS: 'Die Adresse hat mehr als {max}-mal weitergeleitet.',
    HTTP_ERROR: '{host} hat mit HTTP {status} geantwortet.',
    UNSUPPORTED_CONTENT_TYPE: 'Die Adresse liefert {contentType}, das kann JARVIS nicht lesen.',
    MISSING_CONTENT_TYPE: 'Der Server hat nicht angegeben, welche Art von Inhalt er sendet.',
    NO_READABLE_TEXT: 'Die Seite enthält keinen lesbaren Text.',
    EMAIL_NOT_CONNECTED: 'Es ist kein E-Mail-Konto verbunden.',
    SMTP_AUTH: 'Der Mailserver hat Benutzername oder Passwort nicht akzeptiert.',
    SMTP_REFUSED: 'Der Mailserver hat die Nachricht abgelehnt (Antwort {responseCode}).',
    SMTP_CONNECT: 'JARVIS konnte den Mailserver nicht erreichen.',
    SMTP_UNUSABLE: 'Mit diesen Mailserver-Einstellungen kann nicht gesendet werden.',
    SEND_INTERRUPTED: 'Die Verbindung zum Mailserver ist beim Senden abgebrochen.',
    SEND_TIMEOUT: 'Der Mailserver hat beim Senden nicht mehr geantwortet.',
    STEP_INTERRUPTED: '„{step}“ wurde unterbrochen, bevor der Schritt fertig war.',
    STEP_TIMEOUT: '„{step}“ hat zu lange gedauert und wurde gestoppt.',
    STEP_CRASHED: '„{step}“ wurde wegen eines unerwarteten Fehlers beendet.',
    INVALID_STEP_INPUT:
      '„{step}“ hat Eingaben erhalten, mit denen der Schritt nichts anfangen kann.',
    UNKNOWN_TOOL: 'Der Plan nutzt ein Werkzeug, das diese JARVIS-Version nicht hat ({tool}).',
    VERIFICATION_FAILED: 'Diese Schritte haben die Prüfung nicht bestanden: {steps}.',
    OFFLINE_UNSUPPORTED: 'Ohne KI-Modell versteht JARVIS nur wenige Arten von Anfragen.',
    MEMORY_TOO_LONG: 'Eine Notiz darf höchstens {max} Zeichen lang sein.',
    INVALID_PLAN: 'Der Plan von JARVIS war ungültig.',
    NO_TOOLS: 'Keines der dafür nötigen Werkzeuge ist verfügbar.',
    PLANNING_FAILED: 'JARVIS konnte für diese Anfrage keinen Plan erstellen.',
    CONNECTION_MISSING:
      '„{step}“ braucht eine Verbindung, die nicht eingerichtet ist oder nicht funktioniert.',
    MEMORY_DISABLED: 'Das Gedächtnis ist in deinen Datenschutzeinstellungen ausgeschaltet.',
    RISK_CRITICAL: 'Die Aktion ist als kritisch eingestuft, so etwas macht JARVIS nie.',
    BUDGET_ZERO: 'Dein monatliches KI-Budget steht auf 0 $.',
    BUDGET_EXHAUSTED: 'Das KI-Budget für diesen Monat ist aufgebraucht.',
    EXTERNAL_MODELS_DISABLED: 'Externe KI-Modelle sind in deinen Einstellungen ausgeschaltet.',
    MODEL_UNAVAILABLE: 'Auf diesem Server ist kein KI-Modell verfügbar.',
    POLICY_DENIED: 'Die Sicherheitsrichtlinie hat „{step}“ blockiert.',
    ATTACHMENT_NOT_FOUND: 'Die angehängte Datei existiert nicht mehr.',
    ATTACHMENT_UNREADABLE:
      'JARVIS konnte die angehängte Datei nicht lesen. Möglicherweise ist sie beschädigt.',
    ATTACHMENT_ENCRYPTED: 'Die Datei ist passwortgeschützt, daher kann JARVIS sie nicht lesen.',
    DOCUMENT_NO_TEXT:
      'Das Dokument enthält keinen Text, den JARVIS lesen kann – zum Beispiel, weil es ein Scan ist. Gescannte Seiten zu lesen ist noch nicht möglich.',
    DOCUMENT_TOO_MANY_PAGES: 'Das Dokument hat mehr als {max} Seiten.',
    STORAGE_UNAVAILABLE: 'Der Dateispeicher ist gerade nicht erreichbar.',
    UNSUPPORTED_LANGUAGE: 'In {language} kann JARVIS nicht übersetzen.',
    NOTHING_TO_RECALL:
      'In diesem Gespräch gibt es kein früheres Ergebnis, das sich verwenden lässt.',
    SCHEDULE_LIMIT_REACHED: 'Du hast bereits {max} Zeitpläne, mehr sind nicht möglich.',
    INVALID_RECURRENCE: 'Die Wiederholungsregel des Zeitplans ist ungültig.',
    SKILL_DISABLED:
      'Dafür ist die Fähigkeit „{skill}“ nötig, die in den Einstellungen ausgeschaltet ist.',
    UNTRUSTED_MEMORY:
      'JARVIS speichert das nicht im Gedächtnis: Es stammt aus Inhalten, die versucht haben, KI-Assistenten Anweisungen zu geben.',
    CONNECTION_EXPIRED:
      'Deine Verbindung zu {provider} ist abgelaufen. Verbinde sie neu und versuche es dann noch einmal.',
    CONNECTION_SCOPE_MISSING:
      '{provider} hat JARVIS diese Berechtigung nicht erteilt: {capability}. Verbinde neu, erlaube sie und versuche es dann noch einmal.',
    PROVIDER_RATE_LIMITED:
      '{provider} begrenzt gerade die Anfragen. Versuche es in ein paar Minuten noch einmal.',
    PROVIDER_UNAVAILABLE: '{provider} antwortet gerade nicht. Versuche es später noch einmal.',
    PROVIDER_REJECTED: '{provider} hat die Anfrage abgelehnt (Fehler {status}).',
    EMAIL_THREAD_NOT_FOUND: 'Diese Unterhaltung gibt es in deinem Postfach nicht mehr.',
    WATCH_LIMIT_REACHED:
      'JARVIS beobachtet schon {max} Unterhaltungen auf Antworten, mehr geht nicht.',
    CALENDAR_CONFLICT:
      'Zu dieser Zeit ist in deinem Kalender schon etwas eingetragen, daher hat JARVIS nichts eingetragen.',
    EVENT_NOT_FOUND: 'Diesen Termin gibt es in deinem Kalender nicht mehr.',
    EVENT_CHANGED:
      'Der Termin hat sich geändert, nachdem JARVIS ihn gelesen hat, daher wurde nichts geändert. Frag noch einmal.',
    NO_FREE_SLOTS: 'In diesem Zeitraum ist keine Zeit frei.',
    INVALID_TIME_RANGE: 'Beginn und Ende ergeben keinen gültigen Zeitraum.',
    CAPTCHA_DETECTED:
      '{host} verlangt einen Nachweis, dass du ein Mensch bist. JARVIS löst so etwas nie: Mach selbst auf der Website weiter.',
    LOGIN_REQUIRED:
      '{host} verlangt eine Anmeldung. JARVIS meldet sich nicht für dich an: Mach selbst auf der Website weiter.',
    BOT_PROTECTION:
      '{host} blockiert automatisierte Besuche. JARVIS umgeht das nicht: Mach selbst auf der Website weiter.',
    SITE_UNSUPPORTED: 'JARVIS unterstützt {host} noch nicht.',
    NAVIGATION_BLOCKED:
      'Die Website wollte JARVIS zu {host} führen. Das ist nicht erlaubt, daher wurde abgebrochen.',
    PAGE_CHANGED:
      '{host} sieht anders aus, als JARVIS erwartet, daher wurde abgebrochen statt zu raten.',
    SITE_ERROR: '{host} hat einen Fehler angezeigt (Status {status}).',
    BROWSER_BUDGET_EXCEEDED:
      'Die Website brauchte mehr Schritte, als JARVIS erlaubt ({limit}), daher wurde abgebrochen.',
    BROWSER_TIMEOUT: 'Die Website hat zu lange gebraucht, daher wurde abgebrochen.',
    BROWSER_CRASHED: 'Der Browser wurde unerwartet beendet.',
    BROWSER_UNAVAILABLE: 'Der Browser-Agent läuft auf diesem Server nicht.',
    SLOT_TAKEN: 'Der Termin wurde inzwischen vergeben, daher wurde nichts gebucht.',
    BOOKING_DETAILS_MISSING:
      'Das Buchungsformular braucht Angaben, die JARVIS nicht hat: {fields}.',
    BOOKING_UNCONFIRMED:
      'Die Buchung wurde gesendet, aber die Website hat keine Bestätigung angezeigt. Prüfe das auf der Website, bevor du es noch einmal versuchst.',
    PRICE_CHANGED:
      'Der Preis hat sich von {expected} auf {actual} geändert, daher wurde nichts bestellt.',
    OUT_OF_STOCK: 'Der Artikel ist nicht vorrätig, daher wurde nichts bestellt.',
    CHECKOUT_UNSUPPORTED:
      'JARVIS kann auf {host} nicht bestellen. Dein Warenkorb ist dort bereit: Schließ den Kauf selbst ab.',
    ORDER_UNKNOWN:
      'Die Bestellung wurde beim Absenden unterbrochen. Prüf deine Bestellungen beim Shop, bevor du es noch einmal versuchst.',
    PURCHASES_DISABLED:
      'Käufe sind ausgeschaltet. Leg in den Einstellungen ein monatliches Kauflimit fest, um sie zu erlauben.',
    PURCHASE_LIMIT:
      'Dieser Kauf ({amount}) würde dein monatliches Limit von {limit} überschreiten ({spent} schon ausgegeben).',
    PURCHASE_CURRENCY:
      'Der Preis ist in {currency}, dein Kauflimit aber in US-Dollar, daher kauft JARVIS das nicht.',
    CALL_BUSY:
      'Die Leitung war besetzt. Es wurde nichts gesagt oder vereinbart. Du kannst es erneut versuchen.',
    CALL_NO_ANSWER:
      'Niemand hat abgenommen. Es wurde nichts gesagt oder vereinbart. Du kannst es später erneut versuchen.',
    CALL_FAILED:
      'Der Telefonanbieter konnte den Anruf nicht verbinden. Es wurde nichts gesagt oder vereinbart.',
    CALL_VOICEMAIL:
      'Statt einer Person hat eine Mailbox abgenommen. Du kannst es später erneut versuchen.',
    CALL_HUNG_UP:
      'Die andere Person hat aufgelegt, bevor das Ziel erreicht war. Es wurde nichts vereinbart.',
    CALL_DECLINED:
      'Die andere Person wollte das Gespräch nicht fortsetzen – sie möchte nicht mehr angerufen werden oder nicht mit einem KI-Assistenten sprechen. JARVIS ruft diese Nummer nicht mehr an.',
    CALL_DURATION_LIMIT:
      'Der Anruf hat seine Höchstdauer von {seconds, plural, one {# Sekunde} other {# Sekunden}} erreicht, bevor das Ziel erreicht war.',
    RECORDING_CONSENT_DECLINED:
      'Die andere Person hat der verlangten Aufzeichnung nicht zugestimmt, deshalb hat JARVIS das Gespräch höflich beendet.',
    CALL_STATE_UNKNOWN:
      'JARVIS kann nicht feststellen, ob der Anruf aufgebaut wurde. Prüfe es, bevor du es erneut versuchst – JARVIS fragt zuerst beim Telefonanbieter nach.',
    PHONE_NUMBER_INVALID: '{number} ist keine gültige Telefonnummer.',
    NUMBER_NOT_LITERAL:
      'JARVIS ruft nur Nummern an, die du selbst schreibst. Schreib die Nummer mit Ländervorwahl.',
    DO_NOT_CALL: '{number} möchte nicht mehr angerufen werden, deshalb ruft JARVIS dort nicht an.',
    CALL_OUTSIDE_HOURS:
      'JARVIS ruft nur zwischen {start} und {end} ({timeZone}) an. Versuch es dann erneut.',
    CALL_LIMIT:
      'JARVIS hat heute schon {max} Anrufe getätigt, so viele wie erlaubt. Versuch es morgen erneut.',
    CALL_DESTINATION_BLOCKED:
      'JARVIS ruft diese Nummer nicht an: Mehrwertnummern und Länder, die dieser Server nicht anruft, sind gesperrt.',
    TELEPHONY_NOT_CONFIGURED: 'Anrufe sind auf diesem Server nicht eingerichtet.',
  },
  api: {
    FILE_TOO_LARGE: 'Dateien dürfen höchstens {limitMb} MB groß sein.',
    UNSUPPORTED_FILE_TYPE: 'JARVIS liest PDF-, Word- (.docx), Text-, Markdown- und CSV-Dateien.',
    FILE_CONTENT_MISMATCH: 'Der Inhalt der Datei passt nicht zu ihrem Dateityp.',
    FILE_EMPTY: 'Die Datei ist leer.',
    TOO_MANY_ATTACHMENTS: 'An eine Anfrage lassen sich höchstens {max} Dateien anhängen.',
    ATTACHMENT_NOT_FOUND:
      'Eine der Dateien existiert nicht mehr. Entferne sie und hänge sie erneut an.',
    ATTACHMENT_EXPIRED:
      'Eine der Dateien ist abgelaufen, bevor sie gesendet wurde. Hänge sie erneut an.',
    ATTACHMENT_IN_OTHER_CONVERSATION:
      'Eine der Dateien gehört zu einem anderen Gespräch. Hänge sie hier erneut an.',
    STORAGE_NOT_CONFIGURED: 'Datei-Uploads sind auf diesem Server nicht eingerichtet.',
    STORAGE_UNAVAILABLE: 'Der Dateispeicher ist gerade nicht erreichbar. Gleich erneut versuchen.',
    CONVERSATION_BUSY:
      'JARVIS arbeitet noch an diesem Gespräch. Warte, bis es fertig ist, oder brich es ab, und sende dann deine Nachfrage.',
    CONVERSATION_ACTIVE_TASK:
      'Eine Aufgabe in diesem Gespräch läuft noch. Warte, bis sie fertig ist, oder brich sie ab, und lösche dann das Gespräch.',
    SCHEDULE_LIMIT_REACHED:
      'Es sind höchstens {max} Zeitpläne möglich. Lösche einen, um einen neuen anzulegen.',
    INVALID_RECURRENCE: 'Diese Wiederholungsregel ist ungültig.',
    RECURRENCE_HAS_NO_OCCURRENCES:
      'Dieser Zeitplan würde nie ausgeführt. Prüfe die gewählten Tage.',
    UNKNOWN_TIME_ZONE: 'Diese Zeitzone kennt der Server nicht. Wähle eine andere.',
    SCHEDULE_COMPLETED:
      'Für diesen Zeitplan sind keine Ausführungen mehr übrig, daher lässt er sich nicht fortsetzen.',
    WEBHOOK_LIMIT_REACHED: 'Es sind höchstens {max} Webhook-Endpunkte möglich.',
    WEBHOOK_URL_INVALID:
      'Gib eine vollständige https://-Adresse ohne Benutzernamen, Passwort oder #-Fragment ein.',
    WEBHOOK_URL_INSECURE: 'Webhook-Adressen müssen mit https:// beginnen.',
    WEBHOOK_URL_BLOCKED:
      '{host} liegt in einem privaten oder lokalen Netzwerk, daher sendet JARVIS nicht dorthin.',
    WEBHOOK_DISABLED:
      'Dieser Endpunkt ist ausgeschaltet. Schalte ihn ein, um einen Test zu senden.',
    SKILL_NOT_TOGGLEABLE:
      'Diese Fähigkeit gehört zur Grundfunktion von JARVIS und lässt sich nicht ausschalten.',
    SKILL_PLANNED: 'Diese Fähigkeit ist noch nicht verfügbar.',
    PROVIDER_NOT_CONFIGURED: '{provider} ist auf diesem Server nicht eingerichtet.',
    REDIRECT_URI_NOT_ALLOWED:
      'Die Rücksprungadresse dieser App ist auf diesem Server nicht erlaubt.',
    OAUTH_STATE_INVALID:
      'Dieser Anmeldelink ist nicht mehr gültig. Starte die Verbindung noch einmal.',
    OAUTH_STATE_EXPIRED: 'Die Anmeldung hat zu lange gedauert. Starte die Verbindung noch einmal.',
    OAUTH_DENIED: 'Du hast den Zugriff bei {provider} nicht erlaubt, daher wurde nichts verbunden.',
    OAUTH_EXCHANGE_FAILED:
      '{provider} hat die Anmeldung nicht abgeschlossen. Versuche es noch einmal.',
    OAUTH_SCOPE_NOT_GRANTED:
      'Keine der angefragten Berechtigungen wurde erlaubt, daher wurde nichts verbunden.',
    OAUTH_ACCOUNT_MISMATCH:
      'Du hast dich mit einem anderen {provider}-Konto angemeldet. Trenne zuerst das alte, um zu wechseln.',
    OAUTH_PENDING_LIMIT:
      'Zu viele Anmeldungen sind noch offen. Schließ sie ab oder warte ein paar Minuten, dann versuche es noch einmal.',
    CONNECTION_NOT_OAUTH: 'Diese Verbindung lässt sich so nicht neu verbinden.',
    CALENDAR_NOT_CONNECTED: 'Es ist kein Kalender verbunden.',
    CALENDAR_UNAVAILABLE: '{provider} hat nicht rechtzeitig geantwortet.',
    EVIDENCE_NOT_AVAILABLE:
      'Diese Nachweisdatei kann auf diesem Server gerade nicht gelesen werden.',
    PHONE_NUMBER_INVALID:
      'Das ist keine gültige Telefonnummer. Schreib sie mit Ländervorwahl, zum Beispiel +49 30 1234567.',
    PHONE_NUMBER_REQUIRED: 'Füge zuerst deine Telefonnummer hinzu.',
    PHONE_ALREADY_VERIFIED: 'Diese Nummer ist bereits bestätigt.',
    PHONE_VERIFICATION_INVALID:
      'Der Code stimmt nicht. {attemptsLeft, plural, one {Noch # Versuch} other {Noch # Versuche}}.',
    PHONE_VERIFICATION_EXPIRED: 'Dieser Code ist abgelaufen. Starte einen neuen Bestätigungsanruf.',
    PHONE_VERIFICATION_LIMIT: 'Du kannst höchstens {max} Bestätigungsanrufe pro Tag anfordern.',
    TELEPHONY_NOT_CONFIGURED: 'Anrufe sind auf diesem Server nicht eingerichtet.',
    CALL_DESTINATION_BLOCKED: 'JARVIS ruft solche Nummern nicht an.',
    WEBHOOK_SIGNATURE_INVALID: 'Die Anfrage ist nicht vom Telefonanbieter signiert.',
  },
  network: 'JARVIS ist nicht erreichbar. Internetverbindung prüfen.',
  badResponse: 'JARVIS hat eine unerwartete Antwort gesendet. Seite neu laden.',
  generic: 'Etwas ist schiefgelaufen.',
  details: 'Details',
  requestId: 'Anfrage-ID',
};

export default errors;
