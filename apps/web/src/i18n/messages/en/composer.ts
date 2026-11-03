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
  /** Basic mode: the deterministic planner that works without an AI model. */
  offline: {
    title: 'Basic mode',
    body: 'JARVIS is working without an AI model and understands these requests.',
    summarize: 'Summarize a link',
    remember: 'Remember something',
    emailMe: 'Email yourself',
    fills: 'Puts an example request in the field',
    /** Filled into the field; the {slot} is selected so typing or pasting replaces it. */
    templates: {
      summarize: 'Summarize {slot} and email it to me',
      remember: 'Remember that {slot}',
      emailMe: 'Email me: {slot}',
    },
    slots: {
      link: 'link',
      something: 'something',
      text: 'text',
    },
    needsWeb: 'needs web access',
    needsEmail: 'needs an email connection',
    memoryOff: 'memory is turned off',
    settingsLink: 'About basic mode',
  },
};

export default composer;
