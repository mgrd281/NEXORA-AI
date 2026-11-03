import type { Locale } from '@jarvis/contracts';
import type { Messages } from '../catalog';
import ar from './ar';
import de from './de';
import en from './en';

/**
 * All catalogs. Import this only from server code (layouts, pages, metadata): the root layout
 * passes just the active locale's catalog to the client, so browsers never download the others.
 */
export const catalogs: Record<Locale, Messages> = { en, de, ar };
