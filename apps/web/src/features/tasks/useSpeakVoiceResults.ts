'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useSpeakResponses } from '@/components/voice/useSpeakResponses';
import { useI18n } from '@/i18n/I18nProvider';
import { serverText } from '@/i18n/server-message';
import { stripIsolates } from '@/i18n/translate';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { useStreamEvent } from '@/lib/events/EventStreamProvider';

/** Tasks already read aloud in this tab (several screens may listen; speak once). */
const spoken = new Set<string>();

/**
 * When a task started by voice completes (live task.status_changed → COMPLETED) and the account
 * turned on preferences.voice.speakResponses, reads its result summary aloud — the server's
 * result (a server sentence in the interface language, the voice's language), never a
 * client-made sentence. Only live completions are spoken, not old ones.
 */
export function useSpeakVoiceResults(): void {
  const i18n = useI18n();
  const queryClient = useQueryClient();
  const { enabled, speak } = useSpeakResponses();
  useStreamEvent(
    (event) => {
      if (!enabled || !event.taskId || event.data.to !== 'COMPLETED') return;
      const taskId = event.taskId;
      if (spoken.has(taskId)) return;
      spoken.add(taskId);
      void queryClient
        .fetchQuery({
          queryKey: qk.tasks.detail(taskId),
          queryFn: ({ signal }) => api.call('getTask', { params: { id: taskId }, signal }),
          staleTime: 0,
        })
        .then(
          (task) => {
            if (task.source === 'voice' && task.status === 'COMPLETED' && task.resultSummary) {
              speak(stripIsolates(serverText(i18n, task.resultSummaryMessage, task.resultSummary)));
            }
          },
          () => spoken.delete(taskId),
        );
    },
    ['task.status_changed'],
  );
}
