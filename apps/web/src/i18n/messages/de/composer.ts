import type { Catalog } from '../../types';
import type source from '../en/composer';

const composer: Catalog<typeof source> = {
  label: 'JARVIS fragen',
  placeholder: 'JARVIS um etwas bitten …',
  send: 'Anfrage senden',
  sending: 'Wird gesendet …',
  voice: 'Anfrage sprechen',
  keyEnter: 'Enter',
  keyShift: 'Umschalt',
  hintSend: 'zum Senden',
  hintNewLine: 'für eine neue Zeile',
  tooLong: '{count, plural, one {# Zeichen zu viel} other {# Zeichen zu viel}}',
  characterCount: '{count} von {max} Zeichen',
  sent: 'Anfrage gesendet.',
  queued:
    'Anfrage gesendet. JARVIS ist gerade nicht erreichbar, daher wartet sie in der Warteschlange.',
  offline: {
    title: 'Offline-Planer',
    body: 'Ohne KI-Modell versteht JARVIS diese Anfragen:',
    summarize:
      'Fasse <Link> zusammen – mit „und schick sie mir per E-Mail“ kommt das Ergebnis per E-Mail',
    remember: 'Merk dir, dass <etwas>',
    emailMe: 'Schick mir: <Text>',
    needsWeb: 'benötigt Webzugriff',
    needsEmail: 'benötigt eine E-Mail-Verbindung',
    memoryOff: 'Gedächtnis ist ausgeschaltet',
    settingsLink: 'Assistenteneinstellungen',
  },
};

export default composer;
