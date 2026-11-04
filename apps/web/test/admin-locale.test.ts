/**
 * The admin page speaks German or Arabic only (features/admin/locale.ts): how the language is
 * resolved, what the scoped catalog holds, that the admin code renders nothing outside it, and
 * that every server value the page shows (audit actions and objects, tools) has wording.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolId } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { auditEventKey, auditTargetKey, toolLabelKey } from '@/features/admin/format';
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_LOCALES,
  ADMIN_NAMESPACES,
  DEFAULT_ADMIN_LOCALE,
  adminDir,
  pickAdminMessages,
  resolveAdminLocale,
} from '@/features/admin/locale';
import { lookup, createTranslator } from '@/i18n/translate';
import type { Messages } from '@/i18n/catalog';
import { catalogs } from '@/i18n/messages';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '../src');
const apiSrc = path.resolve(here, '../../api/src');

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('admin language', () => {
  it('is German by default and Arabic only when the cookie says so — never English', () => {
    expect(ADMIN_LOCALES).toEqual(['de', 'ar']);
    expect(DEFAULT_ADMIN_LOCALE).toBe('de');
    expect(ADMIN_LOCALE_COOKIE).toBe('jarvis_admin_locale');
    expect(resolveAdminLocale(undefined)).toBe('de');
    expect(resolveAdminLocale(null)).toBe('de');
    expect(resolveAdminLocale('')).toBe('de');
    expect(resolveAdminLocale('de')).toBe('de');
    expect(resolveAdminLocale('ar')).toBe('ar');
    for (const other of ['en', 'EN', 'AR', ' ar', 'ar-SA', 'fr', 'de-DE', 'undefined', 'null']) {
      expect(resolveAdminLocale(other), other).toBe('de');
    }
  });

  it('runs right-to-left only in Arabic', () => {
    expect(adminDir('de')).toBe('ltr');
    expect(adminDir('ar')).toBe('rtl');
  });
});

describe('the admin scope catalog', () => {
  it('holds only the admin namespaces, in the admin language', () => {
    for (const locale of ADMIN_LOCALES) {
      const picked = pickAdminMessages(catalogs[locale]);
      expect(Object.keys(picked).sort()).toEqual([...ADMIN_NAMESPACES].sort());
      expect(picked.admin).toBe(catalogs[locale].admin);
      expect(picked.common).toBe(catalogs[locale].common);
      expect(picked.errors).toBe(catalogs[locale].errors);
    }
  });

  it('renders a key outside the scope as the key — never in English', () => {
    const t = createTranslator('de', pickAdminMessages(catalogs.de) as Messages);
    expect(t('admin.title')).toBe('Administration');
    expect(t('shell.nav.admin')).toBe('shell.nav.admin');
    expect(t('shell.nav.admin')).not.toBe(catalogs.en.shell.nav.admin);
  });

  it('is all the admin page uses (its code and the shared parts it renders)', () => {
    const files = [
      ...tsFiles(path.join(webSrc, 'features/admin')),
      ...[
        'components/shell/Page.tsx',
        'components/tasks/TaskStatusPill.tsx',
        'components/ui/Badge.tsx',
        'components/ui/Banner.tsx',
        'components/ui/Button.tsx',
        'components/ui/Card.tsx',
        'components/ui/EmptyState.tsx',
        'components/ui/Money.tsx',
        'components/ui/RelativeTime.tsx',
        'components/ui/SegmentedControl.tsx',
        'components/ui/Skeleton.tsx',
        'components/ui/Switch.tsx',
        'lib/api/errors.ts',
      ].map((f) => path.join(webSrc, f)),
    ];
    const namespaces = Object.keys(catalogs.en);
    const keyLike = new RegExp(`['\`](${namespaces.join('|')})\\.[A-Za-z_$]`, 'g');
    const outside: string[] = [];
    for (const file of files) {
      // Code only: comments may quote audit actions ('auth.login') and other keys.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of source.matchAll(keyLike)) {
        if (!(ADMIN_NAMESPACES as readonly string[]).includes(m[1]!)) {
          outside.push(`${path.relative(webSrc, file)}: ${m[0]}`);
        }
      }
    }
    expect(outside).toEqual([]);
    // Tool names come from the shared map; it names tools from common only.
    for (const id of ToolId.options)
      expect(toolLabelKey(id)?.startsWith('common.tools.')).toBe(true);
  });
});

describe('admin copy in German and Arabic', () => {
  /** Strings that are the same in every language: names, symbols, the em dash. */
  const SAME_EVERYWHERE = new Set(['JARVIS', 'Admin', 'Status', 'System', 'Webhook', '—']);

  it('translates every admin string (no English left in de or ar)', () => {
    const en = new Map(leaves(catalogs.en.admin));
    for (const locale of ADMIN_LOCALES) {
      const same = leaves(catalogs[locale].admin).filter(
        ([key, value]) => value === en.get(key) && !SAME_EVERYWHERE.has(value),
      );
      expect(same.map(([k, v]) => `${locale}:${k} = ${v}`)).toEqual([]);
    }
  });

  it('writes Arabic without Latin words except names and technical symbols', () => {
    const allowed = new Set(['JARVIS', 'API', 'p50', 'p95']);
    const ar = [
      ...leaves(catalogs.ar.admin),
      ...leaves(catalogs.ar.common.taskStatus),
      ...leaves(catalogs.ar.common.tools),
    ];
    const latin = ar.flatMap(([key, value]) =>
      // Placeholders and ICU keywords are not text.
      [
        ...value
          .replace(/\{[^{}]*,\s*plural,|\{\w+\}|\b(zero|one|two|few|many|other)\b/g, '')
          .matchAll(/[A-Za-z][A-Za-z0-9]*/g),
      ]
        .map((m) => m[0])
        .filter((word) => !allowed.has(word))
        .map((word) => `${key}: ${word}`),
    );
    expect(latin).toEqual([]);
  });

  it('keeps each queue count with its word (no-break spaces)', () => {
    for (const locale of ADMIN_LOCALES) {
      expect(catalogs[locale].admin.health.queueValue).toMatch(
        /^\{ready\} \S+ · \{scheduled\} \S+$/,
      );
    }
  });
});

describe('server values on the admin page', () => {
  const apiFiles = tsFiles(apiSrc);

  /** Every 'domain.verb' literal in an `action:` of the API (audit actions, incl. ternaries). */
  function auditActions(): string[] {
    const found = new Set<string>();
    for (const file of apiFiles) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/\baction:\s*([^,\n}]+)/g)) {
        for (const lit of m[1]!.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) found.add(lit[1]!);
      }
    }
    return [...found].sort();
  }

  function auditTargets(): string[] {
    const found = new Set<string>();
    for (const file of apiFiles) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\btargetType:\s*'([a-z_]+)'/g)) {
        found.add(m[1]!);
      }
    }
    return [...found].sort();
  }

  it('words every audit action the API records', () => {
    const actions = auditActions();
    expect(actions.length).toBeGreaterThan(50);
    expect(actions.filter((a) => auditEventKey(a) === null)).toEqual([]);
  });

  it('names every audit object type the API records', () => {
    const targets = auditTargets();
    expect(targets.length).toBeGreaterThan(15);
    expect(targets.filter((t) => auditTargetKey(t) === null)).toEqual([]);
  });

  it('names every tool, role, account status and actor in German and Arabic', () => {
    for (const locale of ADMIN_LOCALES) {
      const m = catalogs[locale];
      for (const id of ToolId.options) {
        const key = toolLabelKey(id);
        expect(key && lookup(m, key), `${locale}:${id}`).toBeTruthy();
      }
      for (const role of ['owner', 'member', 'platform_admin'] as const) {
        expect(m.admin.roles[role]).not.toBe(role);
      }
      for (const status of ['active', 'disabled', 'deleted'] as const) {
        expect(m.admin.users.statuses[status]).not.toBe(status);
      }
      for (const actor of ['user', 'system', 'agent', 'admin'] as const) {
        expect(m.admin.audit.actors[actor]).not.toBe(actor);
      }
    }
  });
});
