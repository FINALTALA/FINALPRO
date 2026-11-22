import { ProductAudience } from '../../generated/prisma/client';

// Sprint 27: the store page's product filtering and facets, as pure
// functions over an already-loaded catalogue (one store's ACTIVE offers -
// small by nature, and loaded whole by the sections endpoint too).
//
// Semantics, used identically by filtering and facets:
//  - values inside one dimension are OR (color=BLACK,BEIGE = either);
//  - dimensions are AND;
//  - colour and size are judged on ONE available combination together:
//    color=BLACK&size=M needs an in-stock BLACK/M, not a black item in
//    some size plus an M item in some colour;
//  - only combinations with live stock > 0 ever count, so a sold-out
//    colour/size never filters anything in, nor appears in a facet;
//  - any taxonomy dimension (audience/category/season/color/size)
//    excludes unclassified legacy offers; with none set they are listed.
//  - each facet is computed over every OTHER active filter (so choosing
//    BLACK still shows the other colours you could add, with counts).

export interface CatalogCombination {
  variantId: string;
  colorCode: string | null;
  /** Product colours: the version's own product colour (null: no colour). */
  offerColorId?: string | null;
  sizeCode: string | null;
  available: number;
}

export interface CatalogOffer {
  id: string;
  createdAt: Date;
  classified: boolean;
  audiences: ProductAudience[];
  categories: string[];
  season: string | null;
  minPrice: number | null;
  combinations: CatalogCombination[];
}

export interface CatalogFilters {
  audiences: Set<string>;
  categories: Set<string>;
  seasons: Set<string>;
  colors: Set<string>;
  sizes: Set<string>;
  minPrice: number | null;
  maxPrice: number | null;
}

type Dimension =
  'audiences' | 'categories' | 'seasons' | 'colors' | 'sizes' | 'price';

const TAXONOMY_DIMENSIONS: Dimension[] = [
  'audiences',
  'categories',
  'seasons',
  'colors',
  'sizes',
];

function hasAny(values: readonly string[], wanted: Set<string>): boolean {
  return values.some((v) => wanted.has(v));
}

/** In-stock combinations that satisfy the colour/size filters. */
function matchingCombinations(
  o: CatalogOffer,
  f: CatalogFilters,
  ignore?: Dimension,
): CatalogCombination[] {
  const colors = ignore === 'colors' ? new Set<string>() : f.colors;
  const sizes = ignore === 'sizes' ? new Set<string>() : f.sizes;
  return o.combinations.filter(
    (c) =>
      c.available > 0 &&
      (colors.size === 0 ||
        (c.colorCode !== null && colors.has(c.colorCode))) &&
      (sizes.size === 0 || (c.sizeCode !== null && sizes.has(c.sizeCode))),
  );
}

export function matchesFilters(
  o: CatalogOffer,
  f: CatalogFilters,
  ignore?: Dimension,
): boolean {
  const active = (d: Dimension) =>
    d !== ignore && d !== 'price' && (f[d] as Set<string>).size > 0;
  if (TAXONOMY_DIMENSIONS.some(active) && !o.classified) return false;
  if (active('audiences') && !hasAny(o.audiences, f.audiences)) return false;
  if (active('categories') && !hasAny(o.categories, f.categories)) return false;
  if (active('seasons') && (o.season === null || !f.seasons.has(o.season))) {
    return false;
  }
  if (
    (active('colors') || active('sizes')) &&
    matchingCombinations(o, f, ignore).length === 0
  ) {
    return false;
  }
  if (ignore !== 'price') {
    if (
      f.minPrice !== null &&
      (o.minPrice === null || o.minPrice < f.minPrice)
    ) {
      return false;
    }
    if (
      f.maxPrice !== null &&
      (o.minPrice === null || o.minPrice > f.maxPrice)
    ) {
      return false;
    }
  }
  return true;
}

export interface Facets {
  audiences: { code: string; count: number }[];
  categories: { code: string; count: number }[];
  seasons: { code: string; count: number }[];
  colors: { code: string; count: number }[];
  sizes: { code: string; count: number }[];
  price: { min: string | null; max: string | null };
}

function counted(
  counts: Map<string, number>,
  order: string[],
): { code: string; count: number }[] {
  return order
    .filter((code) => (counts.get(code) ?? 0) > 0)
    .map((code) => ({ code, count: counts.get(code)! }));
}

function bump(counts: Map<string, number>, codes: Iterable<string>) {
  for (const c of new Set(codes)) counts.set(c, (counts.get(c) ?? 0) + 1);
}

export function computeFacets(
  offers: CatalogOffer[],
  f: CatalogFilters,
  order: {
    audiences: string[];
    categories: string[];
    seasons: string[];
    colors: string[];
    sizes: string[];
    /** category -> the audiences it belongs to */
    categoryAudiences: Map<string, Set<string>>;
  },
): Facets {
  const over = (d: Dimension) =>
    offers.filter((o) => o.classified && matchesFilters(o, f, d));

  const audiences = new Map<string, number>();
  for (const o of over('audiences')) bump(audiences, o.audiences);

  // Only categories that belong to a chosen audience, when one is chosen
  // (a WOMEN+KIDS offer tagged GIRLS_DRESSES does not offer "girls'
  // dresses" as a WOMEN filter).
  const categories = new Map<string, number>();
  for (const o of over('categories')) {
    bump(
      categories,
      o.categories.filter(
        (c) =>
          f.audiences.size === 0 ||
          [...(order.categoryAudiences.get(c) ?? [])].some((a) =>
            f.audiences.has(a),
          ),
      ),
    );
  }

  const seasons = new Map<string, number>();
  for (const o of over('seasons')) if (o.season) bump(seasons, [o.season]);

  const colors = new Map<string, number>();
  for (const o of over('colors')) {
    bump(
      colors,
      matchingCombinations(o, f, 'colors')
        .map((c) => c.colorCode)
        .filter((c): c is string => c !== null),
    );
  }

  const sizes = new Map<string, number>();
  for (const o of over('sizes')) {
    bump(
      sizes,
      matchingCombinations(o, f, 'sizes')
        .map((c) => c.sizeCode)
        .filter((c): c is string => c !== null),
    );
  }

  const prices = offers
    .filter((o) => matchesFilters(o, f, 'price'))
    .map((o) => o.minPrice)
    .filter((p): p is number => p !== null);

  return {
    audiences: counted(audiences, order.audiences),
    categories: counted(categories, order.categories),
    seasons: counted(seasons, order.seasons),
    colors: counted(colors, order.colors),
    sizes: counted(sizes, order.sizes),
    price: {
      min: prices.length ? Math.min(...prices).toFixed(2) : null,
      max: prices.length ? Math.max(...prices).toFixed(2) : null,
    },
  };
}
