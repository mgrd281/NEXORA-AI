/**
 * What the conversation overlay says it is doing (pure): only ever the real state — the turn of
 * the conversation and the microphone (ADR-0019 "honest states").
 */
import type { PresenceState } from '@/components/presence/model';
import type { MessageKey } from '@/i18n/catalog';
import type { ConversationSnapshot } from './engine/controller';

export type Display =
  | 'requesting'
  | 'listening'
  | 'paused'
  | 'sending'
  | 'retrying'
  | 'thinking'
  | 'reconnecting'
  | 'speaking'
  | 'awaiting'
  | 'failed'
  | 'unsupported'
  | 'denied'
  | 'noMicrophone'
  | 'micError'
  | 'ended';

/** What the overlay says it is doing — only ever the real state (ADR-0019 "honest states"). */
export function displayOf(s: Pick<ConversationSnapshot, 'turn' | 'mic' | 'streamDown'>): Display {
  switch (s.turn) {
    case 'ended':
      return 'ended';
    case 'failed':
      return 'failed';
    case 'retrying':
      return 'retrying';
    case 'submitting':
      return 'sending';
    case 'thinking':
      return s.streamDown ? 'reconnecting' : 'thinking';
    case 'speaking':
      return 'speaking';
    case 'awaiting_approval':
      return 'awaiting';
    case 'ready':
      switch (s.mic) {
        case 'on':
          return 'listening';
        case 'muted':
        case 'off':
          return 'paused';
        case 'starting':
          return 'requesting';
        case 'unsupported':
          return 'unsupported';
        case 'denied':
          return 'denied';
        case 'no-mic':
          return 'noMicrophone';
        case 'error':
          return 'micError';
      }
  }
}

export const PRESENCE: Record<Display, PresenceState> = {
  requesting: 'idle',
  listening: 'listening',
  paused: 'idle',
  sending: 'thinking',
  retrying: 'reconnecting',
  thinking: 'thinking',
  reconnecting: 'reconnecting',
  speaking: 'speaking',
  awaiting: 'awaiting',
  failed: 'failed',
  unsupported: 'idle',
  denied: 'failed',
  noMicrophone: 'failed',
  micError: 'failed',
  ended: 'idle',
};

export const HELP: Partial<Record<Display, MessageKey>> = {
  listening: 'voice.conversation.states.listeningHelp',
  paused: 'voice.conversation.states.pausedHelp',
  retrying: 'voice.conversation.states.retryingHelp',
  reconnecting: 'voice.conversation.states.reconnectingHelp',
  speaking: 'voice.conversation.states.speakingHelp',
  failed: 'voice.conversation.states.failedHelp',
  denied: 'voice.conversation.states.deniedHelp',
  noMicrophone: 'voice.conversation.states.noMicrophoneHelp',
  micError: 'voice.conversation.states.micErrorHelp',
};
