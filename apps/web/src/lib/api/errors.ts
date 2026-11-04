import { ApiErrorReason, ErrorCode } from '@jarvis/contracts';
import type { I18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/catalog';
import type { MessageParams } from '@/i18n/types';
import { ApiError } from './client';

export interface DescribedError {
  /** Localized, friendly sentence for the error code (or its specific reason). */
  message: string;
  /** The API's own user-safe message, when it adds something (shown under "Details"). */
  detail: string | null;
  requestId: string | null;
  code: string;
}

/** The specific cause the API sent in error.details.reason, when this client knows it. */
export function apiErrorReason(error: unknown): ApiErrorReason | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = ApiErrorReason.safeParse(error.details?.reason);
  return parsed.success ? parsed.data : null;
}

/** Catalog key of an API error reason: 'FILE_TOO_LARGE' → 'errors.api.FILE_TOO_LARGE'. */
export function apiReasonCatalogKey(reason: ApiErrorReason): MessageKey {
  return `errors.api.${reason}` as MessageKey;
}

/** Parameters of a reason's sentence from error.details (sizes in MB, counts, hosts). */
export function apiReasonParams(details: Record<string, unknown> | undefined): MessageParams {
  const params: MessageParams = {};
  for (const [name, value] of Object.entries(details ?? {})) {
    if (name === 'reason') continue;
    if (typeof value === 'string' || typeof value === 'number') params[name] = value;
  }
  const bytes = details?.limitBytes;
  if (typeof bytes === 'number') params.limitMb = Math.round(bytes / (1024 * 1024));
  return params;
}

/**
 * Turns any thrown value into localized copy. The friendly sentence comes from the errors
 * catalog: the specific API reason (error.details.reason) when there is one, else the code's
 * sentence (every ErrorCode has one); the API's message and request ID go into the details.
 */
export function describeError(error: unknown, i18n: Pick<I18n, 't'>): DescribedError {
  const { t } = i18n;
  if (error instanceof ApiError) {
    let message: string;
    const reason = apiErrorReason(error);
    if (reason) message = t(apiReasonCatalogKey(reason), apiReasonParams(error.details));
    else if (error.code === 'NETWORK') message = t('errors.network');
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
