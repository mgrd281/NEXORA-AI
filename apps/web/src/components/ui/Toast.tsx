'use client';

import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import styles from './Toast.module.css';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone?: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void };
  /** ms; default 5 s (errors 8 s). Paused while hovered or focused. */
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'tone' | 'message' | 'duration'>> {
  id: number;
  action?: ToastInput['action'];
}

interface ToastApi {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Transient confirmations ("Request sent", "Copied"). Not for anything the user must act on —
 * use a Banner for that. Success/info are announced politely, errors assertively.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const tone = input.tone ?? 'success';
    setItems((list) =>
      [
        ...list,
        {
          id,
          tone,
          message: input.message,
          action: input.action,
          duration: input.duration ?? (tone === 'error' ? 8000 : 5000),
        },
      ].slice(-3),
    );
    return id;
  }, []);
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  const polite = items.filter((t) => t.tone !== 'error');
  const assertive = items.filter((t) => t.tone === 'error');
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region}>
        <div role="status" aria-live="polite" className={styles.stack}>
          {polite.map((t) => (
            <Toast key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
        <div role="alert" aria-live="assertive" className={styles.stack}>
          {assertive.map((t) => (
            <Toast key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const TONE_ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const;

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => onDismiss(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [paused, item.id, item.duration, onDismiss]);
  return (
    <div
      className={cx(styles.toast, styles[item.tone])}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <span className={styles.icon}>
        <Icon icon={TONE_ICON[item.tone]} size={20} />
      </span>
      <p className={styles.message}>{item.message}</p>
      {item.action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        className={styles.dismiss}
        aria-label={t('common.actions.dismiss')}
        onClick={() => onDismiss(item.id)}
      >
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
}
