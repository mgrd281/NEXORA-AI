/**
 * Validates a post-sign-in destination: same-origin absolute paths only (no protocol-relative
 * "//host", no backslash tricks, no /sign-in loop). Anything else falls back to Home.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'http://jarvis.invalid');
    if (url.origin !== 'http://jarvis.invalid') return '/';
    if (url.pathname === '/sign-in' || url.pathname.startsWith('/sign-in/')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
