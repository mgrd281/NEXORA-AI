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
  /** Phase D: voice conversation mode (listen → answer aloud → listen again). */
  modes: {
    legend: 'Voice mode',
    dictation: 'One request',
    conversation: 'Conversation',
  },
  conversation: {
    title: 'Conversation with JARVIS',
    states: {
      requesting: 'Allow microphone access to talk with JARVIS.',
      listening: 'Listening…',
      listeningHelp: 'Speak naturally. JARVIS sends what you said after a short pause.',
      paused: 'Microphone off',
      pausedHelp: 'Turn the microphone on to talk again, or type below.',
      sending: 'Sending…',
      retrying: 'Connection lost. Trying again…',
      retryingHelp: 'Your request goes out as soon as JARVIS is reachable — and only once.',
      thinking: 'Working on it…',
      reconnecting: 'Reconnecting to live updates…',
      reconnectingHelp:
        'JARVIS keeps working. The latest state appears as soon as the connection is back.',
      speaking: 'Speaking…',
      speakingHelp: 'Start talking at any time to interrupt.',
      awaiting: 'Waiting for your approval',
      awaitingHelp:
        'Review it on screen and choose Approve or Decline. JARVIS never takes approvals by voice.',
      failed: 'Couldn’t send your request.',
      failedHelp:
        'Check your connection. Your words are in the text field — send them when you’re back online.',
      unsupported: 'Voice input isn’t available in this browser.',
      unsupportedHelp: 'Type your requests below. JARVIS still answers aloud.',
      unsupportedSilentHelp: 'Type your requests below. Replies appear as captions.',
      denied: 'Microphone access is blocked.',
      deniedHelp:
        'Allow the microphone for this site in your browser’s site settings, then try again. You can type below in the meantime.',
      noMicrophone: 'No microphone was found.',
      noMicrophoneHelp: 'Connect a microphone and try again, or type below.',
      micError: 'The browser’s speech service isn’t reachable.',
      micErrorHelp: 'Check your connection and try again, or type below.',
      ended: 'Conversation ended',
    },
    /** Said aloud (and captioned) by JARVIS. */
    lines: {
      approvalOnScreen:
        'This needs your approval. Please review it on screen and choose Approve or Decline — I can’t take approvals by voice.',
      busy: 'I’m still working on your last request. What you just said is in the text field, so you can send it afterwards.',
      idleWarning:
        'Are you still there? I’ll end voice mode in a few seconds unless you say something.',
      done: 'Done.',
    },
    captions: {
      label: 'Captions of the conversation',
      you: 'You',
      jarvis: 'JARVIS',
      typed: 'typed',
      interrupted: 'Interrupted',
      unsent: 'Not sent — it’s in the text field',
      assent: 'Not an approval — approvals are confirmed on screen',
      empty: 'Say something, or type below. Everything that is said appears here.',
      heard: 'Hearing',
    },
    input: {
      label: 'Message JARVIS',
      placeholder: 'Type instead of speaking…',
      send: 'Send',
    },
    end: 'End conversation',
    micOff: 'Turn microphone off',
    micOn: 'Turn microphone on',
    listenAgain: 'Listen again',
    review: 'Review and decide',
    openTask: 'Open this task',
    noSpeechOutput: 'This browser can’t speak, so replies appear as captions only.',
    keyboard:
      'Space turns the microphone on or off. Esc ends the conversation. Saying “{stop}” ends it too.',
    privacy:
      'Your speech is transcribed by your browser’s speech service. JARVIS receives only your requests as text — never audio.',
  },
  /** A sentence in each language for previewing voices (always in that language). */
  samples: {
    en: 'Hello, I’m JARVIS. This is how I sound.',
    de: 'Hallo, ich bin JARVIS. So klinge ich.',
    ar: 'مرحبًا، أنا جارفيس. هكذا يبدو صوتي.',
  },
};

export default voice;
