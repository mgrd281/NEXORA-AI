import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';

/**
 * IBM Plex, self-hosted by next/font at build time (no runtime requests to Google). The CSS
 * variables are mapped into the token variables --font-sans / --font-sans-arabic / --font-mono
 * in globals.css. Arabic and Mono load on first use (unicode-range / mono text), not upfront.
 */
export const plexSans = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-sans',
});

export const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600'],
  display: 'swap',
  preload: false,
  variable: '--font-plex-arabic',
});

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  preload: false,
  variable: '--font-plex-mono',
});

export const fontVariables = `${plexSans.variable} ${plexArabic.variable} ${plexMono.variable}`;
