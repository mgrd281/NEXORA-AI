import type en from './messages/en';
import type { Catalog, LeafPaths } from './types';

/** The shape every locale's catalog must have (derived from the English source). */
export type Messages = Catalog<typeof en>;
export type Namespace = keyof Messages;
/** Every translatable key, e.g. 'shell.nav.home' or 'errors.codes.NOT_FOUND'. */
export type MessageKey = LeafPaths<typeof en>;
