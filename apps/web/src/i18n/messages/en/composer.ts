const composer = {
  label: 'Ask JARVIS',
  placeholder: 'Ask JARVIS to do something…',
  send: 'Send request',
  sending: 'Sending…',
  voice: 'Speak your request',
  keyEnter: 'Enter',
  keyShift: 'Shift',
  hintSend: 'to send',
  hintNewLine: 'for a new line',
  tooLong: '{count, plural, one {# character over the limit} other {# characters over the limit}}',
  characterCount: '{count} of {max} characters',
  sent: 'Request sent.',
  queued: 'Request sent. JARVIS is unavailable right now, so it waits in the queue.',
  offline: {
    title: 'Offline planner',
    body: 'Without an AI model, JARVIS understands these requests:',
    summarize: 'Summarize <link> — add “and email it to me” to get it by email',
    remember: 'Remember that <something>',
    emailMe: 'Email me: <text>',
    needsWeb: 'needs web access',
    needsEmail: 'needs an email connection',
    memoryOff: 'memory is turned off',
    settingsLink: 'Assistant settings',
  },
};

export default composer;
