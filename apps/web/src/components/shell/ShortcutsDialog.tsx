'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Kbd } from '@/components/ui/Kbd';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './ShortcutsDialog.module.css';

function isApple(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(platform);
}

/** ⌘ on Apple platforms, Ctrl elsewhere (Ctrl during server rendering). */
export function useModKey(): string {
  return useSyncExternalStore(
    () => () => undefined,
    () => (isApple() ? '⌘' : 'Ctrl'),
    () => 'Ctrl',
  );
}

/** The few keyboard shortcuts JARVIS has, documented in one place ('?'). */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const mod = useModKey();
  const rows: Array<{ label: string; keys: ReactNode }> = [
    {
      label: t('shell.shortcuts.focusComposer'),
      keys: (
        <>
          <Kbd>{mod}</Kbd>
          <Kbd>K</Kbd>
          <span className={styles.or}>{t('shell.shortcuts.or')}</span>
          <Kbd>/</Kbd>
        </>
      ),
    },
    { label: t('shell.shortcuts.send'), keys: <Kbd>{t('composer.keyEnter')}</Kbd> },
    {
      label: t('shell.shortcuts.newLine'),
      keys: (
        <>
          <Kbd>{t('composer.keyShift')}</Kbd>
          <Kbd>{t('composer.keyEnter')}</Kbd>
        </>
      ),
    },
    { label: t('shell.shortcuts.showShortcuts'), keys: <Kbd>?</Kbd> },
    { label: t('shell.shortcuts.closeOverlay'), keys: <Kbd>Esc</Kbd> },
  ];
  return (
    <Dialog open={open} onClose={onClose} title={t('shell.shortcuts.title')} size="sm">
      <dl className={styles.list}>
        {rows.map((row) => (
          <div key={row.label} className={styles.row}>
            <dt>{row.label}</dt>
            <dd className={styles.keys}>{row.keys}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
