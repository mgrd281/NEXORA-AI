/**
 * A translation of a source catalog: same keys at every level, every leaf a string.
 * German and Arabic catalogs are typed against the English one, so TypeScript reports any
 * missing or extra key; test/i18n-catalogs.test.ts checks the same thing at runtime.
 */
export type Catalog<T> = { readonly [K in keyof T]: T[K] extends string ? string : Catalog<T[K]> };

/** Dotted paths to every leaf of a catalog, e.g. 'shell.nav.home'. */
export type LeafPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageParams = Record<string, string | number | null | undefined>;
