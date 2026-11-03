const voice = {
  title: 'Voice request',
  stop: 'Stop listening',
  resume: 'Listen again',
  send: 'Send',
  sendLabel: 'Send this request',
  sending: 'Sending…',
  cancel: 'Cancel',
  typeInstead: 'Type instead',
  tryAgain: 'Try again',
  transcriptLabel: 'What JARVIS heard',
  transcriptEmpty: 'Start speaking — your words appear here.',
  language: 'Recognition language',
  languages: {
    enUS: 'English (US)',
    deDE: 'Deutsch (Deutschland)',
    arSA: 'العربية (السعودية)',
  },
  states: {
    requesting: 'Allow microphone access to dictate your request.',
    listening: 'Listening…',
    paused: 'Paused. Send your request, or listen again.',
    noSpeech: 'No speech was detected.',
    noSpeechHelp: 'Try again closer to the microphone, or type instead.',
    denied: 'Microphone access is blocked.',
    deniedHelp:
      'To dictate, allow the microphone for this site in your browser’s site settings, then try again.',
    unsupported: 'Voice input isn’t available in this browser.',
    unsupportedHelp:
      'You can type your request instead. Voice input works in current versions of Chrome, Edge and Safari.',
    noMicrophone: 'No microphone was found.',
    noMicrophoneHelp: 'Connect a microphone and try again, or type instead.',
    error: 'The browser’s speech service isn’t reachable.',
    errorHelp: 'Check your connection and try again, or type instead.',
    sending: 'Sending your request…',
  },
  privacy:
    'Speech is transcribed by your browser’s speech service, which may process audio on the browser vendor’s servers. JARVIS never receives audio.',
  spaceHint: 'Press Space to stop or resume listening.',
};

export default voice;
