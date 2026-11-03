import type { LucideIcon } from 'lucide-react';
import { Brain, Gauge, House, ListChecks, Plug, Settings } from 'lucide-react';
import type { MessageKey } from '@/i18n/catalog';

export interface NavItem {
  key: 'home' | 'tasks' | 'memory' | 'connections' | 'settings' | 'admin';
  href: string;
  icon: LucideIcon;
  label: MessageKey;
}

/** Primary destinations (sidebar on desktop, bottom tab bar on phones). */
export const PRIMARY_NAV: readonly NavItem[] = [
  { key: 'home', href: '/', icon: House, label: 'shell.nav.home' },
  { key: 'tasks', href: '/tasks', icon: ListChecks, label: 'shell.nav.tasks' },
  { key: 'memory', href: '/memory', icon: Brain, label: 'shell.nav.memory' },
  { key: 'connections', href: '/connections', icon: Plug, label: 'shell.nav.connections' },
  { key: 'settings', href: '/settings', icon: Settings, label: 'shell.nav.settings' },
];

export const ADMIN_NAV: NavItem = {
  key: 'admin',
  href: '/admin',
  icon: Gauge,
  label: 'shell.nav.admin',
};

export function isActive(item: Pick<NavItem, 'href'>, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Section title for the mobile top bar. */
export function sectionFor(pathname: string): NavItem {
  return [...PRIMARY_NAV, ADMIN_NAV].find((item) => isActive(item, pathname)) ?? PRIMARY_NAV[0]!;
}
