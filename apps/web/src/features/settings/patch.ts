import type { Me, UpdateMeRequest } from '@jarvis/contracts';

/** The profile as it will be once `patch` is saved (preferences merge one level deep). */
export function applyPatch(me: Me, patch: UpdateMeRequest): Me {
  const { preferences, ...rest } = patch;
  const next: Me = { ...me, ...stripUndefined(rest) };
  if (preferences) {
    const merged = { ...me.preferences } as Record<string, object>;
    for (const [group, values] of Object.entries(preferences)) {
      if (values) merged[group] = { ...merged[group], ...stripUndefined(values) };
    }
    next.preferences = merged as Me['preferences'];
  }
  return next;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
