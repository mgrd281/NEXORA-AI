import { OAUTH_LIMITS } from '@jarvis/contracts';

/** `signal` combined with the provider call timeout (OAUTH_LIMITS.providerTimeoutMs). */
export const providerSignal = (
  signal?: AbortSignal,
  timeoutMs: number = OAUTH_LIMITS.providerTimeoutMs,
) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
