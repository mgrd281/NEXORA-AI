import { ErrorCode } from '@jarvis/contracts';
import type { I18n } from '@/i18n/I18nProvider';
import { ApiError } from './client';

export interface DescribedError {
  /** Localized, friendly sentence for the error code. */
  message: string;
  /** The API's own user-safe message, when it adds something (shown under "Details"). */
  detail: string | null;
  requestId: string | null;
  code: string;
}

/**
 * Turns any thrown value into localized copy. The friendly sentence comes from the errors
 * catalog (every ErrorCode has one); the API's message and request ID go into the details.
 */
export function describeError(error: unknown, i18n: Pick<I18n, 't'>): DescribedError {
  const { t } = i18n;
  if (error instanceof ApiError) {
    let message: string;
    if (error.code === 'NETWORK') message = t('errors.network');
    else if (error.code === 'BAD_RESPONSE') message = t('errors.badResponse');
    else if (ErrorCode.safeParse(error.code).success) message = t(`errors.codes.${error.code}`);
    else message = t('errors.generic');
    const detail =
      error.message &&
      error.code !== 'NETWORK' &&
      error.code !== 'BAD_RESPONSE' &&
      error.message !== message
        ? error.message
        : null;
    return { message, detail, requestId: error.requestId ?? null, code: error.code };
  }
  return { message: t('errors.generic'), detail: null, requestId: null, code: 'UNKNOWN' };
}
