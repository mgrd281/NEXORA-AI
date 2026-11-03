import type { Catalog } from '../../types';
import type source from '../en/auth';

const auth: Catalog<typeof source> = {
  title: 'Bei JARVIS anmelden',
  email: 'E-Mail',
  password: 'Passwort',
  showPassword: 'Passwort anzeigen',
  hidePassword: 'Passwort verbergen',
  submit: 'Anmelden',
  submitting: 'Anmeldung läuft …',
  inviteOnly: 'Während der privaten Alpha gibt es Konten nur auf Einladung.',
  sessionEnded: 'Die Sitzung ist beendet. Zum Fortfahren erneut anmelden.',
  language: 'Sprache',
  errors: {
    invalidCredentials: 'E-Mail-Adresse oder Passwort ist falsch.',
    rateLimited: 'Zu viele Versuche. In einer Minute erneut versuchen.',
    offline: 'Keine Internetverbindung. Verbindung prüfen und erneut versuchen.',
    generic: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
    emailRequired: 'E-Mail-Adresse eingeben.',
    emailInvalid: 'Gültige E-Mail-Adresse eingeben.',
    passwordRequired: 'Passwort eingeben.',
  },
};

export default auth;
