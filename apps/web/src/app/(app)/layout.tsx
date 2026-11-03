import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { SESSION_COOKIE } from '@/i18n/config';

/**
 * Authenticated area. Without a session cookie there is nothing to show: go to sign-in and come
 * back afterwards. A cookie whose session has ended is caught by the first API call (401 →
 * sign-in); the API is the authority on sessions.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)?.value) {
    const path = (await headers()).get('x-jarvis-pathname');
    redirect(path && path !== '/' ? `/sign-in?next=${encodeURIComponent(path)}` : '/sign-in');
  }
  return <AppShell>{children}</AppShell>;
}
