import type { Catalog } from '../../types';
import type source from '../en/connections';

const connections: Catalog<typeof source> = {
  title: 'Verbindungen',
  description:
    'Worauf JARVIS in deinem Auftrag zugreifen darf. Du kannst den Zugriff jederzeit widerrufen.',
  loading: 'Verbindungen werden geladen …',
  web: {
    title: 'Webzugriff',
    summary: 'Erlaubt JARVIS, öffentliche Webseiten zu lesen, wenn eine Anfrage das braucht.',
    allowsTitle: 'Was das erlaubt',
    allows: {
      read: 'Liest öffentliche Webseiten über http und https. Nur lesend: JARVIS füllt keine Formulare aus, meldet sich nirgends an und kauft nichts.',
      privateNetworks:
        'Erreicht nie private Netzwerke. Localhost, Heim- und Firmennetzwerke sowie interne Cloud-Adressen sind immer gesperrt.',
      noBrowser:
        'Seiten werden vom JARVIS-Server abgerufen – ohne deinen Browser, deine Cookies oder Passwörter.',
    },
    enable: 'Webzugriff aktivieren',
    enabled: 'Der Webzugriff ist aktiv.',
    disconnect: 'Trennen',
    disconnected: 'Der Webzugriff ist aus. JARVIS kann keine Webseiten mehr lesen.',
    since: 'Aktiviert {time}',
  },
  email: {
    title: 'E-Mail',
    summary: 'Erlaubt JARVIS, über SMTP E-Mails aus deinem eigenen Postfach zu senden.',
    setupHint:
      'Gib die SMTP-Einstellungen deines Mailanbieters ein. JARVIS meldet sich zur Prüfung an, bevor etwas gespeichert wird.',
    sendsAs: 'Sendet als',
    lastVerified: 'Zuletzt geprüft {time}',
    neverVerified: 'Noch nicht geprüft',
    lastErrorTitle: 'Die letzte Prüfung ist fehlgeschlagen',
    permissionsTitle: 'Was JARVIS darf',
    permissions: {
      send: 'E-Mails als {address} senden. Jede E-Mail wartet auf deine Freigabe – außer du erlaubst in den Einstellungen E-Mails an dich selbst.',
      noRead: 'JARVIS kann dein Postfach nicht lesen: SMTP kann nur senden.',
    },
    test: 'Verbindung testen',
    testOk: 'Der Mailserver hat die Verbindung angenommen.',
    testFailed: 'Der Verbindungstest ist fehlgeschlagen.',
    update: 'Einstellungen ändern',
    cancelUpdate: 'Aktuelle Einstellungen behalten',
    disconnect: 'Trennen',
    disconnectDialog: {
      title: 'E-Mail trennen?',
      body: 'JARVIS kann dann keine E-Mails mehr als {address} senden.',
      erase:
        'Das gespeicherte Passwort wird sofort vom Server gelöscht. Zum erneuten Verbinden gibst du es noch einmal ein.',
      confirm: 'Trennen und Passwort löschen',
    },
    disconnected: 'E-Mail getrennt. Das gespeicherte Passwort wurde gelöscht.',
    connected: 'E-Mail verbunden als {address}.',
    form: {
      title: 'SMTP-Einstellungen',
      label: 'Name',
      labelHint: 'So wird dieses Postfach in JARVIS angezeigt.',
      host: 'SMTP-Server',
      hostPlaceholder: 'smtp.example.com',
      port: 'Port',
      security: 'Sicherheit',
      securityOptions: {
        tls: 'TLS (Port 465)',
        starttls: 'STARTTLS (Port 587)',
        none: 'Keine (nur lokale Entwicklung)',
      },
      securityHints: {
        tls: 'Von Anfang an verschlüsselt. Empfohlen.',
        starttls: 'Wechselt vor der Anmeldung auf eine TLS-Verbindung.',
        none: 'Unverschlüsselt. Der Server akzeptiert das nur für einen Mailserver auf demselben Rechner während der Entwicklung.',
      },
      username: 'Benutzername',
      usernameHint:
        'Meist deine vollständige E-Mail-Adresse. Leer lassen, wenn der Server keine Anmeldung braucht.',
      password: 'Passwort',
      passwordHint:
        'Viele Anbieter verlangen ein App-Passwort. Es wird verschlüsselt gespeichert und nie wieder angezeigt.',
      showPassword: 'Passwort anzeigen',
      hidePassword: 'Passwort verbergen',
      fromAddress: 'Absenderadresse',
      fromName: 'Absendername',
      fromNameHint: 'Optional. Wird Empfängern neben der Adresse angezeigt.',
      submit: 'Prüfen und verbinden',
      verifying: 'Anmeldung bei {host} …',
      failedTitle: 'JARVIS konnte sich mit diesen Einstellungen nicht verbinden',
      errors: {
        label: 'Gib einen Namen für dieses Postfach ein.',
        host: 'Gib den Hostnamen des SMTP-Servers ein.',
        port: 'Gib einen Port zwischen 1 und 65535 ein.',
        fromAddress: 'Gib eine gültige E-Mail-Adresse ein.',
      },
    },
  },
  oauth: {
    providers: {
      google: { summary: 'Gmail und Google Kalender.' },
      microsoft: {
        summary: 'Outlook-Mail und -Kalender für Microsoft-365- und Outlook.com-Konten.',
      },
    },
    notConfigured: 'Auf diesem Server nicht eingerichtet',
    notConfiguredBody:
      'Die Anmeldung mit {provider} ist auf diesem JARVIS-Server noch nicht eingerichtet (dafür braucht es eine Client-ID und ein Secret). Deshalb lässt sich das Konto hier nicht verbinden.',
    chooseTitle: 'Was JARVIS darf',
    chooseHint:
      'Erlaube nur, was du brauchst – mehr kannst du später hinzufügen. Alles, was schreibt oder sendet, wartet weiterhin auf deine Freigabe.',
    groups: { mail: 'E-Mail', calendar: 'Kalender' },
    hints: {
      mailRead:
        'Deine Nachrichten durchsuchen und lesen, um sie zusammenzufassen und zu finden, was eine Antwort braucht.',
      mailCompose: 'Antwortentwürfe in deinem Postfach speichern. Es wird nichts gesendet.',
      mailSend:
        'E-Mails in deinem Namen senden – jedes Mal erst, nachdem du die genaue Nachricht freigegeben hast.',
      calendarRead: 'Deine Termine sehen und wann du frei bist.',
      calendarWrite:
        'Termine anlegen, verschieben und absagen und Einladungen senden – jedes Mal erst nach deiner Freigabe.',
    },
    requiredBy: 'Enthalten, weil „{capability}“ es braucht.',
    scopesToggle: 'Genaue Berechtigungen, die bei {provider} angefragt werden',
    scopesGrantedToggle: 'Genaue Berechtigungen, die {provider} erteilt hat',
    scopesIdentity: 'Immer dabei: ID und Adresse deines Kontos und eine dauerhafte Verbindung.',
    connect: 'Weiter zu {provider}',
    connectHint:
      'Du meldest dich bei {provider} an und bestätigst dort. JARVIS sieht dein Passwort nie.',
    noneSelected: 'Wähle mindestens eine Sache, die JARVIS darf.',
    account: 'Konto',
    connected: 'Verbunden {time}',
    lastChecked: 'Zuletzt geprüft {time}',
    canDoTitle: 'Was JARVIS darf',
    pausedTitle: 'Pausiert, bis du neu verbindest',
    addTitle: 'Mehr erlauben',
    addHint: 'JARVIS fragt bei {provider} nur an, was du hier auswählst.',
    add: 'Bei {provider} erlauben',
    expired: {
      title: 'Deine Verbindung mit {provider} ist abgelaufen',
      GRANT_INVALID:
        '{provider} akzeptiert den Zugriff von JARVIS nicht mehr: Er wurde widerrufen oder ist abgelaufen. Bis du neu verbindest, kann JARVIS dort nichts lesen oder ändern.',
      TOKEN_REJECTED:
        '{provider} hat den Zugriff von JARVIS abgelehnt. Bis du neu verbindest, kann JARVIS dort nichts lesen oder ändern.',
      generic: 'Bis du neu verbindest, kann JARVIS dort nichts lesen oder ändern.',
      reconnect: 'Neu verbinden',
      reconnectLabel: '{provider} neu verbinden',
      asksFor: 'Beim neuen Verbinden werden dieselben Berechtigungen angefragt wie bisher: {list}.',
    },
    scopeMissing: {
      title: '{provider} hat eine Berechtigung entzogen',
      body: 'JARVIS arbeitet mit dem weiter, was noch erlaubt ist. Erlaube den Rest unten wieder, wenn du ihn brauchst.',
    },
    error: {
      title: '{provider} antwortet nicht zuverlässig',
      body: 'Mehrere Anfragen hintereinander sind fehlgeschlagen. JARVIS versucht es bei der nächsten Anfrage erneut; passiert das weiter, kann neues Verbinden helfen.',
    },
    disconnect: 'Trennen',
    disconnectDialog: {
      title: '{provider} trennen?',
      body: 'JARVIS kann dann in {account} nichts mehr lesen oder ändern.',
      provider:
        'JARVIS löscht seine Tokens sofort und bittet {provider}, den Zugriff zu widerrufen.',
      local_only:
        'JARVIS löscht seine Tokens sofort. Microsoft lässt Apps ihren eigenen Zugriff nicht widerrufen – entferne JARVIS deshalb auch in deinem Konto:',
      localOnlyPersonal: 'Private Konten',
      localOnlyWork: 'Geschäfts- oder Schulkonten',
      watches:
        'Threads, die JARVIS in diesem Konto auf Antworten beobachtet, werden nicht mehr beobachtet.',
      confirm: 'Trennen und Tokens löschen',
    },
    disconnected: '{provider} getrennt. Die Tokens wurden gelöscht.',
    revocation: {
      provider: 'Beim Trennen wird der Zugriff von JARVIS bei {provider} widerrufen.',
      local_only:
        'Beim Trennen löscht JARVIS seine Tokens; die App kannst du zusätzlich bei Microsoft entfernen.',
    },
  },
  callback: {
    title: 'Konto verbinden',
    working: 'Verbindung wird abgeschlossen …',
    connectedTitle: '{provider} ist verbunden',
    connectedBody: 'JARVIS darf jetzt mit {account}:',
    missing:
      'Diese Seite schließt das Verbinden eines Kontos ab, nachdem du dich bei Google oder Microsoft angemeldet hast. Starte unter „Verbindungen“.',
    failedTitle: 'Es wurde nichts verbunden',
    back: 'Zurück zu den Verbindungen',
    continue: 'Weiter',
    resumableTitle:
      '{count, plural, one {# Aufgabe wurde gestoppt, weil die Verbindung abgelaufen war} other {# Aufgaben wurden gestoppt, weil die Verbindung abgelaufen war}}',
    resumableBody: 'Die Verbindung funktioniert wieder, du kannst sie jetzt wiederholen.',
    retry: 'Wiederholen',
    retryLabel: '„{title}“ wiederholen',
    retrying: 'Wird wiederholt …',
    retried: 'Wiederholung gestartet',
    openTask: 'Aufgabe öffnen',
  },
  status: {
    unconfigured: 'Nicht eingerichtet',
    active: 'Verbunden',
    error: 'Prüfen nötig',
    expired: 'Abgelaufen',
    revoked: 'Getrennt',
    notConnected: 'Nicht verbunden',
  },
};

export default connections;
