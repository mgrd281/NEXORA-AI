'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './TaskCenter.module.css';

export type TaskCenterView = 'tasks' | 'conversations' | 'scheduled';

const VIEWS: ReadonlyArray<{ view: TaskCenterView; href: string }> = [
  { view: 'tasks', href: '/tasks' },
  { view: 'conversations', href: '/tasks/conversations' },
  { view: 'scheduled', href: '/tasks/scheduled' },
];

/**
 * The Task Center's three views under its title: every task, the same work grouped as
 * conversations (history), and what is scheduled. Conversation history and schedules live here
 * rather than in the sidebar, so the primary navigation keeps its five destinations and the
 * "Tasks" item stays the one place for everything JARVIS did or will do.
 */
export function TaskCenterNav({ current }: { current: TaskCenterView }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('tasks.views.label')} className={styles.views}>
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari */}
      <ul className={styles.viewList} role="list">
        {VIEWS.map(({ view, href }) => (
          <li key={view}>
            <Link
              href={href}
              className={styles.viewLink}
              aria-current={view === current ? 'page' : undefined}
            >
              {t(`tasks.views.${view}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
