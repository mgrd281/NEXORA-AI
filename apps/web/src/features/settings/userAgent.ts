/**
 * A short, human summary of a session's user agent ("Chrome", "macOS"). Only well-known
 * browsers and systems are named; anything else stays unknown rather than guessed.
 */
export interface UserAgentSummary {
  browser: string | null;
  os: string | null;
  kind: 'desktop' | 'phone' | 'tablet' | 'unknown';
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  // Order matters: Edge, Opera and Samsung Internet also contain "Chrome" and "Safari".
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\/|\bChromium\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\biPad\b/, 'iPadOS'],
  [/\biPhone\b|\biPod\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

export function summarizeUserAgent(userAgent: string | null | undefined): UserAgentSummary {
  const ua = userAgent?.trim() ?? '';
  if (!ua) return { browser: null, os: null, kind: 'unknown' };
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null;
  const kind =
    os === 'iPadOS' || (os === 'Android' && !/\bMobile\b/.test(ua))
      ? 'tablet'
      : os === 'iOS' || os === 'Android'
        ? 'phone'
        : os
          ? 'desktop'
          : 'unknown';
  return { browser, os, kind };
}
