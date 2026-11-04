import type { CallSummary } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
} from 'lucide-react';

const RESULT_ICON: Record<NonNullable<CallSummary['result']>, LucideIcon> = {
  completed: CircleCheck,
  answered: PhoneIncoming,
  busy: PhoneMissed,
  no_answer: PhoneMissed,
  failed: CircleAlert,
  voicemail: PhoneMissed,
  hung_up: PhoneOff,
  declined: PhoneOff,
  canceled: PhoneOff,
};

/** The icon of a call's pill (paired with its label, never alone). */
export function callIcon(call: Pick<CallSummary, 'status' | 'result'>): LucideIcon {
  if (call.status === 'ended' && call.result) return RESULT_ICON[call.result];
  if (call.status === 'unknown') return CircleHelp;
  if (call.status === 'queued') return CircleDashed;
  return PhoneCall;
}
