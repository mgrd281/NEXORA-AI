/**
 * Phase D — offline intents of the telephony domain (owner: telephony engineer;
 * docs/architecture/phase-d.md §3.2): "call <who> <number> and tell them …" (purpose
 * message), "call <number> and ask whether they have an appointment free on <day>"
 * (availability), "call <number> and ask: …?" (questions) — en/de/ar ("ruf … an",
 * "اتصل بـ …"). Rules (see ../types.ts): the number only as the user wrote it
 * (lib/phone.ts phoneNumbersInText with OfflinePlanContext.phoneRegion; none →
 * clarify phone_number; nothing to say or ask → clarify call_goal); a binding booking by
 * phone needs the model (offline says so honestly); the call language is the request's
 * unless the user names another; personal details only those the user wrote for the call.
 */
import type { OfflineIntent } from '../types';
import { phoneCallIntent } from './calls';

export { callRequestHead, isCallRequest } from './calls';

export const telephonyIntents: readonly OfflineIntent[] = [phoneCallIntent];
