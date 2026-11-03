/**
 * IANA time zones for the picker: every zone the browser knows (Intl.supportedValuesOf), plus
 * UTC (some engines omit it) and the account's current zone (so a valid alias is never lost),
 * each labelled with its current UTC offset in the interface language.
 */
export interface TimeZoneOption {
  value: string;
  label: string;
}

export function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** "GMT+1", "GMT−3:30", "GMT" for `zone` right now, in `intlLocale`. */
export function utcOffsetLabel(zone: string, intlLocale: string, at = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat(intlLocale, {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}

/** "America/Argentina/Buenos_Aires" → "America / Argentina / Buenos Aires". */
export function zoneDisplayName(zone: string): string {
  return zone.split('/').join(' / ').replaceAll('_', ' ');
}

export function timeZoneOptions(
  current: string,
  intlLocale: string,
  zones: readonly string[] = supportedTimeZones(),
  at = new Date(),
): TimeZoneOption[] {
  const all = new Set(zones);
  all.add('UTC');
  if (current) all.add(current);
  return [...all]
    .sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)))
    .map((value) => {
      const offset = utcOffsetLabel(value, intlLocale, at);
      const name = zoneDisplayName(value);
      return { value, label: offset && value !== 'UTC' ? `${name} (${offset})` : name };
    });
}

/** The browser's own time zone, if it reports one. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
