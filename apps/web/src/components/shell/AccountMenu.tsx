'use client';

import type { Me } from '@jarvis/contracts';
import { Gauge, Keyboard, LogOut, Settings } from 'lucide-react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { useSignOut } from '@/lib/api/hooks';
import styles from './AccountMenu.module.css';

/** Contents of the account menu (role="menu"; arrow keys handled by Popover). */
export function AccountMenuItems({
  me,
  showAdmin,
  onClose,
  onShortcuts,
}: {
  me: Me | undefined;
  showAdmin: boolean;
  onClose: () => void;
  onShortcuts: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const signOut = useSignOut();
  return (
    <div className={styles.menu}>
      {me && (
        <div className={styles.identity} role="presentation">
          <span className={styles.name} dir="auto">
            {me.displayName}
          </span>
          <span className={styles.email}>
            <span className="ltr">{me.email}</span>
          </span>
        </div>
      )}
      <div className={styles.group} role="group">
        <Link href="/settings" role="menuitem" className={styles.item} onClick={onClose}>
          <Icon icon={Settings} size={16} />
          {t('shell.account.settings')}
        </Link>
        {showAdmin && (
          <Link href="/admin" role="menuitem" className={styles.item} onClick={onClose}>
            <Icon icon={Gauge} size={16} />
            {t('shell.account.admin')}
          </Link>
        )}
        <button
          type="button"
          role="menuitem"
          className={`${styles.item} ${styles.desktopOnly}`}
          onClick={() => {
            onClose();
            onShortcuts();
          }}
        >
          <Icon icon={Keyboard} size={16} />
          {t('shell.account.shortcuts')}
        </button>
      </div>
      <div className={styles.group} role="group">
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          aria-disabled={signOut.isPending || undefined}
          onClick={() => {
            if (signOut.isPending) return;
            signOut.mutate(undefined, {
              onError: () => toast({ tone: 'error', message: t('shell.account.signOutFailed') }),
            });
          }}
        >
          <Icon icon={LogOut} size={16} mirror />
          {signOut.isPending ? t('shell.account.signingOut') : t('shell.account.signOut')}
        </button>
      </div>
    </div>
  );
}
