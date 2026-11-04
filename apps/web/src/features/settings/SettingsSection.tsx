'use client';

import type { ReactNode } from 'react';
import { Section } from '@/components/ui/Card';
import styles from './settings.module.css';

/** The settings sections the sub-navigation and #hash deep links point to, in page order. */
export const SETTINGS_SECTIONS = [
  'profile',
  'language',
  'appearance',
  'voice',
  'assistant',
  'skills',
  'usage',
  'spending',
  'notifications',
  'replies',
  'security',
  'privacy',
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/** One anchored settings section (h2 + description), e.g. /settings#assistant. */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: SettingsSectionId;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Section id={id} title={title} description={description} className={styles.section}>
      <div className={styles.stack}>{children}</div>
    </Section>
  );
}
