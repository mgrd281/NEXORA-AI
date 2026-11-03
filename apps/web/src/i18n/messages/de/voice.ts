import type { Catalog } from '../../types';
import type source from '../en/voice';

const voice: Catalog<typeof source> = {
  title: 'Sprachanfrage',
  stop: 'Zuhören beenden',
  resume: 'Erneut zuhören',
  send: 'Senden',
  sendLabel: 'Diese Anfrage senden',
  sending: 'Wird gesendet …',
  cancel: 'Abbrechen',
  typeInstead: 'Stattdessen tippen',
  tryAgain: 'Erneut versuchen',
  transcriptLabel: 'Was JARVIS verstanden hat',
  transcriptEmpty: 'Einfach lossprechen – der Text erscheint hier.',
  language: 'Erkennungssprache',
  languages: {
    enUS: 'English (US)',
    deDE: 'Deutsch (Deutschland)',
    arSA: 'العربية (السعودية)',
  },
  states: {
    requesting: 'Mikrofonzugriff erlauben, um die Anfrage zu diktieren.',
    listening: 'Hört zu …',
    paused: 'Pausiert. Anfrage senden oder erneut zuhören.',
    noSpeech: 'Es wurde keine Sprache erkannt.',
    noSpeechHelp: 'Näher am Mikrofon erneut versuchen oder stattdessen tippen.',
    denied: 'Der Mikrofonzugriff ist blockiert.',
    deniedHelp:
      'Zum Diktieren das Mikrofon für diese Website in den Website-Einstellungen des Browsers erlauben und erneut versuchen.',
    unsupported: 'Spracheingabe ist in diesem Browser nicht verfügbar.',
    unsupportedHelp:
      'Die Anfrage kann stattdessen getippt werden. Spracheingabe funktioniert in aktuellen Versionen von Chrome, Edge und Safari.',
    noMicrophone: 'Es wurde kein Mikrofon gefunden.',
    noMicrophoneHelp: 'Mikrofon anschließen und erneut versuchen oder stattdessen tippen.',
    error: 'Der Spracherkennungsdienst des Browsers ist nicht erreichbar.',
    errorHelp: 'Verbindung prüfen und erneut versuchen oder stattdessen tippen.',
    sending: 'Anfrage wird gesendet …',
  },
  privacy:
    'Die Sprache wird vom Spracherkennungsdienst des Browsers in Text umgewandelt; dabei kann Audio auf Servern des Browserherstellers verarbeitet werden. JARVIS erhält niemals Audio.',
  spaceHint: 'Leertaste drücken, um das Zuhören zu beenden oder fortzusetzen.',
};

export default voice;
