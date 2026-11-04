/**
 * The admin dashboard renders only in German or Arabic (features/admin/locale.ts): these English
 * strings are the source of the catalog's shape (types, the identical-keys test) and are never
 * shown on /admin.
 */
const admin = {
  title: 'Admin',
  description: 'Health, reliability and cost of this JARVIS installation.',
  auditedNote: 'Every visit to this page is recorded in the audit log.',
  forbidden: 'This area is reserved for platform administrators.',
  forbiddenAction: 'Go to Home',
  notice:
    'Administrators see system health, counts and account details only — never conversation, task or memory content.',
  refresh: 'Refresh',
  updated: 'Updated {time}',
  loading: 'Loading the overview…',
  /** The page's own language switch (German / Arabic; never the profile's language). */
  language: {
    label: 'Admin language',
  },
  health: {
    title: 'System health',
    database: 'Database',
    databaseOk: 'Reachable',
    databaseDown: 'Unreachable',
    worker: 'Background worker',
    workerOk: 'Running',
    workerDown: 'Not responding',
    heartbeat: 'Last heartbeat {time}',
    noHeartbeat: 'No heartbeat yet',
    planner: 'Planner',
    plannerModel: 'AI model',
    plannerOffline: 'Basic mode',
    plannerProvider: 'Provider: {provider}',
    reasons: {
      NO_API_KEY: 'No API key configured for an AI model',
      USER_DISABLED_EXTERNAL_MODELS: 'External AI models turned off',
      BUDGET_EXHAUSTED: 'AI budget used up',
      unknown: 'Status unavailable',
    },
    queue: 'Job queue',
    /**
     * Ready = due now (backlog); scheduled = due later (e.g. approval expiry timers). No-break
     * spaces keep each count with its word; a narrow tile wraps after the separator.
     */
    queueValue: '{ready}\u00a0ready\u00a0· {scheduled}\u00a0scheduled',
    queueIdle: 'Nothing is due now',
    queueOldest: 'Oldest due job waiting {duration}',
    queueSlow: 'Behind: oldest due job waiting {duration}',
  },
  usage: {
    title: 'Usage',
    users: 'Users',
    usersCaption: '{count} active in the last 7 days',
    tenants: 'Tenants',
    tenantsCaption: 'Separate data spaces',
    cost: 'AI cost',
    costCaption: 'Last 30 days',
  },
  tasks: {
    title: 'Tasks by status',
    total: '{count, plural, one {# task in total} other {# tasks in total}}',
    empty: 'No tasks have been created yet.',
    /** A status this client does not know (a newer server); its code is shown beside it. */
    unknownStatus: 'Other status',
  },
  tools: {
    title: 'Tool reliability',
    caption: 'Executions, success rate and latency per tool',
    tool: 'Tool',
    executions: 'Executions',
    successRate: 'Success rate',
    failed: 'Failed',
    p50: 'p50 latency',
    p95: 'p95 latency',
    none: '—',
    /** A success rate under the reliability threshold, e.g. "75% · below 90%". */
    rateLow: '{rate} · below {threshold}',
    empty: 'No tool has run yet.',
    /** A tool this client does not know (a newer server); its id is shown beside it. */
    unknownTool: 'Other tool',
  },
  users: {
    title: 'Users',
    caption: 'Accounts on this installation',
    email: 'Email',
    tenant: 'Tenant',
    roles: 'Roles',
    status: 'Status',
    created: 'Created',
    lastActive: 'Last active',
    tasks: 'Tasks',
    never: 'Never',
    empty: 'There are no users yet.',
    statuses: {
      active: 'Active',
      disabled: 'Disabled',
      deleted: 'Deleted',
    },
  },
  roles: {
    owner: 'Owner',
    member: 'Member',
    platform_admin: 'Platform admin',
  },
  audit: {
    title: 'Audit log',
    caption: 'Security-relevant actions, newest first',
    time: 'Time',
    actor: 'Performed by',
    event: 'Event',
    target: 'Object',
    empty: 'Nothing has been audited yet.',
    showAdminViews: 'Show admin page views',
    adminViews: '{count, plural, one {Viewed an admin page} other {Viewed admin pages # times}}',
    agentFor: 'JARVIS, working for {actor}',
    /** An action or object type this client has no wording for (a newer server). */
    unknownEvent: 'Other event',
    unknownTarget: 'Other object',
    actors: {
      user: 'User',
      system: 'System',
      agent: 'JARVIS',
      admin: 'Admin',
    },
    /** One line per audited action (the raw action key is in the row's tooltip). */
    events: {
      account: {
        created: 'Created an account',
        delete_failed: 'Account deletion failed',
        deleted: 'Deleted an account',
        exported: 'Exported account data',
        updated: 'Updated account settings',
      },
      admin: {
        audit_viewed: 'Viewed the audit log',
        users_viewed: 'Viewed the user list',
      },
      approval: {
        approved: 'Approved an action',
        expired: 'An approval expired',
        rejected: 'Declined an action',
        requested: 'Asked for approval',
      },
      attachment: {
        deleted: 'Deleted a file',
        downloaded: 'Downloaded a file',
        uploaded: 'Uploaded a file',
      },
      auth: {
        login: 'Signed in',
        login_failed: 'Sign-in failed',
        logout: 'Signed out',
        session_revoked: 'Signed out a device',
      },
      booking: {
        confirmed: 'Booked an appointment',
      },
      browser: {
        form_submitted: 'Submitted a form on a website',
      },
      calendar: {
        event_cancelled: 'Cancelled a calendar event',
        event_created: 'Created a calendar event',
        event_updated: 'Changed a calendar event',
      },
      connection: {
        connected: 'Connected an account',
        created: 'Connected a service',
        deleted: 'Disconnected a service',
        expired: 'A connection expired',
        oauth_account_mismatch: 'Reconnected with a different account (refused)',
        oauth_failed: 'Connecting an account failed',
        oauth_started: 'Started connecting an account',
        revocation_abandoned: 'Access could not be revoked at the provider',
        scope_missing: 'A connection lacks a permission',
        tested: 'Tested a connection',
        verify_failed: 'A connection check failed',
      },
      conversation: {
        deleted: 'Deleted a conversation',
      },
      do_not_call: {
        removed: 'Removed a number from the do-not-call list',
      },
      email: {
        draft_created: 'Created an email draft',
        sent: 'Sent an email',
        watch_created: 'Started watching for replies',
      },
      email_watch: {
        stopped: 'Stopped watching for replies',
      },
      evidence: {
        downloaded: 'Downloaded evidence',
      },
      memory: {
        deleted: 'Deleted a memory',
        deleted_all: 'Deleted all memories',
        saved: 'Saved a memory',
      },
      order: {
        placed: 'Placed an order',
      },
      phone_verification: {
        started: 'Started verifying a phone number',
        verified: 'Verified a phone number',
      },
      retention: {
        swept: 'Deleted data past its retention period',
      },
      schedule: {
        completed: 'A schedule finished',
        created: 'Created a schedule',
        deleted: 'Deleted a schedule',
        paused: 'Paused a schedule',
        resumed: 'Resumed a schedule',
        updated: 'Changed a schedule',
      },
      skill: {
        toggled: 'Turned a skill on or off',
      },
      task: {
        cancel_requested: 'Asked to cancel a task',
        cancelled: 'Cancelled a task',
        created: 'Created a task',
        retried: 'Retried a task',
      },
      telephony: {
        call_ended: 'A phone call ended',
      },
      tenant: {
        deleted: 'Deleted a tenant',
      },
      tool: {
        outcome_unknown: 'A tool’s result couldn’t be confirmed',
      },
      webhook: {
        created: 'Created a webhook',
        deleted: 'Deleted a webhook',
        disabled: 'A webhook was turned off after failed deliveries',
        secret_rotated: 'Replaced a webhook signing secret',
        test_sent: 'Sent a test event to a webhook',
        updated: 'Changed a webhook',
      },
    },
    targets: {
      approval: 'Approval',
      attachment: 'File',
      booking: 'Booking',
      connection: 'Connection',
      conversation: 'Conversation',
      do_not_call: 'Do-not-call entry',
      email_watch: 'Reply tracking',
      evidence_artifact: 'Evidence',
      memory: 'Memory',
      order: 'Order',
      phone_verification: 'Phone verification',
      schedule: 'Schedule',
      session: 'Session',
      skill: 'Skill',
      task: 'Task',
      task_step: 'Task step',
      tenant: 'Tenant',
      user: 'User',
      webhook_endpoint: 'Webhook',
    },
  },
  scrollHint: 'Scroll sideways to see every column.',
};

export default admin;
