const connections = {
  title: 'Connections',
  description: 'What JARVIS can access on your behalf. You can revoke access at any time.',
  loading: 'Loading connections…',
  web: {
    title: 'Web access',
    summary: 'Lets JARVIS read public web pages when a request needs one.',
    allowsTitle: 'What this allows',
    allows: {
      read: 'Reads public web pages over http and https. It only reads: it never fills in forms, signs in or buys anything.',
      privateNetworks:
        'Never reaches private networks. Localhost, home and office networks and cloud-internal addresses are always blocked.',
      noBrowser:
        'Pages are fetched by the JARVIS server, without your browser, cookies or passwords.',
    },
    enable: 'Enable web access',
    enabled: 'Web access is on.',
    disconnect: 'Disconnect',
    disconnected: 'Web access is off. JARVIS can no longer read web pages.',
    since: 'Turned on {time}',
  },
  email: {
    title: 'Email',
    summary: 'Lets JARVIS send email from your own mailbox over SMTP.',
    setupHint:
      'Enter your mail provider’s SMTP settings. JARVIS signs in to check them before anything is saved.',
    sendsAs: 'Sends as',
    lastVerified: 'Last verified {time}',
    neverVerified: 'Not verified yet',
    lastErrorTitle: 'The last check failed',
    permissionsTitle: 'What JARVIS can do',
    permissions: {
      send: 'Send email as {address}. Each email waits for your approval, unless you allow emails to yourself in Settings.',
      noRead: 'It can’t read your inbox: SMTP can only send.',
    },
    test: 'Test connection',
    testOk: 'The mail server accepted the connection.',
    testFailed: 'The connection test failed.',
    update: 'Update settings',
    cancelUpdate: 'Keep current settings',
    disconnect: 'Disconnect',
    disconnectDialog: {
      title: 'Disconnect email?',
      body: 'JARVIS will no longer be able to send email as {address}.',
      erase:
        'The stored password is erased from the server right away. To reconnect, you’ll enter it again.',
      confirm: 'Disconnect and erase password',
    },
    disconnected: 'Email disconnected. The stored password was erased.',
    connected: 'Email connected as {address}.',
    form: {
      title: 'SMTP settings',
      label: 'Name',
      labelHint: 'How this mailbox is shown in JARVIS.',
      host: 'SMTP server',
      hostPlaceholder: 'smtp.example.com',
      port: 'Port',
      security: 'Security',
      securityOptions: {
        tls: 'TLS (port 465)',
        starttls: 'STARTTLS (port 587)',
        none: 'None (local development only)',
      },
      securityHints: {
        tls: 'Encrypted from the first byte. Recommended.',
        starttls: 'Upgrades the connection to TLS before signing in.',
        none: 'Unencrypted. The server accepts this only for a mail server on the same machine, in development.',
      },
      username: 'Username',
      usernameHint: 'Usually your full email address. Leave empty if the server needs no sign-in.',
      password: 'Password',
      passwordHint:
        'Many providers require an app password. It’s stored encrypted and never shown again.',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      fromAddress: 'From address',
      fromName: 'From name',
      fromNameHint: 'Optional. Shown to recipients next to the address.',
      submit: 'Verify and connect',
      verifying: 'Signing in to {host}…',
      failedTitle: 'JARVIS couldn’t connect with these settings',
      errors: {
        label: 'Enter a name for this mailbox.',
        host: 'Enter the SMTP server’s host name.',
        port: 'Enter a port between 1 and 65535.',
        fromAddress: 'Enter a valid email address.',
      },
    },
  },
  /** Phase C: Google and Microsoft accounts (OAuth 2.0 with PKCE). */
  oauth: {
    providers: {
      google: { summary: 'Gmail and Google Calendar.' },
      microsoft: {
        summary: 'Outlook mail and calendar for Microsoft 365 and Outlook.com accounts.',
      },
    },
    notConfigured: 'Not configured on this server',
    notConfiguredBody:
      'Whoever runs this JARVIS server hasn’t set up sign-in with {provider} yet (it needs a client ID and secret), so it can’t be connected here.',
    chooseTitle: 'What JARVIS may do',
    chooseHint:
      'Allow only what you need; you can add more later. Anything that writes or sends still waits for your approval.',
    groups: { mail: 'Email', calendar: 'Calendar' },
    hints: {
      mailRead: 'Search and read your messages, to summarize them and find what needs a reply.',
      mailCompose: 'Save reply drafts in your mailbox. Nothing is sent.',
      mailSend: 'Send email as you, each time after you approve the exact message.',
      calendarRead: 'See your events and when you’re free.',
      calendarWrite:
        'Add, move and cancel events and send invitations, each time after you approve the change.',
    },
    requiredBy: 'Included because “{capability}” needs it.',
    scopesToggle: 'Exact permissions requested from {provider}',
    scopesGrantedToggle: 'Exact permissions {provider} granted',
    scopesIdentity: 'Always included: your account’s ID and address, and staying connected.',
    connect: 'Continue to {provider}',
    connectHint: 'You sign in at {provider} and confirm there. JARVIS never sees your password.',
    noneSelected: 'Choose at least one thing JARVIS may do.',
    account: 'Account',
    connected: 'Connected {time}',
    lastChecked: 'Last checked {time}',
    canDoTitle: 'What JARVIS can do',
    pausedTitle: 'Paused until you reconnect',
    addTitle: 'Allow more',
    addHint: 'JARVIS asks {provider} only for what you choose here.',
    add: 'Allow at {provider}',
    expired: {
      title: 'Your {provider} connection has expired',
      GRANT_INVALID:
        '{provider} no longer accepts JARVIS’s access: it was revoked or ran out. Until you reconnect, JARVIS can’t read or change anything there.',
      TOKEN_REJECTED:
        '{provider} rejected JARVIS’s access. Until you reconnect, JARVIS can’t read or change anything there.',
      generic: 'Until you reconnect, JARVIS can’t read or change anything there.',
      reconnect: 'Reconnect',
      reconnectLabel: 'Reconnect {provider}',
      asksFor: 'Reconnecting asks for the same permissions as before: {list}.',
    },
    scopeMissing: {
      title: '{provider} withdrew a permission',
      body: 'JARVIS keeps working with what is still allowed. Allow the rest again below if you need it.',
    },
    error: {
      title: '{provider} isn’t responding reliably',
      body: 'Several requests in a row failed. JARVIS tries again with the next request; reconnecting can help if it keeps happening.',
    },
    disconnect: 'Disconnect',
    disconnectDialog: {
      title: 'Disconnect {provider}?',
      body: 'JARVIS will no longer read or change anything in {account}.',
      provider: 'JARVIS erases its tokens right away and asks {provider} to revoke its access.',
      local_only:
        'JARVIS erases its tokens right away. Microsoft doesn’t let apps revoke their own access, so also remove JARVIS from your account:',
      localOnlyPersonal: 'Personal accounts',
      localOnlyWork: 'Work or school accounts',
      watches: 'Threads JARVIS watches for replies in this account are no longer watched.',
      confirm: 'Disconnect and erase tokens',
    },
    disconnected: '{provider} disconnected. Its tokens were erased.',
    revocation: {
      provider: 'Disconnecting revokes JARVIS’s access at {provider}.',
      local_only: 'Disconnecting erases JARVIS’s tokens; you can also remove the app at Microsoft.',
    },
  },
  callback: {
    title: 'Connect an account',
    working: 'Finishing the connection…',
    connectedTitle: '{provider} is connected',
    connectedBody: 'JARVIS can now use {account} to:',
    missing:
      'This page finishes connecting an account after you sign in at Google or Microsoft. Start from Connections.',
    failedTitle: 'Nothing was connected',
    back: 'Back to Connections',
    continue: 'Continue',
    resumableTitle:
      '{count, plural, one {# task stopped because the connection had expired} other {# tasks stopped because the connection had expired}}',
    resumableBody: 'The connection works again, so you can retry them now.',
    retry: 'Retry',
    retryLabel: 'Retry “{title}”',
    retrying: 'Retrying…',
    retried: 'Retry started',
    openTask: 'Open task',
  },
  status: {
    unconfigured: 'Not configured',
    active: 'Connected',
    error: 'Needs attention',
    expired: 'Expired',
    revoked: 'Disconnected',
    notConnected: 'Not connected',
  },
};

export default connections;
