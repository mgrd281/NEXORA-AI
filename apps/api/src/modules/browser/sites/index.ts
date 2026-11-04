/**
 * The registry of supported sites (recipes) — docs/adr/0017. A site is
 * supported only through a reviewed recipe registered here; "enabled" means
 * registered ∧ allowed by BROWSER_SITES (when set) ∧ its origin configured on
 * this server (fixture recipes: BROWSER_FIXTURE_ORIGIN, development/test only).
 * Imported by the agent worker's tools (static metadata) and the browser worker
 * (operations); it loads no browser.
 */
import type { Recipe, RecipeOperation, SiteConfig } from '../types';
import { fixtureBookingRecipe } from './fixture-booking';
import { fixtureOutletRecipe, fixtureShopRecipe } from './fixture-shop';
import { schemaOrgRecipe } from './schema-org';

const SITE_RECIPES: readonly Recipe[] = [
  fixtureShopRecipe,
  fixtureOutletRecipe,
  fixtureBookingRecipe,
];

export const RECIPES: readonly Recipe[] = [...SITE_RECIPES, schemaOrgRecipe(() => SITE_RECIPES)];

{
  const seen = new Set<string>();
  for (const r of RECIPES) {
    if (seen.has(r.id)) throw new Error(`recipe ${r.id} is registered twice`);
    seen.add(r.id);
  }
}

const BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

/** A registered recipe (enabled or not). */
export function getRecipe(id: string): Recipe | undefined {
  return BY_ID.get(id);
}

/** Its origins on this server when the recipe is enabled here; null otherwise. */
export function enabledOrigins(config: SiteConfig, id: string): string[] | null {
  const r = BY_ID.get(id);
  if (!r) return null;
  if (config.browserSites !== null && !config.browserSites.has(id)) return null;
  if (r.fixture && (config.isProduction || !config.BROWSER_FIXTURE_ORIGIN)) return null;
  const origins = r.origins(config);
  return origins.length > 0 ? origins : null;
}

export function isEnabled(config: SiteConfig, id: string): boolean {
  return enabledOrigins(config, id) !== null;
}

export function enabledRecipes(config: SiteConfig): Recipe[] {
  return RECIPES.filter((r) => isEnabled(config, r.id));
}

/** Enabled shop recipes (shop.search asks each of them). */
export function enabledShops(config: SiteConfig): Recipe[] {
  return enabledRecipes(config).filter((r) => r.shop);
}

export function operationOf(
  recipe: Recipe,
  name: string,
): RecipeOperation<never, unknown> | undefined {
  return Object.hasOwn(recipe.operations, name) ? recipe.operations[name] : undefined;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFKC').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');

/**
 * Recipes the text names (by name or alias, as whole words), in the order they
 * appear. Registered recipes only — whether one is enabled here is checked when
 * a step runs (SITE_UNSUPPORTED).
 */
export function recipesNamedIn(text: string): Recipe[] {
  const t = ` ${normalize(text).replace(/[.,;:!?()"“”«»„]/g, ' ')} `;
  const hits: { r: Recipe; at: number }[] = [];
  for (const r of SITE_RECIPES) {
    for (const name of [r.name.toLowerCase(), ...r.aliases]) {
      const at = t.indexOf(` ${normalize(name)} `);
      if (at >= 0) {
        hits.push({ r, at });
        break;
      }
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.r);
}

export { fixtureBookingRecipe, fixtureOutletRecipe, fixtureShopRecipe };
