'use client';

import type { Locale, TaskDetail, TaskSummary } from '@jarvis/contracts';
import { isTerminal } from '@jarvis/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { localeFromSpeech, SPEECH_LOCALE, type SpeechLocale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { api, newIdempotencyKey } from '@/lib/api/client';
import { useMe } from '@/lib/api/hooks';
import { qk } from '@/lib/api/query-keys';
import { useEventStreamStatus, useStreamEvent } from '@/lib/events/EventStreamProvider';
import { markTaskSpoken } from '@/features/tasks/useSpeakVoiceResults';
import {
  createBrowserRecognizer,
  createBrowserSynthesizer,
  requestMicrophone,
} from './engine/browser';
import {
  ConversationController,
  type ConversationEnd,
  type ConversationSnapshot,
  type SubmitRequest,
  type SubmittedTask,
} from './engine/controller';
import type { SpeechRecognizer, SpeechSynthesizer } from './engine/types';
import { classifySubmitError, taskView } from './replies';

export interface VoiceRequestBody {
  request: string;
  source: 'voice' | 'text';
  language: Locale;
  voiceSessionId?: string;
}

export interface UseVoiceConversationOptions {
  /** The conversation to continue (a follow-up field), or null to start one. */
  conversationId: string | null;
  /**
   * Sends the first request through the composer that opened voice mode (its files, its
   * Idempotency-Key per intent); later ones are follow-ups in the conversation it starts.
   */
  firstSubmit?: (body: VoiceRequestBody) => Promise<TaskSummary>;
  recognitionLang: SpeechLocale;
  /** An utterance that was not sent: it goes into the overlay's text field. */
  onDraft: (text: string) => void;
  /** The conversation ended (the session record is closed here). */
  onEnded: (end: ConversationEnd, lastTaskId: string | null) => void;
}

/** The Web Speech engines, created once per overlay (tests replace the browser APIs, not this). */
function useEngines(): { recognizer: SpeechRecognizer; synthesizer: SpeechSynthesizer } {
  const [engines] = useState(() => ({
    recognizer: createBrowserRecognizer(),
    synthesizer: createBrowserSynthesizer(),
  }));
  return engines;
}

/**
 * Voice conversation mode on the realtime stream: one ConversationController per overlay, fed
 * with the current task (React Query, refreshed by stream events, polled while the stream is
 * down) and its task.answer.delta events; the voice session record carries metadata only.
 */
export function useVoiceConversation(options: UseVoiceConversationOptions) {
  const i18n = useI18n();
  const queryClient = useQueryClient();
  const me = useMe();
  const engines = useEngines();
  const streamStatus = useEventStreamStatus();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [controller, setController] = useState<ConversationController | null>(null);
  const prefs = me.data?.preferences.voice;
  const live = useRef({ options, prefs });
  useEffect(() => {
    live.current = { options, prefs };
  });
  const copy = useMemo(
    () => ({
      lang: i18n.speechLocale,
      approvalOnScreen: i18n.t('voice.conversation.lines.approvalOnScreen'),
      busy: i18n.t('voice.conversation.lines.busy'),
      idleWarning: i18n.t('voice.conversation.lines.idleWarning'),
    }),
    [i18n],
  );
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  });

  // One controller (and one voice session record) per mount; Strict Mode's extra mount is
  // disposed before the session is recorded.
  useEffect(() => {
    let disposed = false;
    let micStream: MediaStream | null = null;
    let sessionId: Promise<string | null> | null = null;
    let lastTaskId: string | null = null;
    let sent = 0;
    const ensureSession = () => {
      sessionId ??= api
        .call('startVoiceSession', {
          body: {
            locale: live.current.options.recognitionLang,
            engine: 'browser_speech',
            mode: 'conversation',
            ...(live.current.options.conversationId
              ? { conversationId: live.current.options.conversationId }
              : {}),
          },
        })
        .then(
          (s) => s.id,
          () => null,
        );
      return sessionId;
    };
    const voiceFor = (lang: string): string | null => {
      const names = live.current.prefs?.voiceNames;
      const key = lang.slice(0, 2) as Locale;
      return names?.[key] ?? null;
    };
    const c = new ConversationController(
      {
        recognizer: engines.recognizer,
        synthesizer: engines.synthesizer,
        acquireMic: async () => {
          if (micStream) return 'granted';
          const { result, stream: media } = await requestMicrophone();
          if (disposed) {
            media?.getTracks().forEach((track) => track.stop());
            return 'error';
          }
          micStream = media;
          setStream(media);
          return result;
        },
        submit: async (req: SubmitRequest): Promise<SubmittedTask> => {
          const voiceSessionId = (await ensureSession()) ?? undefined;
          const body = {
            request: req.text,
            source: req.source,
            language: req.language,
            ...(voiceSessionId ? { voiceSessionId } : {}),
          };
          // The first request goes through the composer that opened voice mode (its files, its
          // conversation); every later one is a follow-up in the conversation it started.
          const first = sent === 0 ? live.current.options.firstSubmit : undefined;
          const task: TaskSummary = first
            ? await first(body)
            : req.conversationId
              ? await api.call('followUp', {
                  params: { id: req.conversationId },
                  body,
                  idempotencyKey: req.idempotencyKey,
                })
              : await api.call('createTask', { body, idempotencyKey: req.idempotencyKey });
          sent += 1;
          // This conversation speaks its own replies (the app-wide read-aloud must not repeat them).
          markTaskSpoken(task.id);
          lastTaskId = task.id;
          void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
          void queryClient.invalidateQueries({ queryKey: qk.home });
          void queryClient.invalidateQueries({ queryKey: qk.conversations.all });
          return {
            id: task.id,
            conversationId: task.conversationId ?? req.conversationId,
            status: task.status,
          };
        },
        classifyError: classifySubmitError,
        newKey: newIdempotencyKey,
        copy: copyRef.current,
        settings: {
          recognitionLang: live.current.options.recognitionLang,
          language: localeFromSpeech(live.current.options.recognitionLang),
          silenceMs: live.current.prefs?.endOfSpeechSilenceMs ?? 1200,
          rate: live.current.prefs?.speakingRate ?? 1,
          voiceFor,
        },
        onDraft: (text) => live.current.options.onDraft(text),
        onEnded: (end) => {
          // Metadata only: counters, the reason — never audio, never what was said. (Strict
          // Mode's throwaway mount never recorded a session, so it ends none.)
          void sessionId?.then((id) => {
            if (!id) return;
            const outcome =
              end.counters.turns > 0 ? 'ended' : end.reason === 'error' ? 'error' : 'cancelled';
            return api
              .call('endVoiceSession', {
                params: { id },
                body: {
                  outcome,
                  transcriptChars: Math.min(end.counters.chars, 100_000),
                  turns: Math.min(end.counters.turns, 500),
                  bargeIns: Math.min(end.counters.bargeIns, 10_000),
                  reconnects: Math.min(end.counters.reconnects, 1_000),
                  endReason: end.reason,
                  ...(end.errorCode ? { errorCode: end.errorCode.slice(0, 64) } : {}),
                },
              })
              .catch(() => undefined);
          });
          if (!disposed) live.current.options.onEnded(end, lastTaskId);
        },
      },
      { conversationId: live.current.options.conversationId },
    );
    // Recorded once the overlay really stays open (not for Strict Mode's throwaway mount).
    const startTimer = window.setTimeout(() => {
      if (disposed) return;
      void ensureSession();
      void c.start();
    }, 0);
    setController(c);
    return () => {
      window.clearTimeout(startTimer);
      // Leaving the overlay (or the page) ends voice mode; a running task keeps running.
      disposed = true;
      c.end('navigation');
      micStream?.getTracks().forEach((track) => track.stop());
      setStream(null);
    };
    // One controller for the overlay's lifetime: the engines and the query client never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preferences and the recognition language can change while it runs.
  const silenceMs = prefs?.endOfSpeechSilenceMs;
  const rate = prefs?.speakingRate;
  useEffect(() => {
    if (!controller) return;
    controller.updateSettings({
      ...(silenceMs !== undefined ? { silenceMs } : {}),
      ...(rate !== undefined ? { rate } : {}),
      recognitionLang: options.recognitionLang,
      language: localeFromSpeech(options.recognitionLang),
    });
  }, [controller, silenceMs, rate, options.recognitionLang]);
  useEffect(() => {
    controller?.updateCopy(copy);
  }, [controller, copy]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? emptySnapshot,
    controller?.getSnapshot ?? emptySnapshot,
  );

  // The current task: refreshed by stream events; polled while the stream is down.
  const streamDown = streamStatus === 'reconnecting' || streamStatus === 'closed';
  const taskId = snapshot.taskId;
  const task = useQuery({
    queryKey: qk.tasks.detail(taskId ?? 'none'),
    queryFn: ({ signal }) => api.call('getTask', { params: { id: taskId! }, signal }),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const data = query.state.data as TaskDetail | undefined;
      return streamDown && (!data || !isTerminal(data.status)) ? 3000 : false;
    },
  });
  const requestLang = useRef(options.recognitionLang);
  useEffect(() => {
    if (snapshot.turn === 'submitting') requestLang.current = options.recognitionLang;
  }, [snapshot.turn, options.recognitionLang]);
  useEffect(() => {
    if (!controller || !task.data) return;
    // The request's language as the planner detected it (TaskDetail.language), else the
    // recognition language of the utterance.
    const request = task.data.language ? SPEECH_LOCALE[task.data.language] : requestLang.current;
    controller.updateTask(taskView(i18n, task.data, { ui: SPEECH_LOCALE[i18n.locale], request }));
  }, [controller, task.data, i18n]);
  useEffect(() => {
    controller?.setStreamDown(streamDown);
  }, [controller, streamDown]);
  useStreamEvent(
    (event) => {
      const text = event.data.text;
      if (controller && event.taskId && typeof text === 'string' && text) {
        controller.answerDelta(event.taskId, text);
      }
    },
    ['task.answer.delta'],
  );

  return {
    controller,
    snapshot,
    task: task.data ?? null,
    stream,
    recognitionSupported: engines.recognizer.supported,
    synthesisSupported: engines.synthesizer.supported,
  };
}

const noopSubscribe = () => () => undefined;
const EMPTY: ConversationSnapshot = {
  turn: 'ready',
  mic: 'off',
  heard: '',
  interim: '',
  captions: [],
  taskId: null,
  conversationId: null,
  approvalId: null,
  error: null,
  notice: null,
  streamDown: false,
  speaking: null,
  counters: { turns: 0, bargeIns: 0, reconnects: 0, chars: 0 },
  endReason: null,
};
const emptySnapshot = () => EMPTY;
