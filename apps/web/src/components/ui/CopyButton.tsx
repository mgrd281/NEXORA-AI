'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { IconButton } from './Button';

/**
 * Copies a value (hash, Message-ID, URL) to the clipboard and confirms with a check mark and a
 * polite announcement. `label` names what is copied, e.g. "Message-ID".
 */
export function CopyButton({
  value,
  label,
  size = 'sm',
}: {
  value: string;
  label: string;
  size?: 'sm' | 'md';
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }

  return (
    <>
      <IconButton
        label={t('common.actions.copyValue', { label })}
        icon={state === 'copied' ? Check : Copy}
        size={size}
        onClick={copy}
      />
      <span className="visually-hidden" role="status" aria-live="polite">
        {state === 'copied'
          ? t('common.actions.copied')
          : state === 'failed'
            ? t('common.actions.copyFailed')
            : ''}
      </span>
    </>
  );
}
