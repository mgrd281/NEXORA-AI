/**
 * The generic schema.org reader (docs/adr/0017): reads one page of ANY enabled
 * supported site — its readable text and what it states in schema.org JSON-LD
 * (Product / Offer / Reservation / Order) plus a linked ICS confirmation. It
 * never clicks or submits anything. Its origins are exactly the origins of the
 * other enabled recipes, so it cannot open a site no recipe supports.
 */
import type { Recipe, RecipeOperation, SiteConfig } from '../types';
import { readOperation } from './common';

export function schemaOrgRecipe(others: () => readonly Recipe[]): Recipe {
  return {
    id: 'schema-org',
    version: '1.0.0',
    name: 'Supported sites',
    aliases: [],
    fixture: false,
    hostLabel: 'supported sites',
    origins: (config: SiteConfig) => [
      ...new Set(
        others()
          .filter((r) => config.browserSites === null || config.browserSites.has(r.id))
          .flatMap((r) => r.origins(config)),
      ),
    ],
    operations: { read: readOperation as RecipeOperation<never, unknown> },
  };
}
