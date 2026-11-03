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
  status: {
    active: 'Verbunden',
    error: 'Prüfen nötig',
    expired: 'Abgelaufen',
    revoked: 'Getrennt',
    notConnected: 'Nicht verbunden',
  },
};

export default connections;
