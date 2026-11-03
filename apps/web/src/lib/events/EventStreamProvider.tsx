'use client';

import { StreamEvent } from '@jarvis/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StreamStatus } from '@/components/presence/model';
import { api } from '../api/client';
import type { QueryKey } from '../api/query-keys';
import { queriesToInvalidate, RECONNECT_INVALIDATIONS } from './invalidation';

export type { StreamStatus };
export type StreamListener = (event: StreamEvent) => void;

interface EventStreamContextValue {
  status: StreamStatus;
  subscribe: (listener: StreamListener) => () => void;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

export const EVENTS_URL = '/api/v1/events';
const INVALIDATE_BATCH_MS = 120;
const MAX_BACKOFF_MS = 30_000;

/**
 * One EventSource per tab on /api/v1/events (proxied to the API's SSE stream). The browser
 * reconnects by itself and sends Last-Event-ID; when it gives up (CLOSED, e.g. after a 401 or a
 * 429), we reconnect with backoff, passing ?lastEventId= so nothing is missed. Each event
 * invalidates the affected queries (batched); listeners receive every event, including the
 * ephemeral task.answer.delta.
 */
export function EventStreamProvider({
  children,
  enabled = true,
  url = EVENTS_URL,
}: {
  children: ReactNode;
  enabled?: boolean;
  url?: string;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const listeners = useRef(new Set<StreamListener>());

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !('EventSource' in window)) return;
    let source: EventSource | null = null;
    let lastEventId: string | null = null;
    let attempt = 0;
    let everOpened = false;
    let retryTimer: number | undefined;
    let flushTimer: number | undefined;
    let disposed = false;
    const pending = new Map<string, QueryKey>();

    const flush = () => {
      flushTimer = undefined;
      for (const key of pending.values()) {
        void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
      }
      pending.clear();
    };
    const queueInvalidation = (keys: QueryKey[]) => {
      for (const key of keys) pending.set(JSON.stringify(key), key);
      if (pending.size > 0 && flushTimer === undefined) {
        flushTimer = window.setTimeout(flush, INVALIDATE_BATCH_MS);
      }
    };

    const connect = () => {
      if (disposed) return;
      window.clearTimeout(retryTimer);
      source?.close();
      const target = lastEventId ? `${url}?lastEventId=${encodeURIComponent(lastEventId)}` : url;
      const es = new EventSource(target);
      source = es;
      es.onopen = () => {
        attempt = 0;
        if (everOpened) queueInvalidation(RECONNECT_INVALIDATIONS);
        everOpened = true;
        setStatus('open');
      };
      es.onmessage = (message: MessageEvent<string>) => {
        if (message.lastEventId) lastEventId = message.lastEventId;
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        const parsed = StreamEvent.safeParse(data);
        if (!parsed.success) return;
        queueInvalidation(queriesToInvalidate(parsed.data));
        for (const listener of listeners.current) {
          try {
            listener(parsed.data);
          } catch (err) {
            console.error('[events] listener failed', err);
          }
        }
      };
      es.onerror = () => {
        if (disposed) return;
        if (es.readyState === EventSource.CLOSED) {
          setStatus(everOpened ? 'reconnecting' : 'closed');
          scheduleReconnect();
        } else {
          // The browser is retrying (it resends Last-Event-ID).
          setStatus(everOpened ? 'reconnecting' : 'connecting');
        }
      };
    };

    const scheduleReconnect = () => {
      source?.close();
      source = null;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        // A closed stream is often an ended session: this call redirects to sign-in on 401.
        void api.call('getMe').then(connect, (err: unknown) => {
          const status = (err as { status?: number }).status;
          if (status === 401) return;
          scheduleReconnect();
        });
      }, delay);
    };

    const reconnectNow = () => {
      if (disposed) return;
      if (!source || source.readyState === EventSource.CLOSED) {
        attempt = 0;
        connect();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };

    connect();
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(flushTimer);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible);
      source?.close();
    };
  }, [enabled, url, queryClient]);

  const subscribe = useCallback((listener: StreamListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo<EventStreamContextValue>(
    () => ({ status, subscribe }),
    [status, subscribe],
  );
  return <EventStreamContext.Provider value={value}>{children}</EventStreamContext.Provider>;
}

function useEventStreamContext(): EventStreamContextValue {
  const ctx = useContext(EventStreamContext);
  if (!ctx) throw new Error('Event stream hooks must be used inside <EventStreamProvider>');
  return ctx;
}

/** 'connecting' | 'open' | 'reconnecting' | 'closed' — drives Presence 'reconnecting'. */
export function useEventStreamStatus(): StreamStatus {
  return useEventStreamContext().status;
}

/**
 * Calls `handler` for every stream event (optionally filtered by type). The latest handler is
 * used without resubscribing, so inline functions are fine.
 */
export function useStreamEvent(
  handler: StreamListener,
  types?: readonly StreamEvent['type'][],
): void {
  const { subscribe } = useEventStreamContext();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const typesKey = types?.join(',') ?? '';
  useEffect(() => {
    const allowed = typesKey ? new Set(typesKey.split(',')) : null;
    return subscribe((event) => {
      if (!allowed || allowed.has(event.type)) handlerRef.current(event);
    });
  }, [subscribe, typesKey]);
}

/**
 * Streaming answer text for one task, assembled from ephemeral task.answer.delta events
 * ({ text }). Deltas are not replayed after a reconnect, so prefer TaskDetail.answer once it is
 * set; `text` resets when the task id changes.
 */
export function useAnswerStream(taskId: string | null | undefined): {
  text: string;
  receiving: boolean;
} {
  const [state, setState] = useState<{ taskId: string | null | undefined; text: string }>({
    taskId,
    text: '',
  });
  if (state.taskId !== taskId) setState({ taskId, text: '' });
  useStreamEvent(
    (event) => {
      if (!taskId || event.taskId !== taskId) return;
      const text = event.data.text;
      if (typeof text !== 'string' || text === '') return;
      setState((s) => (s.taskId === taskId ? { taskId, text: s.text + text } : s));
    },
    ['task.answer.delta'],
  );
  const text = state.taskId === taskId ? state.text : '';
  return { text, receiving: text.length > 0 };
}
