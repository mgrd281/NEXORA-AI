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
  modes: {
    legend: 'Sprachmodus',
    dictation: 'Eine Anfrage',
    conversation: 'Gespräch',
  },
  conversation: {
    title: 'Gespräch mit JARVIS',
    states: {
      requesting: 'Mikrofonzugriff erlauben, um mit JARVIS zu sprechen.',
      listening: 'Hört zu …',
      listeningHelp:
        'Einfach natürlich sprechen. Nach einer kurzen Pause sendet JARVIS das Gesagte.',
      paused: 'Mikrofon aus',
      pausedHelp: 'Mikrofon einschalten, um weiterzusprechen, oder unten tippen.',
      sending: 'Wird gesendet …',
      retrying: 'Verbindung unterbrochen. Neuer Versuch …',
      retryingHelp: 'Die Anfrage wird gesendet, sobald JARVIS erreichbar ist – und nur einmal.',
      thinking: 'Wird bearbeitet …',
      reconnecting: 'Live-Updates werden neu verbunden …',
      reconnectingHelp:
        'JARVIS arbeitet weiter. Der aktuelle Stand erscheint, sobald die Verbindung wieder steht.',
      speaking: 'Spricht …',
      speakingHelp: 'Jederzeit lossprechen, um zu unterbrechen.',
      awaiting: 'Wartet auf Genehmigung',
      awaitingHelp:
        'Auf dem Bildschirm prüfen und „Genehmigen“ oder „Ablehnen“ wählen. JARVIS nimmt Genehmigungen nie per Sprache an.',
      failed: 'Die Anfrage konnte nicht gesendet werden.',
      failedHelp:
        'Verbindung prüfen. Das Gesagte steht im Textfeld – sende es, sobald du wieder online bist.',
      unsupported: 'Spracheingabe ist in diesem Browser nicht verfügbar.',
      unsupportedHelp: 'Anfragen unten eintippen. JARVIS antwortet trotzdem laut.',
      unsupportedSilentHelp: 'Anfragen unten eintippen. Antworten erscheinen als Untertitel.',
      denied: 'Der Mikrofonzugriff ist blockiert.',
      deniedHelp:
        'Das Mikrofon für diese Website in den Website-Einstellungen des Browsers erlauben und erneut versuchen. Bis dahin kannst du unten tippen.',
      noMicrophone: 'Es wurde kein Mikrofon gefunden.',
      noMicrophoneHelp: 'Mikrofon anschließen und erneut versuchen oder unten tippen.',
      micError: 'Der Spracherkennungsdienst des Browsers ist nicht erreichbar.',
      micErrorHelp: 'Verbindung prüfen und erneut versuchen oder unten tippen.',
      ended: 'Gespräch beendet',
    },
    lines: {
      approvalOnScreen:
        'Dafür brauche ich deine Genehmigung. Bitte prüfe sie auf dem Bildschirm und wähle Genehmigen oder Ablehnen – per Sprache kann ich keine Genehmigung annehmen.',
      busy: 'Ich arbeite noch an deiner letzten Anfrage. Was du gerade gesagt hast, steht im Textfeld – du kannst es danach senden.',
      idleWarning:
        'Bist du noch da? Ich beende den Sprachmodus in ein paar Sekunden, wenn du nichts sagst.',
      done: 'Erledigt.',
    },
    captions: {
      label: 'Untertitel des Gesprächs',
      you: 'Du',
      jarvis: 'JARVIS',
      typed: 'getippt',
      interrupted: 'Unterbrochen',
      unsent: 'Nicht gesendet – steht im Textfeld',
      assent: 'Keine Genehmigung – Genehmigungen werden auf dem Bildschirm bestätigt',
      empty: 'Etwas sagen oder unten tippen. Alles Gesagte erscheint hier.',
      heard: 'Wird erkannt',
    },
    input: {
      label: 'Nachricht an JARVIS',
      placeholder: 'Tippen statt sprechen …',
      send: 'Senden',
    },
    end: 'Gespräch beenden',
    micOff: 'Mikrofon ausschalten',
    micOn: 'Mikrofon einschalten',
    listenAgain: 'Erneut zuhören',
    review: 'Prüfen und entscheiden',
    openTask: 'Diese Aufgabe öffnen',
    noSpeechOutput:
      'Dieser Browser kann nicht sprechen. Antworten erscheinen deshalb nur als Untertitel.',
    keyboard:
      'Die Leertaste schaltet das Mikrofon ein oder aus. Esc beendet das Gespräch. „{stop}“ zu sagen beendet es ebenfalls.',
    privacy:
      'Deine Sprache wird vom Spracherkennungsdienst des Browsers in Text umgewandelt. JARVIS erhält nur deine Anfragen als Text – niemals Audio.',
  },
  samples: {
    en: 'Hello, I’m JARVIS. This is how I sound.',
    de: 'Hallo, ich bin JARVIS. So klinge ich.',
    ar: 'مرحبًا، أنا جارفيس. هكذا يبدو صوتي.',
  },
};

export default voice;
