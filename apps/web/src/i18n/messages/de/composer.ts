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
    title: 'Basismodus',
    body: 'JARVIS arbeitet ohne KI-Modell und versteht diese Anfragen.',
    summarize: 'Link zusammenfassen',
    remember: 'Etwas merken',
    emailMe: 'Mir selbst mailen',
    fills: 'Setzt eine Beispielanfrage ins Feld',
    templates: {
      summarize: 'Fasse {slot} zusammen und schick sie mir per E-Mail',
      remember: 'Merk dir, dass {slot}',
      emailMe: 'Schick mir: {slot}',
    },
    slots: {
      link: 'Link',
      something: 'etwas',
      text: 'Text',
    },
    needsWeb: 'benötigt Webzugriff',
    needsEmail: 'benötigt eine E-Mail-Verbindung',
    memoryOff: 'Gedächtnis ist ausgeschaltet',
    settingsLink: 'Über den Basismodus',
  },
};

export default composer;
