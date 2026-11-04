/**
 * Phase C skill availability (docs/architecture/phase-c.md §3): a skill is
 * "built" only once one of its tools is registered on this server; any-of
 * connection options (SMTP, or Google / Microsoft with mail access); "not
 * configured on this server" when no provider it could use has a client; and
 * BROWSER_UNAVAILABLE without a browser worker. Every ToolId has one owner.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  ToolId,
  type ConnectionCapability,
  type ConnectionProvider,
} from '@jarvis/contracts';
import type { ConnectionRow } from '../../../src/db/types';
import type { AgentContext } from '../../../src/modules/agent/context';
import { getSkill, skillOfTool } from '../../../src/modules/agent/skills/registry';
import {
  effectiveStatus,
  skillEntry,
  type SkillEnv,
} from '../../../src/modules/agent/skills/service';
import { TOOLS } from '../../../src/modules/agent/tools/registry';

const ALL_TOOLS = new Set(ToolId.options);

function agent(
  connections: {
    provider: ConnectionProvider;
    capabilities?: ConnectionCapability[];
    status?: 'active' | 'expired';
  }[],
): AgentContext {
  const active = new Map<ConnectionProvider, ConnectionRow>();
  for (const c of connections)
    if ((c.status ?? 'active') === 'active') active.set(c.provider, {} as ConnectionRow);
  return {
    account: {
      userId: 'u',
      tenantId: 't',
      email: 'me@example.com',
      displayName: 'Me',
      locale: 'en',
      timeZone: 'UTC',
    },
    preferences: structuredClone(DEFAULT_PREFERENCES),
    connections: active,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    route: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
    connectionStates: connections.map((c, i) => ({
      connectionId: `00000000-0000-4000-8000-00000000000${i}`,
      provider: c.provider,
      status: c.status ?? 'active',
      capabilities: c.capabilities ?? [],
      accountIdentifier: null,
    })),
    purchases: { limitMicro: 0, spentMicro: 0 },
  };
}

const env = (over: Partial<SkillEnv> = {}): SkillEnv => ({
  storageConfigured: true,
  providersConfigured: new Set(['web', 'smtp', 'google', 'microsoft']),
  browserAvailable: true,
  registered: ALL_TOOLS,
  ...over,
});

describe('Phase C skills', () => {
  it('every Phase C tool has exactly one owning skill', () => {
    expect(skillOfTool('email.search').id).toBe('email-management');
    expect(skillOfTool('calendar.free_busy').id).toBe('calendar-management');
    expect(skillOfTool('booking.book').id).toBe('appointment-booking');
    expect(skillOfTool('browser.fill').id).toBe('appointment-booking');
    expect(skillOfTool('browser.read').id).toBe('web-research');
    expect(skillOfTool('shop.checkout').id).toBe('shopping-assistant');
  });

  it('a skill is built only once one of its tools is registered (status never ahead of the code)', () => {
    const calendar = getSkill('calendar-management');
    expect(effectiveStatus(calendar, new Set())).toBe('planned');
    expect(effectiveStatus(calendar, new Set(['calendar.list']))).toBe('implemented');
    // On this tree: exactly what the registry has.
    const anyRegistered = calendar.tools.some((t) => TOOLS.has(t));
    expect(effectiveStatus(calendar)).toBe(anyRegistered ? 'implemented' : 'planned');
    const planned = skillEntry(calendar, agent([]), env({ registered: new Set() }));
    expect(planned).toMatchObject({
      status: 'planned',
      unavailableReason: 'PLANNED',
      canToggle: false,
    });
    expect(planned.tools).toEqual([]);
    expect(planned.plannedTools).toEqual(expect.arrayContaining(['calendar.create_event']));
  });

  it('email works with SMTP or with a Google / Microsoft account that grants mail access', () => {
    const email = getSkill('email-management');
    expect(skillEntry(email, agent([{ provider: 'smtp' }]), env()).available).toBe(true);
    expect(
      skillEntry(email, agent([{ provider: 'google', capabilities: ['mail.read'] }]), env())
        .available,
    ).toBe(true);
    const calendarOnly = skillEntry(
      email,
      agent([{ provider: 'google', capabilities: ['calendar.read'] }]),
      env(),
    );
    expect(calendarOnly).toMatchObject({
      status: 'needs_connection',
      unavailableReason: 'CONNECTION_REQUIRED',
    });
    expect(calendarOnly.connectionOptions).toEqual(
      expect.arrayContaining([
        { provider: 'smtp' },
        { provider: 'microsoft', capability: 'mail.send' },
      ]),
    );
  });

  it('an expired calendar connection does not count', () => {
    const r = skillEntry(
      getSkill('calendar-management'),
      agent([{ provider: 'google', capabilities: ['calendar.read'], status: 'expired' }]),
      env(),
    );
    expect(r.unavailableReason).toBe('CONNECTION_REQUIRED');
  });

  it('says so honestly when no provider it could use is configured on this server', () => {
    const r = skillEntry(
      getSkill('calendar-management'),
      agent([]),
      env({ providersConfigured: new Set(['web', 'smtp']) }),
    );
    expect(r).toMatchObject({ available: false, unavailableReason: 'PROVIDER_NOT_CONFIGURED' });
    // Email still works through SMTP, so it only needs a connection.
    const email = skillEntry(
      getSkill('email-management'),
      agent([]),
      env({ providersConfigured: new Set(['web', 'smtp']) }),
    );
    expect(email.unavailableReason).toBe('CONNECTION_REQUIRED');
  });

  it('booking and shopping need the browser agent', () => {
    for (const id of ['appointment-booking', 'shopping-assistant'] as const) {
      expect(skillEntry(getSkill(id), agent([{ provider: 'web' }]), env()).available, id).toBe(
        true,
      );
      expect(
        skillEntry(getSkill(id), agent([{ provider: 'web' }]), env({ browserAvailable: false }))
          .unavailableReason,
        id,
      ).toBe('BROWSER_UNAVAILABLE');
      expect(skillEntry(getSkill(id), agent([]), env()).unavailableReason, id).toBe(
        'CONNECTION_REQUIRED',
      );
    }
  });
});
