import type { TaskListQuery } from '@jarvis/contracts';

/**
 * React Query keys. Every screen uses these so that realtime events (lib/events/invalidation.ts)
 * refresh the right caches. Prefix matching applies: invalidating qk.tasks.all refreshes every
 * task list and detail.
 */
export const qk = {
  me: ['me'] as const,
  home: ['home'] as const,
  assistantStatus: ['assistant', 'status'] as const,
  usage: ['usage'] as const,
  tasks: {
    all: ['tasks'] as const,
    lists: ['tasks', 'list'] as const,
    list: (status: TaskListQuery['status'] = 'all') => ['tasks', 'list', status] as const,
    details: ['tasks', 'detail'] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
  },
  approvals: ['approvals'] as const,
  connections: ['connections'] as const,
  memories: {
    all: ['memories'] as const,
    list: (q = '') => ['memories', 'list', q] as const,
  },
  notifications: ['notifications'] as const,
  sessions: ['sessions'] as const,
  admin: {
    all: ['admin'] as const,
    overview: ['admin', 'overview'] as const,
    users: ['admin', 'users'] as const,
    audit: ['admin', 'audit'] as const,
  },
  // Phase B
  conversations: {
    all: ['conversations'] as const,
    lists: ['conversations', 'list'] as const,
    list: (q = '') => ['conversations', 'list', q] as const,
    details: ['conversations', 'detail'] as const,
    detail: (id: string) => ['conversations', 'detail', id] as const,
  },
  schedules: {
    all: ['schedules'] as const,
    list: ['schedules', 'list'] as const,
    detail: (id: string) => ['schedules', 'detail', id] as const,
  },
  skills: ['skills'] as const,
  webhooks: {
    all: ['webhooks'] as const,
    list: ['webhooks', 'list'] as const,
    deliveries: (id: string) => ['webhooks', 'deliveries', id] as const,
  },
  timeZones: ['meta', 'timeZones'] as const,
  // Phase C
  connectionProviders: ['connections', 'providers'] as const,
  calendar: {
    all: ['calendar'] as const,
    upcoming: ['calendar', 'upcoming'] as const,
  },
  emailWatches: ['email', 'watches'] as const,
  orders: {
    all: ['orders'] as const,
    list: ['orders', 'list'] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
  },
  bookings: {
    all: ['bookings'] as const,
    list: ['bookings', 'list'] as const,
    detail: (id: string) => ['bookings', 'detail', id] as const,
  },
};

export type QueryKey = readonly unknown[];
