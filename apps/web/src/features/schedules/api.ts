'use client';

import type {
  CreateScheduleRequest,
  Recurrence,
  Schedule,
  UpdateScheduleRequest,
} from '@jarvis/contracts';
import { Recurrence as RecurrenceSchema, SCHEDULE_LIMITS } from '@jarvis/contracts';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, newIdempotencyKey, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

export function useSchedules() {
  return useQuery({
    queryKey: qk.schedules.list,
    queryFn: ({ signal }) => api.call('listSchedules', { signal }),
  });
}

/** A schedule with its upcoming occurrences and recent runs (loaded when shown). */
export function useScheduleDetail(id: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.schedules.detail(id),
    queryFn: ({ signal }) => api.call('getSchedule', { params: { id }, signal }),
    enabled,
  });
}

/** The server's copy replaces the cached one; detail and the rest refresh. */
function store(queryClient: QueryClient, schedule: Schedule) {
  queryClient.setQueryData<{ items: Schedule[] }>(qk.schedules.list, (prev) => {
    if (!prev) return prev;
    const found = prev.items.some((s) => s.id === schedule.id);
    return {
      items: found
        ? prev.items.map((s) => (s.id === schedule.id ? schedule : s))
        : [schedule, ...prev.items],
    };
  });
  void queryClient.invalidateQueries({ queryKey: qk.schedules.all });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  // One key per editor session: a retry after a network error never creates a second schedule.
  const key = useRef(newIdempotencyKey());
  return useMutation<Schedule, ApiError, CreateScheduleRequest>({
    mutationFn: (body) => api.call('createSchedule', { body, idempotencyKey: key.current }),
    onSuccess: (schedule) => {
      key.current = newIdempotencyKey();
      store(queryClient, schedule);
    },
  });
}

export function useUpdateSchedule(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Schedule, ApiError, UpdateScheduleRequest>({
    mutationFn: (body) => api.call('updateSchedule', { params: { id }, body }),
    onSuccess: (schedule) => store(queryClient, schedule),
  });
}

export function usePauseResume(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Schedule, ApiError, 'pause' | 'resume'>({
    mutationFn: (action) =>
      api.call(action === 'pause' ? 'pauseSchedule' : 'resumeSchedule', { params: { id } }),
    onSuccess: (schedule) => store(queryClient, schedule),
  });
}

export function useDeleteSchedule(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteSchedule', { params: { id } }),
    onSuccess: () => {
      queryClient.setQueryData<{ items: Schedule[] }>(qk.schedules.list, (prev) =>
        prev ? { items: prev.items.filter((s) => s.id !== id) } : prev,
      );
      queryClient.removeQueries({ queryKey: qk.schedules.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.schedules.all });
      void queryClient.invalidateQueries({ queryKey: qk.conversations.all });
    },
  });
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The next occurrences of a recurrence, worked out by the server (POST /v1/schedules/preview,
 * nothing saved), as the user edits it. Only valid recurrences are sent.
 */
export function useSchedulePreview(recurrence: Recurrence, count = SCHEDULE_LIMITS.upcomingShown) {
  const settled = useDebounced(recurrence, 250);
  const valid = RecurrenceSchema.safeParse(settled).success;
  return useQuery({
    queryKey: ['schedules', 'preview', JSON.stringify(settled), count],
    queryFn: ({ signal }) =>
      api.call('previewSchedule', { body: { recurrence: settled, count }, signal }),
    enabled: valid,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
