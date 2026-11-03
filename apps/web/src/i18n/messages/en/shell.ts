const shell = {
  brand: 'JARVIS — Home',
  nav: {
    label: 'Main',
    home: 'Home',
    tasks: 'Tasks',
    memory: 'Memory',
    connections: 'Connections',
    settings: 'Settings',
    admin: 'Admin',
  },
  tasksBadge: '{count, plural, one {# approval waiting} other {# approvals waiting}}',
  account: {
    menu: 'Account',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    signOutFailed: 'Could not sign out. Try again.',
    settings: 'Settings',
    admin: 'Admin',
    shortcuts: 'Keyboard shortcuts',
  },
  assistantStatus: {
    label: 'Assistant status',
    open: 'Assistant status: {status}. Open assistant settings.',
  },
  banners: {
    offline: 'You’re offline — changes will not be sent.',
    unavailable: 'JARVIS is unavailable — tasks will wait in the queue.',
    reconnecting: 'Live updates paused. Reconnecting…',
  },
  shortcuts: {
    title: 'Keyboard shortcuts',
    focusComposer: 'Ask JARVIS from any page',
    focusComposerHere: 'Go to the request field on this page',
    showShortcuts: 'Show keyboard shortcuts',
    send: 'Send a request',
    newLine: 'New line in a request',
    closeOverlay: 'Close a dialog or sheet',
    singleKey: 'Single-key shortcuts',
    singleKeyHint:
      'Use / and ? without a modifier key. Turn this off if you use speech input or other tools that type for you.',
  },
  placeholder: {
    building: 'This screen is being built.',
  },
  pageTitles: {
    task: 'Task',
    signIn: 'Sign in',
    components: 'Components',
    notFound: 'Page not found',
  },
  notFound: {
    title: 'This page doesn’t exist',
    body: 'The link may be broken, or the page was moved.',
    home: 'Go to Home',
  },
  loading: 'Loading your workspace…',
};

export default shell;
