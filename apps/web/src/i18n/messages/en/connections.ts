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
  status: {
    active: 'Connected',
    error: 'Needs attention',
    expired: 'Expired',
    revoked: 'Disconnected',
    notConnected: 'Not connected',
  },
};

export default connections;
